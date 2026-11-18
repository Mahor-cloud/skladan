/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { PurchasesService } from './purchases.service'

// Цены строк и суммы закупки: сервис на подставных моделях, проверяется то, что уходит в запись
describe('цены строк закупки', () => {
	const A = 'a'.repeat(24)
	const B = 'b'.repeat(24)
	const user: any = { _id: 'u1', role: 'r1', isAdmin: true, name: 'Админ', company: 'c1' }
	const clone = (v: any) => JSON.parse(JSON.stringify(v))
	const q = (v: any) => {
		const o: any = { exec: async () => v, select: () => o, lean: () => o, populate: () => o }
		return o
	}
	const prod = (id: string, price: number) => ({ _id: id, name: 'Товар ' + id[0], price, quantity: 100 })
	const base = { _id: 'p1', purchaseNumber: 3, isCreated: true, isPaid: true, partialCompleted: false, isCompleted: false }
	const flags = (isCreated: boolean, isPaid: boolean, partialCompleted: boolean, isCompleted: boolean) => ({ isCreated, isPaid, partialCompleted, isCompleted })

	// cap можно передать свой, чтобы увидеть запись и движения склада и при отказе
	async function run(purchase: any, products: any[], dto: any, cap: any = { stock: [] }) {
		const svc = new PurchasesService(
			{ findById: () => q(clone(purchase)), findByIdAndUpdate: (_id: any, patch: any) => ((cap.patch = patch), q({ ...clone(purchase), ...patch })) } as any,
			{ createChangeHistory: async () => null } as any,
			{ find: () => q(products), findByIdAndUpdate: (id: any, u: any) => (cap.stock.push([String(id), u]), q({})), updateOne: (f: any, u: any) => (cap.stock.push([String(f._id), u]), q({})) } as any,
			{ findById: () => q({ isSystem: true, permissions: [] }) } as any,
			{ findOne: () => q(null) } as any,
			{ findOne: () => q(null) } as any,
			{} as any,
			{} as any
		)
		await svc.update('p1', dto, user)
		return cap
	}

	it('до оплаты: каждое сохранение позиций считает всё по текущим ценам', async () => {
		const pu = { ...base, isPaid: false, items: [{ product: A, quantity: 10, confirmedQuantity: 0, price: 100 }], totalAmount: 1000, totalConfirmedAmount: 0 }
		const { patch } = await run(pu, [prod(A, 120)], { ...flags(true, false, false, false), items: [{ product: A, quantity: 10, confirmedQuantity: 0 }] })
		expect(patch.items).toEqual([{ product: A, quantity: 10, confirmedQuantity: 0, price: 120 }])
		expect(patch.totalAmount).toBe(1200)
	})

	it('оплата: цена запоминается по текущей на этот момент', async () => {
		const pu = { ...base, isPaid: false, items: [{ product: A, quantity: 10, confirmedQuantity: 0, price: 100 }], totalAmount: 1000, totalConfirmedAmount: 0 }
		const { patch } = await run(pu, [prod(A, 120)], { ...flags(true, true, false, false), items: [{ product: A, quantity: 10, confirmedQuantity: 0 }] })
		expect(patch.items[0].price).toBe(120)
		expect(patch.totalAmount).toBe(1200)
	})

	it('после оплаты: частичная приёмка при новой цене товара суммы не переоценивает', async () => {
		const pu = { ...base, items: [{ product: A, quantity: 10, confirmedQuantity: 0, price: 100 }], totalAmount: 1000, totalConfirmedAmount: 0 }
		const { patch } = await run(pu, [prod(A, 120)], { ...flags(true, true, true, false), items: [{ product: A, quantity: 10, confirmedQuantity: 4 }] })
		expect(patch.items).toEqual([{ product: A, quantity: 10, confirmedQuantity: 4, price: 100 }])
		expect(patch.totalAmount).toBe(1000)
		expect(patch.totalConfirmedAmount).toBe(400)
	})

	it('после оплаты: добавленный товар идёт по текущей цене, прежний — по своей', async () => {
		const pu = { ...base, items: [{ product: A, quantity: 10, confirmedQuantity: 0, price: 100 }], totalAmount: 1000, totalConfirmedAmount: 0 }
		const { patch } = await run(pu, [prod(A, 120), prod(B, 50)], {
			...flags(true, true, false, false),
			items: [
				{ product: A, quantity: 10, confirmedQuantity: 0 },
				{ product: B, quantity: 2, confirmedQuantity: 0 },
			],
		})
		expect(patch.items.map((i: any) => i.price)).toEqual([100, 50])
		expect(patch.totalAmount).toBe(1100)
	})

	it('оплату и создание запросом не снять: устаревший экран получает отказ, закупка не меняется', async () => {
		const pu = { ...base, items: [{ product: A, quantity: 10, confirmedQuantity: 0, price: 100 }], totalAmount: 1000, totalConfirmedAmount: 0 }
		const cap: any = { stock: [] }
		await expect(run(pu, [prod(A, 120)], { ...flags(true, false, false, false), items: [{ product: A, quantity: 10, confirmedQuantity: 0 }] }, cap)).rejects.toThrow('обновите страницу')
		await expect(run(pu, [prod(A, 120)], { ...flags(false, true, false, false) }, cap)).rejects.toThrow('обновите страницу')
		expect(cap.stock).toEqual([])
		expect(cap.patch).toBeUndefined()
	})

	it('пустое значение флага ничего не снимает и в запись не идёт; посторонние поля не пишутся', async () => {
		const pu = { ...base, items: [{ product: A, quantity: 10, confirmedQuantity: 0, price: 100 }], totalAmount: 1000, totalConfirmedAmount: 0 }
		const { patch } = await run(pu, [prod(A, 120)], { isPaid: null, isCreated: null, isCompleted: null, comment: 'заметка', user: 'u2', status: 'x' })
		expect(patch).toEqual({ comment: 'заметка' })
	})

	it('«частично принята» без завершения не снять: принятое нельзя зачислить второй раз', async () => {
		const pu = { ...base, partialCompleted: true, items: [{ product: A, quantity: 10, confirmedQuantity: 4, price: 100 }], totalAmount: 1000, totalConfirmedAmount: 400 }
		const cap: any = { stock: [] }
		await expect(run(pu, [prod(A, 120)], { partialCompleted: false }, cap)).rejects.toThrow('обновите страницу')
		expect(cap.patch).toBeUndefined()
	})

	it('строку с уже принятым товаром из закупки не убрать: иначе принятое можно зачислить повторно', async () => {
		const pu = { ...base, partialCompleted: true, items: [{ product: A, quantity: 10, confirmedQuantity: 5, price: 100 }, { product: B, quantity: 2, confirmedQuantity: 0, price: 20 }], totalAmount: 1040, totalConfirmedAmount: 500 }
		const cap: any = { stock: [] }
		await expect(run(pu, [prod(A, 100), prod(B, 20)], { ...flags(true, true, true, false), items: [{ product: B, quantity: 2, confirmedQuantity: 0 }] }, cap)).rejects.toThrow('обновите страницу')
		expect(cap.patch).toBeUndefined()
		// строку без принятого убрать можно
		const ok = await run(pu, [prod(A, 100), prod(B, 20)], { ...flags(true, true, true, false), items: [{ product: A, quantity: 10, confirmedQuantity: 5 }] })
		expect(ok.patch.items).toHaveLength(1)
		// товар дважды в позициях — отказ: принятое считалось бы от последней строки
		const twice = { ...flags(true, true, true, false), items: [{ product: A, quantity: 10, confirmedQuantity: 10 }, { product: A, quantity: 10, confirmedQuantity: 5 }] }
		await expect(run(pu, [prod(A, 100), prod(B, 20)], twice, cap)).rejects.toThrow('указан дважды')
		twice.items[1].product = A.toUpperCase()
		await expect(run(pu, [prod(A, 100), prod(B, 20)], twice, cap)).rejects.toThrow('указан дважды')
		expect(cap.patch).toBeUndefined()
		expect(cap.stock).toEqual([])
	})

	it('завершение после частичной приёмки снимает «частично» — это не отказ', async () => {
		const pu = { ...base, partialCompleted: true, items: [{ product: A, quantity: 10, confirmedQuantity: 4, price: 100 }], totalAmount: 1000, totalConfirmedAmount: 400 }
		const { patch } = await run(pu, [prod(A, 120)], { ...flags(true, true, false, true), items: [{ product: A, quantity: 10, confirmedQuantity: 10 }] })
		expect(patch.isCompleted).toBe(true)
		expect(patch.totalConfirmedAmount).toBe(1000)
	})

	it('позиция без confirmedQuantity записывается с нулём, а не с пустым значением', async () => {
		const pu = { ...base, isPaid: false, items: [{ product: A, quantity: 1, confirmedQuantity: 0 }], totalAmount: 0, totalConfirmedAmount: 0 }
		const { patch } = await run(pu, [prod(A, 120)], { items: [{ product: A, quantity: 10 }] })
		expect(patch.items).toEqual([{ product: A, quantity: 10, confirmedQuantity: 0, price: 120 }])
	})
})
