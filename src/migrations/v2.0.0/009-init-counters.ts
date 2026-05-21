/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { MigrationStep, MigrationResult } from './types'

const COMPANIES = 'Company'
const COUNTERS = 'Counter'
const ORDERS = 'Orders'
const PURCHASES = 'Purchases'

export const m009InitCounters: MigrationStep = {
	name: '009-init-counters',
	description: 'Заинициализировать Counters {company, type} = max(existingNumber) для каждой Company',

	async up(ctx): Promise<MigrationResult> {
		const t0 = Date.now()
		const { db, logger, dryRun } = ctx
		const companies = await db.collection(COMPANIES).find({}).toArray()

		let changed = 0
		let wouldChange = 0
		for (const c of companies) {
			const cid = c._id

			const maxOrder = await db.collection(ORDERS).aggregate([
				{ $match: { company: cid } },
				{ $group: { _id: null, max: { $max: '$orderNumber' } } },
			]).toArray()
			const maxPurchase = await db.collection(PURCHASES).aggregate([
				{ $match: { company: cid } },
				{ $group: { _id: null, max: { $max: '$purchaseNumber' } } },
			]).toArray()

			const orderMax = maxOrder[0]?.max || 0
			const purchaseMax = maxPurchase[0]?.max || 0

			for (const [type, value] of [['order', orderMax], ['purchase', purchaseMax]] as const) {
				if (dryRun) {
					logger.log(`[DRY] Would set Counter {company: ${cid}, type: ${type}} = ${value}`)
					wouldChange++
					continue
				}
				const res = await db.collection(COUNTERS).findOneAndUpdate(
					{ company: cid, type },
					{ $max: { value }, $setOnInsert: { company: cid, type } },
					{ upsert: true, returnDocument: 'after' as any }
				)
				logger.log(`Counter {company: ${cid}, type: ${type}} → ${value} (result: ${JSON.stringify(res?.value)})`)
				changed++
			}
		}
		return {
			name: '009-init-counters',
			changed,
			wouldChange: dryRun ? wouldChange : undefined,
			durationMs: Date.now() - t0,
		}
	},
}
