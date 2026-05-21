import { Controller, Get, Header, Query } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import { SuperAdminAuth } from '../auth/decorators/super-admin-auth.decorator'
import { MetricsRegistryService } from './metrics-registry.service'
import { SnapshotService } from './snapshot.service'

@Controller('observability')
export class ObservabilityController {
	constructor(
		private readonly metrics: MetricsRegistryService,
		private readonly snapshots: SnapshotService
	) {}

	@SuperAdminAuth()
	@Throttle({ default: { limit: 30, ttl: 60_000 } })
	@Get('metrics')
	@Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
	async getPrometheusMetrics(): Promise<string> {
		await this.snapshots.refreshAll()
		return this.metrics.serialize()
	}

	@SuperAdminAuth()
	@Throttle({ default: { limit: 30, ttl: 60_000 } })
	@Get('snapshot')
	async getCurrentSnapshot() {
		return this.snapshots.getLatest()
	}


	@SuperAdminAuth()
	@Throttle({ default: { limit: 30, ttl: 60_000 } })
	@Get('live')
	async getLive() {
		await this.snapshots.refreshAll()
		return {
			createdAt: new Date(),
			payload: await this.metrics.toFlatJson(),
		}
	}

	@SuperAdminAuth()
	@Throttle({ default: { limit: 10, ttl: 60_000 } })
	@Get('history')
	async getHistory(@Query('hours') hours?: string) {

		const max = 90 * 24
		const h = hours ? Math.max(1, Math.min(max, Number(hours) || 24)) : 24
		const rows = await this.snapshots.getHistory(h)
		return {
			from: rows[0]?.createdAt || null,
			to: rows[rows.length - 1]?.createdAt || null,
			count: rows.length,
			points: rows.map((r) => ({ at: r.createdAt, payload: r.payload })),
		}
	}
}
