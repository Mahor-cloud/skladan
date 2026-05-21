/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { Injectable } from '@nestjs/common'
import { Observable, Subject, merge } from 'rxjs'
import { filter, map } from 'rxjs/operators'
import { interval } from 'rxjs'

export interface RealtimeEvent {
	company: string
	type: string
}

@Injectable()
export class RealtimeService {
	private readonly subject = new Subject<RealtimeEvent>()
	private active = 0
	private byCompany = new Map<string, number>()

	emit(company: string | null | undefined, type: string): void {
		if (!company || !type) return

		try {
			this.subject.next({ company: String(company), type })
		} catch {

		}
	}



	streamForCompany(company: string) {
		const cid = String(company)
		const events = this.subject.asObservable().pipe(
			filter((e) => e.company === cid),
			map((e) => ({ data: { type: e.type } }))
		)
		const heartbeat = interval(25000).pipe(map(() => ({ data: { type: 'ping' } })))
		const stream = merge(events, heartbeat)

		return new Observable((sub) => {
			this.active++
			this.byCompany.set(cid, (this.byCompany.get(cid) || 0) + 1)
			const inner = stream.subscribe(sub)
			return () => {
				this.active = Math.max(0, this.active - 1)
				const next = (this.byCompany.get(cid) || 1) - 1
				if (next <= 0) this.byCompany.delete(cid)
				else this.byCompany.set(cid, next)
				try {
					inner.unsubscribe()
				} catch {

				}
			}
		})
	}

	getActiveCount(): number {
		return this.active
	}

	getActiveByCompany(): Record<string, number> {
		return Object.fromEntries(this.byCompany)
	}
}
