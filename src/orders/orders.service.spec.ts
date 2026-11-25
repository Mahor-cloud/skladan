/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { BadRequestException } from '@nestjs/common'
import { committedAmount, ordersListFilter, OrdersService, refundOnRemove } from './orders.service'

type StockItem = { product: string; quantity: number }
type ProductLike = { _id: any; name: string; quantity: number; targetQty?: number }

async function assertStockAvailable(
	items: StockItem[],
	productById: Map<string, ProductLike>,
	committedQty: Record<string, number>
): Promise<void> {
	for (const item of items) {
		const product = productById.get(String(item.product))
		if (!product) {
			throw new BadRequestException({
				code: 'PRODUCT_NOT_FOUND',
				product: String(item.product),
				message: `Товар ${item.product} не найден в вашей компании`,
			})
		}
		if (!item.quantity || item.quantity < 1) {
			throw new BadRequestException({
				code: 'INVALID_QUANTITY',
				product: String(product._id),
				productName: product.name,
				message: `Количество товара "${product.name}" должно быть не меньше 1`,
			})
		}
		const available = (product.quantity || 0) - (committedQty[String(item.product)] || 0)
		if (item.quantity > available) {
			throw new BadRequestException({
				code: 'INSUFFICIENT_STOCK',
				product: String(product._id),
				productName: product.name,
				requested: item.quantity,
				available,
				message: `Недостаточно товара "${product.name}" на складе: запрошено ${item.quantity}, доступно ${available}.`,
			})
		}
	}
}

function itemsEqual(
	a: { product: any; quantity: number }[] | undefined,
	b: { product: any; quantity: number }[] | undefined
): boolean {
	if (!a || !b) return false
	if (a.length !== b.length) return false
	const norm = (arr: any[]) =>
		arr
			.map((i) => ({
				p: String(i.product?._id || i.product),
				q: i.quantity || 0,
			}))
			.sort((x, y) => x.p.localeCompare(y.p))
	const an = norm(a as any)
	const bn = norm(b as any)
	for (let i = 0; i < an.length; i++) {
		if (an[i].p !== bn[i].p || an[i].q !== bn[i].q) return false
	}
	return true
}

function guardConfirmedPaidWithoutIsPaid(
	updateDto: { confirmedPaid?: boolean; isPaid?: boolean },
	oldOrder: { isPaid: boolean }
): void {
	if (updateDto.confirmedPaid === true && !oldOrder.isPaid && updateDto.isPaid !== true) {
		throw new BadRequestException(
			'Нельзя подтвердить оплату до того, как заказ отмечен как оплаченный'
		)
	}
}

function guardCompleteWithoutConfirmedPaid(
	updateDto: { isCompleted?: boolean; confirmedPaid?: boolean },
	oldOrder: { confirmedPaid: boolean }
): void {
	if (
		updateDto.isCompleted === true &&
		!oldOrder.confirmedPaid &&
		updateDto.confirmedPaid !== true
	) {
		throw new BadRequestException(
			'Нельзя завершить заказ до подтверждения оплаты'
		)
	}
}

function guardIsPaidRevert(
	updateDto: { isPaid?: boolean },
	oldOrder: { isPaid: boolean }
): void {
	if (updateDto.isPaid === false && oldOrder.isPaid) {
		throw new BadRequestException(
			'Отметку «оплачен» нельзя снять. Если нужна корректировка — отмените заказ или измените позиции'
		)
	}
}

