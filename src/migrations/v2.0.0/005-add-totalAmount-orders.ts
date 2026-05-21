import { MigrationStep, MigrationResult } from './types'

const ORDERS = 'Orders'
const PRODUCTS = 'Products'

export const m005AddTotalAmountOrders: MigrationStep = {
	name: '005-add-totalAmount-orders',
	description: 'Денормализация: посчитать totalAmount для существующих Orders (sum items[].qty * product.price)',

	async up(ctx): Promise<MigrationResult> {
		const t0 = Date.now()
		const { db, logger, dryRun } = ctx
		const orders = db.collection(ORDERS)
		const products = db.collection(PRODUCTS)

		const cursor = orders.find({ totalAmount: { $exists: false } })
		let processed = 0
		let changed = 0


		const allProducts = await products.find({}).toArray()
		const priceMap = new Map<string, number>()
		for (const p of allProducts) priceMap.set(String(p._id), p.price || 0)

		while (await cursor.hasNext()) {
			const o = await cursor.next()
			if (!o) break
			processed++
			let total = 0
			for (const item of o.items || []) {
				const price = priceMap.get(String(item.product)) || 0
				total += (item.quantity || 0) * price
			}
			if (dryRun) continue
			await orders.updateOne({ _id: o._id }, { $set: { totalAmount: total } })
			changed++
		}

		logger.log(`Orders processed: ${processed}, totalAmount written: ${changed}`)
		return {
			name: '005-add-totalAmount-orders',
			changed,
			wouldChange: dryRun ? processed : undefined,
			durationMs: Date.now() - t0,
		}
	},
}
