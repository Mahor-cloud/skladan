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
		const safeH = Math.max(1, Math.min(90 * 24, Math.floor(hours)))
		const since = new Date(Date.now() - safeH * 3600 * 1000)
		const rows = await this.snapshotModel
			.find({ createdAt: { $gte: since } })
			.sort({ createdAt: 1 })
			.setOptions({ skipTenantScope: true } as any)
			.exec()

		const TARGET_POINTS = 1500
		if (rows.length <= TARGET_POINTS) return rows as MetricSnapshot[]

		const stride = Math.ceil(rows.length / TARGET_POINTS)
		const sampled: MetricSnapshot[] = []
		for (let i = 0; i < rows.length; i += stride) {
			sampled.push(rows[i] as MetricSnapshot)
		}

		const lastRow = rows[rows.length - 1] as MetricSnapshot
		if (sampled[sampled.length - 1] !== lastRow) sampled.push(lastRow)
		return sampled
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
