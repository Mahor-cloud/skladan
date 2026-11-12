/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { ModelType } from '@typegoose/typegoose/lib/types'
import mongoose from 'mongoose'
import { InjectModel } from 'nestjs-typegoose'
import { RealtimeService } from '../change-history/realtime.service'
import { ActiveUsersService } from './active-users.service'
import { MetricsRegistryService } from './metrics-registry.service'
import { MetricSnapshot } from './snapshot.model'

// Metrics the Observability page (skladanclient Observability.vue) reads from history points:
// exact key or its labelled form `name{...}`. Add a name here when the page charts a new metric.
const HISTORY_METRICS = new Set([
	'process_resident_memory_bytes',
	'nodejs_heap_size_used_bytes',
	'nodejs_heap_size_total_bytes',
	'nodejs_external_memory_bytes',
	'process_cpu_user_seconds_total',
	'process_cpu_system_seconds_total',
	'process_open_fds',
	'nodejs_active_handles_total',
	'nodejs_active_requests_total',
	'skladan_event_loop_lag_ms',
	'skladan_event_loop_lag_ms_peak_5m',
	'skladan_sse_connections_active',
	'skladan_active_users_15m',
	'skladan_mongo_pool_used',
	'skladan_mongo_pool_max',
])

export function historyPayload(payload: Record<string, number>): Record<string, number> {
	const out: Record<string, number> = {}
	for (const k of Object.keys(payload || {})) {
		const brace = k.indexOf('{')
		// `name{labels}_peak_5m` (consumePeaks) is skipped: the page sums `name{...}` by prefix
		// and counted those peaks on top of the current values.
		const name = brace < 0 ? k : k.endsWith('}') ? k.slice(0, brace) : null
		if (name && HISTORY_METRICS.has(name)) out[k] = payload[k]
	}
	return out
}

// Every stride-th row plus the last one, at most ~target points (same sampling as before).
export function samplePoints<T>(rows: T[], target: number): T[] {
	const stride = Math.max(1, Math.ceil(rows.length / target))
	const picked = rows.filter((_, i) => i % stride === 0)
	const last = rows[rows.length - 1]
	if (last !== undefined && picked[picked.length - 1] !== last) picked.push(last)
	return picked
}

@Injectable()
export class SnapshotService {
	private readonly logger = new Logger(SnapshotService.name)
	private snapshotInProgress = false

	constructor(
		@InjectModel(MetricSnapshot)
		private readonly snapshotModel: ModelType<MetricSnapshot>,
		private readonly metrics: MetricsRegistryService,
		private readonly activeUsers: ActiveUsersService,
		private readonly realtime: RealtimeService
	) {}

	@Cron(CronExpression.EVERY_5_MINUTES)
	async takeSnapshot() {
		if (this.snapshotInProgress) {
			this.logger.warn('Snapshot cron fired while previous run still in progress — skipping')
			return
		}
		this.snapshotInProgress = true
		try {
			await this.refreshAll()
			const base = await this.metrics.toFlatJson()
			const peaks = this.metrics.consumePeaks()
			const payload = { ...base, ...peaks }
			await this.snapshotModel.create({ createdAt: new Date(), payload } as any)
		} catch (e) {
			this.logger.error('Snapshot failed', e as any)
		} finally {
			this.snapshotInProgress = false
		}
	}

	async refreshAll() {
		await Promise.all([
			this.refreshEventLoopLag(),
			this.refreshMongoPool(),
			this.refreshActiveUsers(),
			this.refreshSseConnections(),
		])
	}

	private mongoServerStatusWarned = false

	async refreshEventLoopLag() {
		const lag = await new Promise<number>((resolve) => {
			const start = process.hrtime.bigint()
			setImmediate(() => {
				const ns = Number(process.hrtime.bigint() - start)
				resolve(ns / 1_000_000)
			})
		})
		this.metrics.eventLoopLagMs.set(lag)
		this.metrics.bumpPeak('skladan_event_loop_lag_ms', lag)
	}

	private mongoPoolStructureWarned = false