describe('assertStockAvailable', () => {
	const makeProduct = (id: string, name: string, quantity: number): ProductLike => ({
		_id: id,
		name,
		quantity,
	})

	it('throws PRODUCT_NOT_FOUND when product is not in productById map', async () => {
		const items: StockItem[] = [{ product: 'unknown-id', quantity: 1 }]
		const productById = new Map<string, ProductLike>()

		await expect(assertStockAvailable(items, productById, {})).rejects.toMatchObject({
			response: expect.objectContaining({ code: 'PRODUCT_NOT_FOUND' }),
		})
	})

	it('throws INVALID_QUANTITY when quantity is zero', async () => {
		const product = makeProduct('p1', 'Молоко', 10)
		const productById = new Map([['p1', product]])
		const items: StockItem[] = [{ product: 'p1', quantity: 0 }]

		await expect(assertStockAvailable(items, productById, {})).rejects.toMatchObject({
			response: expect.objectContaining({ code: 'INVALID_QUANTITY' }),
		})
	})

	it('throws INVALID_QUANTITY when quantity is negative', async () => {
		const product = makeProduct('p1', 'Молоко', 10)
		const productById = new Map([['p1', product]])
		const items: StockItem[] = [{ product: 'p1', quantity: -5 }]

		await expect(assertStockAvailable(items, productById, {})).rejects.toMatchObject({
			response: expect.objectContaining({ code: 'INVALID_QUANTITY' }),
		})
	})

	it('throws INSUFFICIENT_STOCK when requested exceeds available', async () => {
		const product = makeProduct('p1', 'Хлеб', 5)
		const productById = new Map([['p1', product]])
		const items: StockItem[] = [{ product: 'p1', quantity: 10 }]

		await expect(assertStockAvailable(items, productById, {})).rejects.toMatchObject({
			response: expect.objectContaining({
				code: 'INSUFFICIENT_STOCK',
				requested: 10,
				available: 5,
			}),
		})
	})

	it('throws INSUFFICIENT_STOCK when committed qty reduces available below requested', async () => {
		const product = makeProduct('p1', 'Сахар', 10)
		const productById = new Map([['p1', product]])
		const items: StockItem[] = [{ product: 'p1', quantity: 8 }]

		const committed = { p1: 4 }

		await expect(assertStockAvailable(items, productById, committed)).rejects.toMatchObject({
			response: expect.objectContaining({
				code: 'INSUFFICIENT_STOCK',
				requested: 8,
				available: 6,
			}),
		})
	})

	it('passes when requested equals exactly available (boundary)', async () => {
		const product = makeProduct('p1', 'Масло', 10)
		const productById = new Map([['p1', product]])
		const items: StockItem[] = [{ product: 'p1', quantity: 10 }]

		await expect(assertStockAvailable(items, productById, {})).resolves.toBeUndefined()
	})

	it('passes when requested is less than available with committed taken into account', async () => {
		const product = makeProduct('p1', 'Кефир', 20)
		const productById = new Map([['p1', product]])
		const items: StockItem[] = [{ product: 'p1', quantity: 5 }]
		const committed = { p1: 10 }

		await expect(assertStockAvailable(items, productById, committed)).resolves.toBeUndefined()
	})

	it('throws PRODUCT_NOT_FOUND for each unknown product id independently', async () => {
		const product = makeProduct('p1', 'Товар1', 10)
		const productById = new Map([['p1', product]])
		const items: StockItem[] = [
			{ product: 'p1', quantity: 1 },
			{ product: 'missing', quantity: 1 },
		]

		await expect(assertStockAvailable(items, productById, {})).rejects.toMatchObject({
			response: expect.objectContaining({ code: 'PRODUCT_NOT_FOUND', product: 'missing' }),
		})
	})
})

