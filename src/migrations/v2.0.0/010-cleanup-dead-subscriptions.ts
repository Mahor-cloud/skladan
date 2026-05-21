import { MigrationStep, MigrationResult } from './types'

const SUBSCRIPTIONS = 'Subscriptions'

export const m010CleanupDeadSubscriptions: MigrationStep = {
	name: '010-cleanup-dead-subscriptions',
	description: 'Удалить все Subscriptions (мёртвые после VAPID ротации) — пользователи переподпишутся',

	async up(ctx): Promise<MigrationResult> {
		const t0 = Date.now()
		const { db, logger, dryRun } = ctx
		const count = await db.collection(SUBSCRIPTIONS).countDocuments({})
		if (dryRun) {
			logger.log(`[DRY] Would delete ${count} subscription documents`)
			return { name: '010-cleanup-dead-subscriptions', wouldChange: count, changed: 0, durationMs: Date.now() - t0 }
		}
		if (count === 0) {
			return { name: '010-cleanup-dead-subscriptions', changed: 0, idempotent: true, durationMs: Date.now() - t0 }
		}
		const res = await db.collection(SUBSCRIPTIONS).deleteMany({})
		logger.log(`Deleted ${res.deletedCount} stale subscriptions`)
		return { name: '010-cleanup-dead-subscriptions', changed: res.deletedCount || 0, durationMs: Date.now() - t0 }
	},
}
