/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { historyPayload, samplePoints, SnapshotService } from './snapshot.service'

describe('historyPayload', () => {
	it('keeps the metrics the Observability page charts, exact and labelled', () => {
		const p = {
			process_resident_memory_bytes: 1,
			'skladan_sse_connections_active{company=a}': 2,
			'skladan_sse_connections_active{company=b}': 3,
			skladan_event_loop_lag_ms: 4,
			skladan_event_loop_lag_ms_peak_5m: 5,
		}
		expect(historyPayload(p)).toEqual(p)
	})

	it('drops everything else, including labelled peaks the page would add to current values', () => {
		expect(
			historyPayload({
				'http_request_duration_seconds_bucket{le=0.1,method=GET,route=/api/orders,status=200}': 1,
				'http_requests_total{method=GET,route=/api/orders,status=200}': 2,
				'nodejs_gc_duration_seconds_sum{kind=minor}': 3,
				skladan_event_loop_lag_ms_peak_1h: 4,
				'skladan_sse_connections_active{company=a}_peak_5m': 5,
				'skladan_active_users_15m{company=a}_peak_5m': 6,
			})
		).toEqual({})
	})

	it('tolerates an empty payload', () => {
		expect(historyPayload(undefined as any)).toEqual({})
	})
})

describe('samplePoints', () => {
	const range = (n: number) => Array.from({ length: n }, (_, i) => i)

	it('keeps everything up to the target', () => {
		expect(samplePoints([], 1500)).toEqual([])
		expect(samplePoints([7], 1500)).toEqual([7])
		expect(samplePoints(range(1500), 1500)).toEqual(range(1500))
	})

	it('takes every stride-th point and always the last one', () => {
		const s = samplePoints(range(1501), 1500)
		expect(s.length).toBe(751)
		expect(s[1]).toBe(2)
		expect(s[s.length - 1]).toBe(1500)
		const t = samplePoints(range(3002), 1500)
		expect(t[1]).toBe(3)
		expect(t[t.length - 1]).toBe(3001)
		expect(t.length).toBe(1002)
	})
})

describe('SnapshotService.getHistory', () => {
	// Fake model: pass 1 returns ids in createdAt order, pass 2 streams the docs in reverse.
	function fakeModel(docs: { _id: string; createdAt: Date; payload: Record<string, number> }[]) {
		return {
			find(filter: any) {
				const q: any = {}
				q.sort = q.setOptions = q.lean = () => q
				q.exec = async () => docs.map((d) => ({ _id: d._id }))
				q.cursor = () =>
					(async function* () {
						for (const d of [...docs].reverse()) if (filter._id.$in.includes(d._id)) yield d
					})()
				return q
			},
		}
	}
	const full = { process_open_fds: 1, 'http_requests_total{method=GET,route=/api/x,status=200}': 9 }
	const docs = [1, 2, 3].map((i) => ({ _id: 'id' + i, createdAt: new Date(i * 1000), payload: { ...full } }))

	it('returns points in time order, the first one complete and the rest trimmed', async () => {
		const rows = await SnapshotService.prototype.getHistory.call({ snapshotModel: fakeModel(docs) }, 24)
		expect(rows.map((r: any) => r.createdAt.getTime())).toEqual([1000, 2000, 3000])
		expect(rows[0].payload).toEqual(full)
		expect(rows[1].payload).toEqual({ process_open_fds: 1 })
		expect(rows[2].payload).toEqual({ process_open_fds: 1 })
	})

	it('skips a point that vanished between the passes (TTL) without failing', async () => {
		const model = fakeModel(docs)
		const find = model.find
		model.find = (filter: any) => {
			const q = find(filter)
			if (filter._id) filter._id.$in = filter._id.$in.filter((id: string) => id !== 'id2')
			return q
		}
		const rows = await SnapshotService.prototype.getHistory.call({ snapshotModel: model }, 24)
		expect(rows.map((r: any) => r.createdAt.getTime())).toEqual([1000, 3000])
	})
})
