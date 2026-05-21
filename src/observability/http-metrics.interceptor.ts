/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common'
import { Observable, tap } from 'rxjs'
import { ActiveUsersService } from './active-users.service'
import { MetricsRegistryService } from './metrics-registry.service'

@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
	constructor(
		private readonly metrics: MetricsRegistryService,
		private readonly activeUsers: ActiveUsersService
	) {}

	intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
		if (context.getType() !== 'http') return next.handle()
		const req = context.switchToHttp().getRequest()
		const res = context.switchToHttp().getResponse()
		const url: string = String(req.originalUrl || req.url || '')

		if (url.startsWith('/api/observability/metrics')) return next.handle()

		const method = String(req.method || 'GET').toUpperCase()
		const start = process.hrtime.bigint()

		try {
			const u = req.user
			if (u?._id && u?.company) {
				this.activeUsers.track(String(u._id), String(u.company))
			}
		} catch {

		}

		return next.handle().pipe(
			tap({
				next: () => this.record(method, req, res, start),
				error: (err) => this.record(method, req, res, start, err),
			})
		)
	}

	private record(method: string, req: any, res: any, start: bigint, err?: any) {
		try {
			const ns = Number(process.hrtime.bigint() - start)
			const seconds = ns / 1_000_000_000
			const route = this.normalizeRoute(req)
			let statusNum: number = Number(res?.statusCode || 0)
			if (err) {
				const fromExc =
					(typeof err.getStatus === 'function' && err.getStatus()) ||
					err.status ||
					err.statusCode
				statusNum = fromExc && Number.isInteger(fromExc) ? fromExc : 500
			}
			const status = String(statusNum || 0)
			this.metrics.httpRequestDuration.labels(method, route, status).observe(seconds)
			this.metrics.httpRequestsTotal.labels(method, route, status).inc()
		} catch {

		}
	}

	private normalizeRoute(req: any): string {
		const pattern = req.route?.path
		if (typeof pattern === 'string' && pattern.length > 0) {
			return pattern.startsWith('/api') ? pattern : '/api' + pattern
		}
		const raw = String(req.originalUrl || req.url || '').split('?')[0]
		return raw
			.split('/')
			.map((seg) => {
				if (!seg) return seg
				if (/^[0-9a-f]{16,}$/i.test(seg)) return ':id'
				if (/^\d{6,}$/.test(seg)) return ':n'
				return seg
			})
			.join('/') || '/'
	}
}
