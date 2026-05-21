import { Controller, Get } from '@nestjs/common'
import mongoose from 'mongoose'
import { RealtimeService } from '../change-history/realtime.service'

@Controller('health')
export class HealthController {
	constructor(private readonly realtime: RealtimeService) {}

	@Get()
	async check() {
		const state = mongoose.connections.some((c) => c.readyState === 1)
			? 1
			: mongoose.connection.readyState
		const dbReady = state === 1
		const mem = process.memoryUsage()
		const lag = await this.measureEventLoopLag()
		const sse = this.realtime.getActiveCount()
		return {
			status: dbReady && lag < 500 ? 'ok' : 'degraded',
			db: dbReady ? 'connected' : 'down',
			db_state: state,
			uptime_s: Math.round(process.uptime()),
			memory: {
				rss_mb: Math.round(mem.rss / 1048576),
				heap_used_mb: Math.round(mem.heapUsed / 1048576),
				heap_total_mb: Math.round(mem.heapTotal / 1048576),
				external_mb: Math.round(mem.external / 1048576),
			},


			event_loop_lag_ms: Math.round(lag),

			sse_clients: sse,
			node_version: process.version,
			ts: Date.now(),
		}
	}


	private measureEventLoopLag(): Promise<number> {
		return new Promise((resolve) => {
			const start = process.hrtime.bigint()
			setImmediate(() => {
				const ns = Number(process.hrtime.bigint() - start)
				resolve(ns / 1_000_000)
			})
		})
	}
}
