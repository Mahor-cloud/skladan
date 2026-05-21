/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { Injectable } from '@nestjs/common'
import { ThrottlerGuard } from '@nestjs/throttler'

@Injectable()
export class IpThrottlerGuard extends ThrottlerGuard {
	protected async getTracker(req: Record<string, any>): Promise<string> {
		const xff = req?.headers?.['x-forwarded-for']
		if (xff) {
			const first = Array.isArray(xff)
				? xff[0]
				: String(xff).split(',')[0]
			if (first && first.trim()) return first.trim()
		}
		const xr = req?.headers?.['x-real-ip']
		if (xr) return Array.isArray(xr) ? String(xr[0]) : String(xr)
		return (
			req?.ip || req?.socket?.remoteAddress || req?.connection?.remoteAddress || 'unknown'
		)
	}
}