describe('state-machine guards', () => {
	describe('guardConfirmedPaidWithoutIsPaid', () => {
		it('throws when confirmedPaid=true but order.isPaid=false and update does not set isPaid', () => {
			expect(() =>
				guardConfirmedPaidWithoutIsPaid({ confirmedPaid: true }, { isPaid: false })
			).toThrow('Нельзя подтвердить оплату до того, как заказ отмечен как оплаченный')
		})

		it('passes when confirmedPaid=true and order.isPaid is already true', () => {
			expect(() =>
				guardConfirmedPaidWithoutIsPaid({ confirmedPaid: true }, { isPaid: true })
			).not.toThrow()
		})

		it('passes when confirmedPaid=true and update also sets isPaid=true atomically', () => {
			expect(() =>
				guardConfirmedPaidWithoutIsPaid(
					{ confirmedPaid: true, isPaid: true },
					{ isPaid: false }
				)
			).not.toThrow()
		})

		it('passes when confirmedPaid is not set in update', () => {
			expect(() =>
				guardConfirmedPaidWithoutIsPaid({}, { isPaid: false })
			).not.toThrow()
		})
	})

	describe('guardCompleteWithoutConfirmedPaid', () => {
		it('throws when isCompleted=true but confirmedPaid not yet confirmed', () => {
			expect(() =>
				guardCompleteWithoutConfirmedPaid({ isCompleted: true }, { confirmedPaid: false })
			).toThrow('Нельзя завершить заказ до подтверждения оплаты')
		})

		it('passes when isCompleted=true and confirmedPaid is already true on old order', () => {
			expect(() =>
				guardCompleteWithoutConfirmedPaid({ isCompleted: true }, { confirmedPaid: true })
			).not.toThrow()
		})

		it('passes when isCompleted=true and update also sets confirmedPaid=true atomically', () => {
			expect(() =>
				guardCompleteWithoutConfirmedPaid(
					{ isCompleted: true, confirmedPaid: true },
					{ confirmedPaid: false }
				)
			).not.toThrow()
		})

		it('passes when isCompleted is not being changed', () => {
			expect(() =>
				guardCompleteWithoutConfirmedPaid({ isPaid: true } as any, { confirmedPaid: false })
			).not.toThrow()
		})
	})

	describe('guardIsPaidRevert', () => {
		it('throws when trying to set isPaid=false on an already paid order', () => {
			expect(() =>
				guardIsPaidRevert({ isPaid: false }, { isPaid: true })
			).toThrow('Отметку «оплачен» нельзя снять')
		})

		it('passes when order was not paid and update sets isPaid=false', () => {
			expect(() =>
				guardIsPaidRevert({ isPaid: false }, { isPaid: false })
			).not.toThrow()
		})

		it('passes when isPaid is not included in update dto', () => {
			expect(() =>
				guardIsPaidRevert({}, { isPaid: true })
			).not.toThrow()
		})

		it('passes when updating isPaid from false to true', () => {
			expect(() =>
				guardIsPaidRevert({ isPaid: true }, { isPaid: false })
			).not.toThrow()
		})
	})
})

describe('itemsEqual', () => {
	it('returns false when first array is undefined', () => {
		expect(itemsEqual(undefined, [])).toBe(false)
	})

	it('returns false when second array is undefined', () => {
		expect(itemsEqual([], undefined)).toBe(false)
	})

	it('returns false when arrays have different lengths', () => {
		const a = [{ product: 'p1', quantity: 1 }]
		const b = [{ product: 'p1', quantity: 1 }, { product: 'p2', quantity: 2 }]
		expect(itemsEqual(a, b)).toBe(false)
	})

	it('returns false when same products but different quantities', () => {
		const a = [{ product: 'p1', quantity: 1 }]
		const b = [{ product: 'p1', quantity: 2 }]
		expect(itemsEqual(a, b)).toBe(false)
	})

	it('returns false when different product ids', () => {
		const a = [{ product: 'p1', quantity: 1 }]
		const b = [{ product: 'p2', quantity: 1 }]
		expect(itemsEqual(a, b)).toBe(false)
	})

	it('returns true for identical single-item arrays', () => {
		const a = [{ product: 'p1', quantity: 5 }]
		const b = [{ product: 'p1', quantity: 5 }]
		expect(itemsEqual(a, b)).toBe(true)
	})

	it('returns true for identical multi-item arrays in same order', () => {
		const a = [
			{ product: 'p1', quantity: 2 },
			{ product: 'p2', quantity: 3 },
		]
		const b = [
			{ product: 'p1', quantity: 2 },
			{ product: 'p2', quantity: 3 },
		]
		expect(itemsEqual(a, b)).toBe(true)
	})

	it('returns true when arrays have same items in different order (normalized by sort)', () => {
		const a = [
			{ product: 'p2', quantity: 3 },
			{ product: 'p1', quantity: 2 },
		]
		const b = [
			{ product: 'p1', quantity: 2 },
			{ product: 'p2', quantity: 3 },
		]
		expect(itemsEqual(a, b)).toBe(true)
	})

	it('returns true when product is an object with _id (populated Mongoose ref)', () => {
		const a = [{ product: { _id: 'p1' }, quantity: 5 }]
		const b = [{ product: 'p1', quantity: 5 }]
		expect(itemsEqual(a, b)).toBe(true)
	})
})

