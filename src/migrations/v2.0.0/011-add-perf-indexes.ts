/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { MigrationStep, MigrationResult } from './types'

type IndexSpec = {
	collection: string
	keys: Record<string, 1 | -1>
	options?: any
}

const INDEXES: IndexSpec[] = [
	{ collection: 'Purchases', keys: { company: 1, isCompleted: 1, isPaid: 1 } },
	{ collection: 'Orders', keys: { company: 1, user: 1, orderDate: -1 } },
	{ collection: 'ChangeHistory', keys: { company: 1, user: 1, changeDate: -1 } },
	{ collection: 'CabinetItems', keys: { company: 1, user: 1, deletedAt: 1 } },
	{ collection: 'CabinetItems', keys: { company: 1, deletedAt: 1, position: 1 } },
]

export const m011AddPerfIndexes: MigrationStep = {
	name: '011-add-perf-indexes',
	description:
		'ADD-only performance индексы (Purchases/Orders/ChangeHistory/CabinetItems). Идемпотентно.',

	async up(ctx): Promise<MigrationResult> {
		const t0 = Date.now()
		const { db, logger, dryRun } = ctx
		let changed = 0
		let wouldChange = 0
		for (const spec of INDEXES) {
			const coll = db.collection(spec.collection)
			if (dryRun) {
				logger.log(
					`[DRY] Would createIndex on ${spec.collection} keys=${JSON.stringify(
						spec.keys
					)}`
				)
				wouldChange++
				continue
			}
			try {
				const name = await coll.createIndex(
					spec.keys as any,
					spec.options || {}
				)
				logger.log(`Created ${spec.collection}.${name}`)
				changed++
			} catch (err: any) {
				if (err.codeName === 'IndexOptionsConflict' || err.code === 86) {
					logger.warn(
						`Index conflict on ${spec.collection} — already exists with different options: ${err.message}`
					)
				} else if (
					err.codeName === 'IndexKeySpecsConflict' ||
					err.code === 85
				) {
					logger.warn(
						`Index already exists on ${spec.collection} with different name: ${err.message}`
					)
				} else {
					throw err
				}
			}
		}
		return {
			name: '011-add-perf-indexes',
			changed,
			wouldChange: dryRun ? wouldChange : undefined,
			durationMs: Date.now() - t0,
		}
	},
}
