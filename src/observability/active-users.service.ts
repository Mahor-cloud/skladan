/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { Injectable } from '@nestjs/common'

@Injectable()
export class ActiveUsersService {
	private readonly windowMs = 15 * 60 * 1000
	private readonly map = new Map<string, Map<string, number>>()

	track(userId: string | null | undefined, companyId: string | null | undefined): void {
		if (!userId || !companyId) return
		let inner = this.map.get(companyId)
		if (!inner) {
			inner = new Map()
			this.map.set(companyId, inner)
		}
		inner.set(userId, Date.now())
	}

	private cleanup(): void {
		const cutoff = Date.now() - this.windowMs
		for (const [cid, inner] of this.map) {
			for (const [uid, ts] of inner) {
				if (ts < cutoff) inner.delete(uid)
			}
			if (inner.size === 0) this.map.delete(cid)
		}
	}

	getCountByCompany(): Record<string, number> {
		this.cleanup()
		const out: Record<string, number> = {}
		for (const [cid, inner] of this.map) out[cid] = inner.size
		return out
	}

	getTotal(): number {
		this.cleanup()
		let sum = 0
		for (const inner of this.map.values()) sum += inner.size
		return sum
	}
}