describe('ordersListFilter', () => {
	const unfinished = { isCompleted: { $ne: true } }

	it('no params → empty filter (full list, old clients)', () => {
		expect(ordersListFilter()).toEqual({})
		expect(ordersListFilter(undefined, '')).toEqual({})
	})

	it('active=1 → only unfinished', () => {
		expect(ordersListFilter('1')).toEqual(unfinished)
		expect(ordersListFilter('1', '1700000000000')).toEqual(unfinished)
	})

	it('since=<ms> → unfinished or newer than since', () => {
		expect(ordersListFilter(undefined, '1700000000000')).toEqual({
			$or: [unfinished, { orderDate: { $gte: 1700000000000 } }],
		})
	})

	it('garbage params → full list, never a broken query', () => {
		expect(ordersListFilter('yes', 'abc')).toEqual({})
		expect(ordersListFilter(undefined, { $gt: '' } as any)).toEqual({})
	})
})

describe('committedAmount', () => {
	const paid = (amount: number) => ({ type: 'paid', amount }) as any

	it('confirmed payment wins: the sum the treasurer confirmed', () => {
		expect(committedAmount({ paidAmount: 950, totalAmount: 1200, paymentEvents: [paid(900)] })).toBe(950)
	})

	it('paid but never confirmed: the sum the customer marked as paid, not the total after an edit', () => {
		// paid 60 → edited to 90 → edited to 30: the second edit must ask for a refund of 30, not 60
		const afterFirstEdit = { paidAmount: 0, totalAmount: 90, paymentEvents: [paid(60), { type: 'surcharge-pending', amount: 30 } as any] }
		expect(30 - committedAmount(afterFirstEdit)).toBe(-30)
		expect(90 - committedAmount({ paidAmount: 0, totalAmount: 60, paymentEvents: [paid(60)] })).toBe(30)
	})

	it('order paid for 0 keeps 0 as the committed sum', () => {
		expect(committedAmount({ paidAmount: 0, totalAmount: 50, paymentEvents: [paid(0)] })).toBe(0)
	})

	it('a confirmed sum of 0 is still the confirmed sum, not the earlier paid mark', () => {
		const events = [paid(60), { type: 'refund-pending', amount: -60 } as any, { type: 'payment-confirmed', amount: 0 } as any]
		expect(committedAmount({ paidAmount: 0, totalAmount: 0, paymentEvents: events })).toBe(0)
	})

	it('old order without a paid event falls back to its total', () => {
		expect(committedAmount({ paidAmount: 0, totalAmount: 400, paymentEvents: [] })).toBe(400)
		expect(committedAmount({ paidAmount: 0, totalAmount: 400 } as any)).toBe(400)
	})
})

describe('refundOnRemove', () => {
	const ev = (type: string, amount: number) => ({ type, amount }) as any
	const order = (o: any) => ({ isPaid: true, isCompleted: false, paidAmount: 0, totalAmount: 0, paymentEvents: [], ...o })

	it('unpaid order: nothing to refund', () => {
		expect(refundOnRemove(order({ isPaid: false, totalAmount: 90 }))).toBe(0)
	})

	it('not completed: what the customer has put in', () => {
		expect(refundOnRemove(order({ totalAmount: 90, paymentEvents: [ev('paid', 60), ev('items-changed', 30), ev('surcharge-pending', 30)] }))).toBe(60)
	})

	it('completed and edited: the confirmed sum plus the edits that were settled by their own records', () => {
		const base = [ev('paid', 100), ev('payment-confirmed', 100)]
		// 100 → 80: "refund 20" is already a record of its own, so removal refunds the remaining 80, not 100
		expect(refundOnRemove(order({ isCompleted: true, paidAmount: 100, totalAmount: 80, paymentEvents: [...base, ev('items-changed', -20), ev('refund-pending', -20)] }))).toBe(80)
		expect(refundOnRemove(order({ isCompleted: true, paidAmount: 100, totalAmount: 130, paymentEvents: [...base, ev('items-changed', 30), ev('surcharge-pending', 30)] }))).toBe(130)
	})

	it('completed, total drifted by a price change without an edit: the confirmed sum', () => {
		expect(refundOnRemove(order({ isCompleted: true, paidAmount: 2210, totalAmount: 2240, paymentEvents: [ev('paid', 2210), ev('payment-confirmed', 2210)] }))).toBe(2210)
	})

	it('old completed order without events: its total', () => {
		expect(refundOnRemove(order({ isCompleted: true, totalAmount: 400 }))).toBe(400)
	})
})

