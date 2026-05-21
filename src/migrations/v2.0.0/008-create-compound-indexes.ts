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
	{ collection: 'Users', keys: { company: 1, login: 1 }, options: { unique: true, partialFilterExpression: { company: { $type: 'objectId' } } } },
	{ collection: 'Users', keys: { login: 1 }, options: { unique: true, partialFilterExpression: { isSuperAdmin: true } } },

	{ collection: 'Products', keys: { company: 1, name: 1 }, options: { unique: true, partialFilterExpression: { deletedAt: null } } },
	{ collection: 'Products', keys: { company: 1, category: 1 } },
	{ collection: 'Products', keys: { company: 1, deletedAt: 1 } },

	{ collection: 'Orders', keys: { company: 1, orderNumber: 1 }, options: { unique: true } },
	{ collection: 'Orders', keys: { company: 1, orderDate: -1 } },
	{ collection: 'Orders', keys: { company: 1, isCompleted: 1, orderDate: -1 } },
	{ collection: 'Orders', keys: { company: 1, user: 1 } },

	{ collection: 'Purchases', keys: { company: 1, purchaseNumber: 1 }, options: { unique: true } },
	{ collection: 'Purchases', keys: { company: 1, purchaseDate: -1 } },
	{ collection: 'Purchases', keys: { company: 1, isCompleted: 1 } },

	{ collection: 'Inventory', keys: { company: 1, startDate: -1 } },
	{ collection: 'Inventory', keys: { company: 1, createdBy: 1 } },

	{ collection: 'Roles', keys: { company: 1, name: 1 }, options: { unique: true } },

	{ collection: 'ChangeHistory', keys: { company: 1, changeDate: -1 } },
	{ collection: 'ChangeHistory', keys: { company: 1, user: 1 } },

	{ collection: 'Subscriptions', keys: { company: 1, endpoint: 1 }, options: { unique: true } },
	{ collection: 'Subscriptions', keys: { company: 1 } },

	{ collection: 'Message', keys: { company: 1, paymentMessage: 1 }, options: { unique: true, partialFilterExpression: { paymentMessage: { $type: 'string' } } } },
	{ collection: 'Message', keys: { company: 1, receivedMessage: 1 }, options: { unique: true, partialFilterExpression: { receivedMessage: { $type: 'string' } } } },

	{ collection: 'Company', keys: { name: 1 }, options: { unique: true } },
	{ collection: 'Company', keys: { slug: 1 }, options: { unique: true, sparse: true } },

	{ collection: 'Counter', keys: { company: 1, type: 1 }, options: { unique: true } },
]

export const m008CreateCompoundIndexes: MigrationStep = {
	name: '008-create-compound-indexes',
	description: 'Создать compound unique + performance индексы',

	async up(ctx): Promise<MigrationResult> {
		const t0 = Date.now()
		const { db, logger, dryRun } = ctx
		let changed = 0
		let wouldChange = 0
		for (const spec of INDEXES) {
			const coll = db.collection(spec.collection)
			if (dryRun) {
				logger.log(`[DRY] Would createIndex on ${spec.collection} keys=${JSON.stringify(spec.keys)}`)
				wouldChange++
				continue
			}
			try {
				const name = await coll.createIndex(spec.keys as any, spec.options || {})
				logger.log(`Created ${spec.collection}.${name}`)
				changed++
			} catch (err: any) {
				if (err.codeName === 'IndexOptionsConflict' || err.code === 86) {
					logger.warn(`Index conflict on ${spec.collection} — likely already exists with different options: ${err.message}`)
				} else if (err.codeName === 'DuplicateKey' || err.code === 11000) {
					logger.error(`Duplicate key conflict on ${spec.collection} — data needs cleanup first: ${err.message}`)
					throw err
				} else {
					throw err
				}
			}
		}
		return {
			name: '008-create-compound-indexes',
			changed,
			wouldChange: dryRun ? wouldChange : undefined,
			durationMs: Date.now() - t0,
		}
	},
}