	async refreshMongoPool() {
		try {

			let clientMax = 0
			for (const conn of mongoose.connections) {
				const client = (conn as any).client
				const cfg = (client?.s?.options || conn.config || {}) as any
				const cfgMax = Number(cfg.maxPoolSize || cfg.poolSize || 0)
				if (cfgMax) clientMax += cfgMax
			}

			let used = 0
			let serverMax = 0
			let viaServerStatus = false
			const connectedConn = mongoose.connections.find((c) => c.readyState === 1)
			if (connectedConn) {
				try {
					const db = (connectedConn as any).db
					if (db && typeof db.command === 'function') {
						const status = await db.command({ serverStatus: 1 })
						const conns = status?.connections
						if (conns && typeof conns.current === 'number') {
							used = Number(conns.current) || 0
							if (typeof conns.available === 'number') {
								serverMax = used + Number(conns.available)
							}
							viaServerStatus = true
						}
					}
				} catch (e) {
					if (!this.mongoServerStatusWarned) {
						this.mongoServerStatusWarned = true
						this.logger.warn(
							`Mongo serverStatus unavailable on connected client (${(e as any)?.message}); ` +
								'falling back to driver internals. Grant clusterMonitor role for accurate metrics.'
						)
					}
				}
			}

			if (!viaServerStatus) {
				let topologyFound = false
				for (const conn of mongoose.connections) {
					const client = (conn as any).client
					const topology = client?.topology
					if (topology?.s?.servers) {
						topologyFound = true
						for (const server of topology.s.servers.values()) {
							const pool = (server as any).pool
							if (!pool) continue
							const total = Number(pool.totalConnectionCount || 0)
							const avail = Number(pool.availableConnectionCount || 0)
							used += Math.max(0, total - avail)
						}
					}
				}
				if (!topologyFound && !this.mongoPoolStructureWarned) {
					this.mongoPoolStructureWarned = true
					this.logger.warn(
						'Mongo pool introspection: serverStatus failed AND topology.s.servers not found. ' +
							'pool_used metric will report 0. Check driver version + permissions.'
					)
				}
			}

			const max = serverMax > 0 && clientMax > 0
				? Math.min(clientMax, serverMax)
				: clientMax || serverMax

			this.metrics.mongoPoolUsed.set(used)
			this.metrics.mongoPoolMax.set(max)
			this.metrics.bumpPeak('skladan_mongo_pool_used', used)
		} catch (e) {
			this.logger.warn(`Mongo pool metric failed: ${(e as any)?.message}`)
		}
	}

	refreshActiveUsers() {
		try {
			const byCompany = this.activeUsers.getCountByCompany()
			this.metrics.activeUsers15m.reset()
			for (const [company, count] of Object.entries(byCompany)) {
				this.metrics.activeUsers15m.labels(company).set(count)
				this.metrics.bumpPeak(`skladan_active_users_15m{company=${company}}`, count)
			}
		} catch (e) {
			this.logger.warn(`Active users metric failed: ${(e as any)?.message}`)
		}
	}

	refreshSseConnections() {
		try {
			const byCompany = this.realtime.getActiveByCompany()
			this.metrics.sseConnectionsActive.reset()
			for (const [company, count] of Object.entries(byCompany)) {
				this.metrics.sseConnectionsActive.labels(company).set(count)
				this.metrics.bumpPeak(`skladan_sse_connections_active{company=${company}}`, count)
			}
		} catch (e) {
			this.logger.warn(`SSE metric failed: ${(e as any)?.message}`)
		}
	}

	async getHistory(hours: number = 24): Promise<MetricSnapshot[]> {
		const safeH = Math.max(1, Math.min(14 * 24, Math.floor(hours)))
		const since = new Date(Date.now() - safeH * 3600 * 1000)
		// Pass 1: ids only. A snapshot is ~32 KB; loading every one of them (4000+ for 14 days)
		// made a 71 MB response and could run the backend out of memory.
		const ids = await this.snapshotModel
			.find({ createdAt: { $gte: since } }, { _id: 1 })
			.sort({ createdAt: 1 })
			.setOptions({ skipTenantScope: true } as any)
			.lean()
			.exec()

		const picked = samplePoints(ids, 1500)

		// Pass 2: the picked points one by one, unsorted (a sort here made mongod buffer whole
		// documents); order comes from pass 1. Only the first point keeps every key — the page
		// reads per-route request counters from it.
		// shortcut: if TTL deletes that first point between the passes, this response has no full
		// first point ("За период" shows totals until the next 30 s refetch); fine for a rare race.
		const firstId = String(picked[0]?._id)
		const byId = new Map<string, MetricSnapshot>()
		const cursor = this.snapshotModel
			.find({ _id: { $in: picked.map((r) => r._id) } })
			.setOptions({ skipTenantScope: true } as any)
			.lean()
			.cursor()
		for await (const d of cursor) {
			const id = String(d._id)
			byId.set(id, { createdAt: d.createdAt, payload: id === firstId ? d.payload : historyPayload(d.payload) })
		}
		return picked.map((r) => byId.get(String(r._id))).filter(Boolean)
	}

	async getLatest(): Promise<{ createdAt: Date; payload: Record<string, number> }> {
		const latest = await this.snapshotModel
			.findOne()
			.sort({ createdAt: -1 })
			.setOptions({ skipTenantScope: true } as any)
			.exec()
		if (latest) return { createdAt: latest.createdAt, payload: latest.payload }
		await this.refreshAll()
		return {
			createdAt: new Date(),
			payload: await this.metrics.toFlatJson(),
		}
	}
}
