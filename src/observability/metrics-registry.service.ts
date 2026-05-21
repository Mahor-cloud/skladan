/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { Injectable, OnModuleInit } from '@nestjs/common'
import * as os from 'os'
import * as promClient from 'prom-client'

@Injectable()
export class MetricsRegistryService implements OnModuleInit {
	readonly registry: promClient.Registry

	readonly sseConnectionsActive: promClient.Gauge<'company'>
	readonly pushDispatchedTotal: promClient.Counter<'company' | 'result'>
	readonly mongoPoolUsed: promClient.Gauge<string>
	readonly mongoPoolMax: promClient.Gauge<string>
	readonly activeUsers15m: promClient.Gauge<'company'>
	readonly eventLoopLagMs: promClient.Gauge<string>
	readonly httpRequestDuration: promClient.Histogram<'method' | 'route' | 'status'>
	readonly httpRequestsTotal: promClient.Counter<'method' | 'route' | 'status'>

	private peaks = new Map<string, number>()

	constructor() {
		this.registry = new promClient.Registry()
		promClient.collectDefaultMetrics({ register: this.registry, prefix: '' })

		this.sseConnectionsActive = new promClient.Gauge({
			name: 'skladan_sse_connections_active',
			help: 'Active SSE subscribers, by company',
			labelNames: ['company'] as const,
			registers: [this.registry],
		})
		this.pushDispatchedTotal = new promClient.Counter({
			name: 'skladan_push_dispatched_total',
			help: 'Web push notifications sent, by company and result (success / gone-410 / error)',
			labelNames: ['company', 'result'] as const,
			registers: [this.registry],
		})
		this.mongoPoolUsed = new promClient.Gauge({
			name: 'skladan_mongo_pool_used',
			help: 'MongoDB connections currently checked out from the pool',
			registers: [this.registry],
		})
		this.mongoPoolMax = new promClient.Gauge({
			name: 'skladan_mongo_pool_max',
			help: 'MongoDB connection pool max size (configured)',
			registers: [this.registry],
		})
		this.activeUsers15m = new promClient.Gauge({
			name: 'skladan_active_users_15m',
			help: 'Unique users who made any authenticated request in the last 15 minutes, by company',
			labelNames: ['company'] as const,
			registers: [this.registry],
		})
		this.eventLoopLagMs = new promClient.Gauge({
			name: 'skladan_event_loop_lag_ms',
			help: 'Event loop lag in ms, sampled at snapshot time',
			registers: [this.registry],
		})

		const hostTotalMem = os.totalmem()
		const constrainedRaw = (process as any).constrainedMemory?.()
		const constrained =
			typeof constrainedRaw === 'number' &&
			constrainedRaw > 0 &&
			constrainedRaw <= hostTotalMem
				? constrainedRaw
				: 0
		const envBudget = Number(process.env.SKLADAN_RAM_BUDGET_MB || 0)
		let budgetBytes = 0
		if (envBudget > 0) budgetBytes = envBudget * 1024 * 1024
		else if (constrained > 0) budgetBytes = constrained
		else {
			const half = Math.floor(hostTotalMem / 2)
			const cap = 2 * 1024 * 1024 * 1024
			budgetBytes = Math.min(half, cap)
		}
		const hostInfo = new promClient.Gauge({
			name: 'skladan_host_info',
			help: 'Host environment info: RAM (bytes), CPU count, derived backend memory budget',
			labelNames: ['kind'] as const,
			registers: [this.registry],
		})
		hostInfo.labels('total_memory_bytes').set(hostTotalMem)
		hostInfo.labels('memory_budget_bytes').set(budgetBytes)
		hostInfo.labels('cpu_count').set(os.cpus().length)
		if (typeof constrained === 'number' && constrained > 0) {
			hostInfo.labels('constrained_memory_bytes').set(constrained)
		}

		this.httpRequestDuration = new promClient.Histogram({
			name: 'http_request_duration_seconds',
			help: 'HTTP request duration in seconds',
			labelNames: ['method', 'route', 'status'] as const,
			buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
			registers: [this.registry],
		})
		this.httpRequestsTotal = new promClient.Counter({
			name: 'http_requests_total',
			help: 'Total HTTP requests',
			labelNames: ['method', 'route', 'status'] as const,
			registers: [this.registry],
		})
	}

	onModuleInit() {

	}

	async serialize(): Promise<string> {
		return this.registry.metrics()
	}

	bumpPeak(key: string, value: number): void {
		const cur = this.peaks.get(key) || 0
		if (value > cur) this.peaks.set(key, value)
	}

	consumePeaks(): Record<string, number> {
		const drained = this.peaks
		this.peaks = new Map()
		const out: Record<string, number> = {}
		for (const [k, v] of drained) out[`${k}_peak_5m`] = v
		return out
	}

	async toFlatJson(): Promise<Record<string, number>> {
		const raw = await this.registry.getMetricsAsJSON()
		const out: Record<string, number> = {}
		for (const m of raw as any[]) {
			if (!m.values || m.values.length === 0) continue
			for (const v of m.values) {
				const labelKey =
					v.labels && Object.keys(v.labels).length
						? Object.entries(v.labels)
								.filter(([, val]) => val !== undefined && val !== '')
								.map(([k, val]) => `${k}=${String(val)}`)
								.join(',')
						: ''
				const key = labelKey ? `${m.metricName || m.name}{${labelKey}}` : (m.metricName || m.name)
				if (typeof v.value === 'number') out[key] = v.value
			}
		}
		return out
	}
}
