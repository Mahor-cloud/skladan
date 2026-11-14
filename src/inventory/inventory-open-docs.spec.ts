/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { BadRequestException } from '@nestjs/common'
import { purchaseReceives } from '../purchases/purchases.service'
import { assertStockNotFrozen, openDocsAllowed } from './inventory-lock'
import { InventoryService } from './inventory.service'

// Chainable stand-in for a mongoose query: .select()/.lean() return itself, .exec() resolves the value.
const q = (value: any) => {
	const query: any = { exec: async () => value }
	query.select = () => query
	query.lean = () => query
	return query
}

function makeService(opts: { flag?: boolean | null; openOrders?: number; openPurchases?: number; activeInventory?: any }) {
	const saved: any[] = []
	class InventoryModel {
		constructor(doc: any) {
			Object.assign(this, doc)
		}
		async save() {
			saved.push(this)
			return this
		}
		static findOne = jest.fn(() => q(opts.activeInventory ?? null))
		static findById = jest.fn()
		static findByIdAndUpdate = jest.fn()
	}
	const productModel: any = {
		find: jest.fn(() => q([{ _id: 'p1', quantity: 5 }])),
		updateOne: jest.fn(() => q(undefined)),
	}
	const orderModel: any = { countDocuments: jest.fn(() => q(opts.openOrders ?? 0)) }
	const purchaseModel: any = { countDocuments: jest.fn(() => q(opts.openPurchases ?? 0)) }
	const messageModel: any = {
		findOne: jest.fn(() => q(opts.flag === null || opts.flag === undefined ? null : { allowInventoryWithOpenDocs: opts.flag })),
	}
	const history: any = { createChangeHistory: jest.fn(async () => ({})) }
	const service = new InventoryService(
		InventoryModel as any,
		productModel,
		orderModel,
		purchaseModel,
		messageModel,
		history
	)
	return { service, saved, InventoryModel, productModel, orderModel }
}

const user: any = { _id: 'u1', company: 'c1', role: {} }

async function caught(p: Promise<any>): Promise<any> {
	try {
		await p
	} catch (e) {
		return e
	}
	throw new Error('expected a rejection')
}

describe('createInventory with open orders/purchases', () => {
	it('flag off: the old error, word for word, nothing created', async () => {
		const { service, saved } = makeService({ flag: false, openOrders: 2 })
		const e = await caught(service.createInventory(user, true, true))
		expect(e).toBeInstanceOf(BadRequestException)
		expect(e.message).toBe(
			'Нельзя начать инвентаризацию: есть незавершённых заказов: 2. Сначала завершите все заказы и закупки.'
		)
		expect(saved).toHaveLength(0)
	})

	it('no settings document at all behaves as flag off', async () => {
		const { service, saved } = makeService({ flag: null, openPurchases: 1 })
		const e = await caught(service.createInventory(user, true, true))
		expect(e.message).toBe(
			'Нельзя начать инвентаризацию: есть незавершённых закупок: 1. Сначала завершите все заказы и закупки.'
		)
		expect(saved).toHaveLength(0)
	})

	it('flag on, not confirmed: OPEN_DOCS with counts, nothing created', async () => {
		const { service, saved } = makeService({ flag: true, openOrders: 2, openPurchases: 1 })
		const e = await caught(service.createInventory(user, true, false))
		expect(e.getResponse()).toMatchObject({ code: 'OPEN_DOCS', openOrders: 2, openPurchases: 1 })
		expect(e.getResponse().message).toMatch(/^Незавершённых заказов: 2, закупок: 1\. /)
		expect(saved).toHaveLength(0)
	})

	it('flag on, confirmed: inventory created from physical stock', async () => {
		const { service, saved } = makeService({ flag: true, openOrders: 2 })
		await service.createInventory(user, true, true)
		expect(saved).toHaveLength(1)
		expect(saved[0].items).toEqual([{ product: 'p1', newQuantity: 5, quantity: 5 }])
	})

	it('nothing open: created as before', async () => {
		const { service, saved } = makeService({ flag: false })
		await service.createInventory(user, false)
		expect(saved).toHaveLength(1)
		expect(saved[0].items[0].newQuantity).toBe(0)
	})

	it('an inventory already open still blocks a new one', async () => {
		const { service, saved } = makeService({ flag: true, activeInventory: { _id: 'i0' } })
		const e = await caught(service.createInventory(user, true, true))
		expect(e.message).toContain('Уже есть незавершённая инвентаризация')
		expect(saved).toHaveLength(0)
	})
})