describe('createOrder: повтор отправки', () => {
	const user: any = { _id: 'u1', company: 'c1', name: 'Тест' }
	const items: any = [{ product: 'p1', quantity: 1 }]
	// found — что находит поиск по ключу: одно значение или очередь значений по вызовам
	const service = (...found: any[]) => {
		const findOne = jest.fn(() => ({ exec: async () => (found.length > 1 ? found.shift() : found[0]) }))
		const further = { findOne: () => { throw new Error('дальше') } }
		return { findOne, svc: new OrdersService({ findOne } as any, null, null, further as any, null, null, null, null) }
	}

	it('тот же ключ возвращает уже созданный заказ, не доходя до остатков', async () => {
		const existing = { _id: 'o1', orderNumber: 7 }
		const { svc, findOne } = service(existing)
		await expect(svc.createOrder(items, user, 'a1b2c3d4-0000')).resolves.toBe(existing)
		expect(findOne).toHaveBeenCalledWith({ user: 'u1', clientKey: 'a1b2c3d4-0000' })
	})

	it('новый ключ идёт дальше обычным путём; ошибка без найденного заказа остаётся ошибкой', async () => {
		const { svc, findOne } = service(null)
		await expect(svc.createOrder(items, user, 'a1b2c3d4-0000')).rejects.toThrow('дальше')
		expect(findOne).toHaveBeenCalledTimes(2)
	})

	it('такой же запрос успел первым: вместо ошибки (остатки, уникальный индекс) возвращается его заказ', async () => {
		const first = { _id: 'o1', orderNumber: 7 }
		const { svc } = service(null, first)
		await expect(svc.createOrder(items, user, 'a1b2c3d4-0000')).resolves.toBe(first)
	})

	it('без ключа и с негодным ключом заказ не ищется', async () => {
		const { svc, findOne } = service({ _id: 'o1' })
		await expect(svc.createOrder(items, user)).rejects.toThrow('дальше')
		await expect(svc.createOrder(items, user, '{"$ne":null}')).rejects.toThrow('дальше')
		await expect(svc.createOrder(items, user, ['a1b2c3d4-0000'] as any)).rejects.toThrow('дальше')
		expect(findOne).not.toHaveBeenCalled()
	})
})

