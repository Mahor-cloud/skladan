import { MigrationStep, MigrationResult } from './types'

const INDEX_DROPS: Array<{ collection: string; indexName: string }> = [
	{ collection: 'Users', indexName: 'login_1' },
	{ collection: 'Products', indexName: 'name_1' },
	{ collection: 'Orders', indexName: 'orderNumber_1' },
	{ collection: 'Purchases', indexName: 'purchaseNumber_1' },
	{ collection: 'Roles', indexName: 'name_1' },
	{ collection: 'Subscriptions', indexName: 'endpoint_1' },
	{ collection: 'Message', indexName: 'paymentMessage_1' },
	{ collection: 'Message', indexName: 'receivedMessage_1' },
]

export const m007DropOldIndexes: MigrationStep = {
	name: '007-drop-old-unique-indexes',
	description: 'Удалить глобальные unique индексы — будут заменены на compound {company, X}',

	async up(ctx): Promise<MigrationResult> {
		const t0 = Date.now()
		const { db, logger, dryRun } = ctx
		let changed = 0
		let wouldChange = 0
		for (const { collection, indexName } of INDEX_DROPS) {
			const coll = db.collection(collection)
			const indexes = await coll.indexes()
			const exists = indexes.some((i: any) => i.name === indexName)
			if (!exists) {
				logger.log(`${collection}: index ${indexName} not found, skip`)
				continue
			}
			if (dryRun) {
				wouldChange++
				logger.log(`[DRY] Would drop ${collection}.${indexName}`)
				continue
			}
			await coll.dropIndex(indexName)
			logger.log(`Dropped ${collection}.${indexName}`)
			changed++
		}
		return {
			name: '007-drop-old-unique-indexes',
			changed,
			wouldChange: dryRun ? wouldChange : undefined,
			durationMs: Date.now() - t0,
		}
	},
}