describe('completing an inventory while orders are open', () => {
	it('completes and sets stock to the count; open orders are not checked', async () => {
		const { service, InventoryModel, productModel, orderModel } = makeService({ openOrders: 3 })
		const old = { _id: 'i1', startDate: 1, isCompleted: false, comment: '', items: [{ product: 'p1', newQuantity: 0, quantity: 5 }] }
		InventoryModel.findById.mockReturnValue(q(old))
		InventoryModel.findByIdAndUpdate.mockReturnValue(
			q({ ...old, isCompleted: true, items: [{ product: 'p1', newQuantity: 7, quantity: 5 }] })
		)
		await service.update('i1', { isCompleted: true, items: [{ product: 'p1', newQuantity: 7, quantity: 5 }] }, user)
		expect(productModel.updateOne).toHaveBeenCalledWith({ _id: 'p1' }, { $set: { quantity: 7 } })
		expect(orderModel.countDocuments).not.toHaveBeenCalled()
	})
})

describe('a completed inventory', () => {
	it('cannot be reopened through the API (isCompleted:false is dropped)', async () => {
		const { service, InventoryModel } = makeService({})
		const old = { _id: 'i1', startDate: 1, isCompleted: true, comment: '', items: [{ product: 'p1', newQuantity: 7, quantity: 5 }] }
		InventoryModel.findById.mockReturnValue(q(old))
		InventoryModel.findByIdAndUpdate.mockReturnValue(q(old))
		await service.update('i1', { isCompleted: false, editReason: 'x' }, user)
		expect(InventoryModel.findByIdAndUpdate.mock.calls[0][1]).not.toHaveProperty('isCompleted')
	})
})

describe('purchaseReceives (what is frozen during an inventory)', () => {
	const items = (c: number) => [{ product: 'p1', confirmedQuantity: c }, { product: 'p2', confirmedQuantity: 0 }]
	const fresh = { isCompleted: false, partialCompleted: false, items: items(0) }
	const partial = { isCompleted: false, partialCompleted: true, items: items(2) }

	it('first partial receipt → frozen', () => expect(purchaseReceives(fresh, { partialCompleted: true, items: items(2) })).toBe(true))
	it('completing → frozen', () => expect(purchaseReceives(partial, { isCompleted: true })).toBe(true))
	it('changing the received count of a partial purchase → frozen', () => expect(purchaseReceives(partial, { items: items(3) })).toBe(true))
	it('re-saving a partial purchase with the same counts → allowed', () => expect(purchaseReceives(partial, { items: items(2) })).toBe(false))
	it('paying, editing planned items, creating → allowed', () => {
		expect(purchaseReceives(fresh, { isPaid: true } as any)).toBe(false)
		expect(purchaseReceives(fresh, { items: [{ product: 'p1', quantity: 5 } as any], isCreated: true } as any)).toBe(false)
	})
	it('a new line with a received count on a partial purchase → frozen', () =>
		expect(purchaseReceives(partial, { items: [...items(2), { product: 'p3', confirmedQuantity: 1 }] })).toBe(true))
})

describe('inventory-lock', () => {
	it('assertStockNotFrozen throws ACTIVE_INVENTORY with the given text while an inventory is open', async () => {
		const model: any = { findOne: () => q({ _id: 'i1' }) }
		const e = await caught(assertStockNotFrozen(model, 'выдача заморожена'))
		expect(e.getResponse()).toEqual({ code: 'ACTIVE_INVENTORY', message: 'выдача заморожена' })
	})

	it('assertStockNotFrozen passes when no inventory is open', async () => {
		const model: any = { findOne: () => q(null) }
		await expect(assertStockNotFrozen(model, 'x')).resolves.toBeUndefined()
	})

	it('openDocsAllowed is true only for an explicit true', async () => {
		const m = (v: any) => ({ findOne: () => q(v) }) as any
		expect(await openDocsAllowed(m({ allowInventoryWithOpenDocs: true }))).toBe(true)
		expect(await openDocsAllowed(m({ allowInventoryWithOpenDocs: false }))).toBe(false)
		expect(await openDocsAllowed(m({}))).toBe(false)
		expect(await openDocsAllowed(m(null))).toBe(false)
	})
})