// Цены строк и сумма заказа: сервис на подставных моделях, проверяется то, что уходит в запись
describe('цены строк заказа', () => {
	const A = 'a'.repeat(24)
	const B = 'b'.repeat(24)
	const GONE = 'c'.repeat(24)
	const user: any = { _id: 'u1', role: 'r1', isAdmin: true, name: 'Админ', company: 'c1' }
	const clone = (v: any) => JSON.parse(JSON.stringify(v))
	const q = (v: any) => {
		const o: any = { exec: async () => v, populate: () => o, select: () => o, lean: () => o }
		return o
	}
	const prod = (id: string, price: number) => ({ _id: id, name: 'Товар ' + id[0], price, quantity: 100 })
	const base = { _id: 'o1', orderNumber: 7, user: 'u1', isPaid: true, confirmedPaid: false, isCompleted: false, paidAmount: 0 }
	const paid = (amount: number) => [{ type: 'paid', amount }]

	// cap.patch — то, что сервис записал бы в заказ, cap.stock — движения склада; cap можно передать свой, чтобы увидеть их и при отказе
	async function run(order: any, products: any[], dto: any, cap: any = { stock: [] }) {
		const write = (_id: any, patch: any) => {
			cap.patch = patch
			const { $push, ...set } = patch
			return q({ ...clone(order), ...set })
		}
		const svc = new OrdersService(
			{ findById: () => q(clone(order)), find: () => q([]), aggregate: () => q([]), findByIdAndUpdate: write, findOneAndUpdate: write } as any,
			{ findById: () => q({ isSystem: true, permissions: [] }) } as any,
			{ find: () => q(products), updateOne: (f: any, u: any) => (cap.stock.push([f._id, u.$inc.quantity]), q({})) } as any,
			{ findOne: () => q(null) } as any,
			{ findOne: () => q(null) } as any,
			{ createChangeHistory: async () => null } as any,
			{ getNext: async () => 1 } as any,
			{ replenishAfterOrder: async () => null } as any
		)
		await svc.update('o1', dto, user)
		return cap
	}
	const events = (patch: any) => (patch.$push?.paymentEvents?.$each || []).map((e: any) => [e.type, e.amount])

	it('оплачен, позиции прежние: подтверждение после смены цены не трогает ни цены строк, ни сумму', async () => {
		const order = { ...base, items: [{ product: A, quantity: 2, price: 100 }], totalAmount: 200, paymentEvents: paid(200) }
		const { patch } = await run(order, [prod(A, 150)], { isPaid: true, confirmedPaid: true, items: [{ product: A, quantity: 2 }] })
		expect(patch.items).toEqual([{ product: A, quantity: 2, price: 100 }])
		expect('totalAmount' in patch).toBe(false)
		expect(patch.paidAmount).toBe(200)
	})

	it('оплачен, старый заказ без цен в строках: сумма не тронута, поле цены в строку не пишется', async () => {
		const order = { ...base, items: [{ product: A, quantity: 2 }], totalAmount: 200, paymentEvents: paid(200) }
		const { patch } = await run(order, [prod(A, 150)], { isPaid: true, confirmedPaid: true, items: [{ product: A, quantity: 2 }] })
		expect(patch.items).toEqual([{ product: A, quantity: 2 }])
		expect('price' in patch.items[0]).toBe(false)
		expect('totalAmount' in patch).toBe(false)
	})

	it('оплачен, правка позиций: прежний товар по своей цене, добавленный — по текущей, доплата от внесённого', async () => {
		const order = { ...base, items: [{ product: A, quantity: 2, price: 100 }], totalAmount: 200, paymentEvents: paid(200) }
		const { patch } = await run(order, [prod(A, 150), prod(B, 50)], {
			items: [
				{ product: A, quantity: 3 },
				{ product: B, quantity: 1 },
			],
			editReason: 'проверка',
		})
		expect(patch.items).toEqual([
			{ product: A, quantity: 3, price: 100 },
			{ product: B, quantity: 1, price: 50 },
		])
		expect(patch.totalAmount).toBe(350)
		expect(events(patch)).toEqual([
			['items-changed', 150],
			['surcharge-pending', 150],
		])
	})

	it('неоплачен: при отметке оплаты всё считается по текущим ценам и они запоминаются', async () => {
		const order = { ...base, isPaid: false, items: [{ product: A, quantity: 2, price: 100 }], totalAmount: 200, paymentEvents: [] }
		const { patch } = await run(order, [prod(A, 150)], { isPaid: true, confirmedPaid: false, isCompleted: false, items: [{ product: A, quantity: 2 }] })
		expect(patch.items).toEqual([{ product: A, quantity: 2, price: 150 }])
		expect(patch.totalAmount).toBe(300)
	})

	it('оплачен на 0 ₽ по цене строки 0: подорожавший товар сумму не меняет', async () => {
		const order = { ...base, items: [{ product: A, quantity: 2, price: 0 }], totalAmount: 0, paymentEvents: paid(0) }
		const { patch } = await run(order, [prod(A, 50)], { isPaid: true, confirmedPaid: true, items: [{ product: A, quantity: 2 }] })
		expect(patch.items).toEqual([{ product: A, quantity: 2, price: 0 }])
		expect(patch.totalAmount).toBe(0)
	})

	it('оплачен, товара уже нет в базе: его строка остаётся по записанной цене', async () => {
		const order = { ...base, items: [{ product: A, quantity: 2, price: 100 }, { product: GONE, quantity: 1, price: 30 }], totalAmount: 230, paymentEvents: paid(230) }
		const { patch } = await run(order, [prod(A, 150)], { isPaid: true, confirmedPaid: true, items: [{ product: A, quantity: 2 }, { product: GONE, quantity: 1 }] })
		expect(patch.items.map((i: any) => i.price)).toEqual([100, 30])
		expect('totalAmount' in patch).toBe(false)
	})

	describe('завершённый заказ правит главный админ', () => {
		const done = (items: any[], total: number) => ({ ...base, confirmedPaid: true, isCompleted: true, paidAmount: total, items, totalAmount: total, paymentEvents: [...paid(total), { type: 'payment-confirmed', amount: total }] })

		it('товар остаётся по своей цене: возврат за убранную штуку — по цене заказа, а не сегодняшней', async () => {
			const cap = await run(done([{ product: A, quantity: 2, price: 100 }], 200), [prod(A, 150)], { items: [{ product: A, quantity: 1 }], editReason: 'проверка' })
			expect(cap.patch.items).toEqual([{ product: A, quantity: 1, price: 100 }])
			expect(cap.patch.totalAmount).toBe(100)
			expect(events(cap.patch)).toEqual([
				['items-changed', -100],
				['refund-pending', -100],
			])
			expect(cap.stock).toEqual([[A, 1]])
		})

		it('id товара в верхнем регистре — тот же товар и та же цена', async () => {
			const { patch } = await run(done([{ product: A, quantity: 2, price: 100 }], 200), [prod(A, 150)], { items: [{ product: A.toUpperCase(), quantity: 2 }], editReason: 'проверка' })
			expect(patch.items).toEqual([{ product: A, quantity: 2, price: 100 }])
			expect(patch.totalAmount).toBe(200)
		})

		it('товара нет ни в заказе, ни в каталоге — отказ до пересчёта склада', async () => {
			const cap: any = { stock: [] }
			await expect(run(done([{ product: A, quantity: 2, price: 100 }], 200), [], { items: [{ product: GONE, quantity: 2 }], editReason: 'проверка' }, cap)).rejects.toThrow('не найден')
			expect(cap.stock).toEqual([])
			expect(cap.patch).toBeUndefined()
		})
	})
})

