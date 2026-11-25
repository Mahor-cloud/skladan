/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { Types } from 'mongoose'
import { tenantContextStorage } from '../common/tenant-context/tenant-context.storage'
import { StatisticsService } from './statistics.service'

// Подмена запроса mongoose: цепочка методов возвращает себя, .exec() отдаёт значение
const q = (value: any) => {
	const query: any = { exec: async () => value }
	for (const m of ['sort', 'limit', 'populate', 'select']) query[m] = () => query
	return query
}

const company = String(new Types.ObjectId())
const ctx = { company, isSuperAdmin: false, userId: null, bypass: false }
const from = Date.UTC(2026, 10, 1)
const to = Date.UTC(2026, 10, 8)

function make() {
	// aggregate() ждут без .exec()
	const orderModel: any = { aggregate: jest.fn(async () => []), find: jest.fn(() => q([])) }
	const purchaseModel: any = { aggregate: jest.fn(async () => []) }
	const productModel: any = { find: jest.fn(() => q([])) }
	const service = new StatisticsService(orderModel, purchaseModel, {} as any, productModel, {} as any, {} as any)
	const dashboard = (query: any) => tenantContextStorage.run(ctx, () => service.getDashboard({ from, to, ...query } as any))
	return { service, purchaseModel, dashboard }
}

describe('Статистика: доставка закупок с заказом lit-na.ru', () => {
	it('доставка — отдельным числом в днях закупок, за тот же период и по тому же правилу, что сумма', async () => {
		const { purchaseModel, dashboard } = make()
		const rows = [{ date: '2026-11-03', amount: 1000, shipping: 350, purchasesCount: 1, completedCount: 1 }]
		purchaseModel.aggregate.mockResolvedValueOnce(rows)
		const res = await dashboard({})
		expect(res.charts.purchasesByDay).toEqual(rows)

		const [pipeline] = purchaseModel.aggregate.mock.calls[0]
		// неоплаченную закупку не принять (purchases.service), поэтому «частично или полностью принята» — уже оплаченные
		expect(pipeline[0]).toEqual({
			$match: { purchaseDate: { $gte: from, $lt: to }, $or: [{ partialCompleted: true }, { isCompleted: true }] },
		})
		const { $group } = pipeline[1]
		expect($group.amount).toEqual({ $sum: '$totalConfirmedAmount' })
		expect($group.shipping).toEqual({ $sum: '$litna.shipping' })
		expect(pipeline.at(-1).$project).toMatchObject({ amount: 1, shipping: 1 })
	})

	it('отбор по товарам: доставки нет — к товарам она не привязана', async () => {
		const { purchaseModel, dashboard } = make()
		await dashboard({ products: String(new Types.ObjectId()) })
		const [pipeline] = purchaseModel.aggregate.mock.calls[0]
		expect(pipeline.some((s: any) => s.$unwind === '$items')).toBe(true)
		expect(JSON.stringify(pipeline)).not.toContain('shipping')
	})
})
