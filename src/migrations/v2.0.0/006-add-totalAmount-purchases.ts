import { MigrationStep, MigrationResult } from './types'

const PURCHASES = 'Purchases'
const PRODUCTS = 'Products'

export const m006AddTotalAmountPurchases: MigrationStep = {
	name: '006-add-totalAmount-purchases',
	description: 'Денормализация: totalAmount (sum qty*price) + totalConfirmedAmount (sum confirmedQty*price) для Purchases',

	async up(ctx): Promise<MigrationResult> {
		const t0 = Date.now()
		const { db, logger, dryRun } = ctx
		const purchases = db.collection(PURCHASES)
		const products = db.collection(PRODUCTS)

		const allProducts = await products.find({}).toArray()
		const priceMap = new Map<string, number>()
		for (const p of allProducts) priceMap.set(String(p._id), p.price || 0)

		const cursor = purchases.find({ totalAmount: { $exists: false } })
		let processed = 0
		let changed = 0

		while (await cursor.hasNext()) {
			const p = await cursor.next()
			if (!p) break
			processed++
			let total = 0
			let totalConfirmed = 0
			for (const item of p.items || []) {
				const price = priceMap.get(String(item.product)) || 0
				total += (item.quantity || 0) * price
				totalConfirmed += (item.confirmedQuantity || 0) * price
			}
			if (dryRun) continue
			await purchases.updateOne(
				{ _id: p._id },
				{ $set: { totalAmount: total, totalConfirmedAmount: totalConfirmed } }
			)
			changed++
		}

		logger.log(`Purchases processed: ${processed}, totalAmount written: ${changed}`)
		return {
			name: '006-add-totalAmount-purchases',
			changed,
			wouldChange: dryRun ? processed : undefined,
			durationMs: Date.now() - t0,
		}
	},
}