describe('createOrder: позиции', () => {
	const user: any = { _id: 'u1', company: 'c1', name: 'Тест' }
	const A = 'a'.repeat(24)
	const service = () => {
		const saved: any = {}
		const orderModel: any = function (this: any, doc: any) {
			Object.assign(saved, doc)
			Object.assign(this, doc, { save: async () => null })
		}
		orderModel.find = () => ({ exec: async () => [] })
		orderModel.aggregate = () => ({ exec: async () => [] })
		const svc = new OrdersService(
			orderModel,
			null,
			{ find: () => ({ exec: async () => [{ _id: A, name: 'Товар', price: 30, quantity: 50 }] }) } as any,
			{ findOne: () => ({ exec: async () => null }) } as any,
			null,
			{ createChangeHistory: async () => null } as any,
			{ getNext: async () => 5 } as any,
			null
		)
		return { svc, saved }
	}

	it('в строку идёт цена товара; цена и лишние поля из запроса отбрасываются', async () => {
		const { svc, saved } = service()
		await svc.createOrder([{ product: A, quantity: 2, price: 1, extra: 'x' }] as any, user)
		expect(saved.items).toEqual([{ product: A, quantity: 2, price: 30 }])
		expect(saved.totalAmount).toBe(60)
	})

	it('количество не целым числом от 1 — отказ', async () => {
		const { svc } = service()
		for (const quantity of ['2', 0, 1.5, null]) {
			await expect(svc.createOrder([{ product: A, quantity }] as any, user)).rejects.toThrow('целое количество')
		}
		await expect(svc.createOrder([{ product: 'не id', quantity: 1 }] as any, user)).rejects.toThrow('нужен товар')
	})
})
