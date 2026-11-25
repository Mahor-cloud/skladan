/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { PurchasesController } from './purchases.controller'
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
	async function run(purchase: any, products: any[], dto: any, cap: any = { stock: [] }, bySite = false) {
		const svc = new PurchasesService(
			{
				findById: () => q(clone(purchase)),
				// cap.taken — оплату уже отметил параллельный вызов: условие записи не совпало
				findOneAndUpdate: (filter: any, patch: any) => ((cap.filter = filter), cap.taken ? q(null) : ((cap.patch = patch), q({ ...clone(purchase), ...patch }))),
			} as any,
			{ createChangeHistory: async () => void (cap.history = (cap.history || 0) + 1) } as any,
			{ find: () => q(products), findByIdAndUpdate: (id: any, u: any) => (cap.stock.push([String(id), u]), q({})), updateOne: (f: any, u: any) => (cap.stock.push([String(f._id), u]), q({})) } as any,
			{ findById: () => q(cap.role ?? { isSystem: true, permissions: [] }) } as any,
			{ findOne: () => q(null) } as any,
			{ findOne: () => q(null) } as any,
			{} as any,
			{} as any,
			{ exists: () => q(cap.record ?? null) } as any
		)
		await svc.update('p1', dto, user, bySite)
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

	describe('закупка с заказом на lit-na.ru', () => {
		const litna = { orderId: 501, status: 'pending', shipping: 625, total: 3625 }
		const pu = { ...base, isPaid: false, litna, items: [{ product: A, quantity: 10, confirmedQuantity: 0, price: 100 }], totalAmount: 1000, totalConfirmedAmount: 0 }

		it('цены сайта остаются и до оплаты, когда экран присылает позиции', async () => {
			const { patch } = await run(pu, [prod(A, 120)], { comment: 'x', items: [{ product: A, quantity: 10, confirmedQuantity: 0 }] })
			expect(patch.items[0].price).toBe(100)
			expect(patch.totalAmount).toBe(1000)
		})

		it('состав не меняется, приёмка — как обычно', async () => {
			const cap: any = { stock: [] }
			await expect(run(pu, [prod(A, 100)], { items: [{ product: A, quantity: 11, confirmedQuantity: 0 }] }, cap)).rejects.toThrow('состав закупки менять нельзя')
			await expect(run(pu, [prod(A, 100), prod(B, 5)], { items: [{ product: A, quantity: 10 }, { product: B, quantity: 1 }] }, cap)).rejects.toThrow('состав закупки менять нельзя')
			expect(cap.patch).toBeUndefined()
			const paid = { ...pu, isPaid: true }
			const { patch, stock } = await run(paid, [prod(A, 120)], { ...flags(true, true, true, false), items: [{ product: A.toUpperCase(), quantity: 10, confirmedQuantity: 4 }] })
			expect(patch.items).toEqual([{ product: A, quantity: 10, confirmedQuantity: 4, price: 100 }])
			expect(patch.totalConfirmedAmount).toBe(400)
			expect(stock).toEqual([[A, { $inc: { quantity: 4 } }]])
		})

		it('оплату вручную не отметить — только проверкой на сайте', async () => {
			const cap: any = { stock: [], record: { _id: 'o1' } }
			await expect(run(pu, [prod(A, 120)], { ...flags(true, true, false, false), items: [{ product: A, quantity: 10, confirmedQuantity: 0 }] }, cap)).rejects.toThrow('после оплаты на lit-na.ru')
			expect(cap.patch).toBeUndefined()
			const bySite = await run(pu, [prod(A, 120)], { isPaid: true }, { stock: [], record: { _id: 'o1' } }, true)
			expect(bySite.patch).toEqual({ isPaid: true })
			// запись только при условии «ещё не оплачена»
			expect(bySite.filter).toEqual({ _id: 'p1', isPaid: { $ne: true } })
		})

		it('без записи заказа (местность перенесли) — оплату отмечают вручную', async () => {
			const { patch } = await run(pu, [prod(A, 100)], { ...flags(true, true, false, false), items: [{ product: A, quantity: 10, confirmedQuantity: 0 }] })
			expect(patch.isPaid).toBe(true)
		})

		it('две проверки оплаты сразу: историю и push пишет только первая', async () => {
			const first = await run(pu, [prod(A, 120)], { isPaid: true }, { stock: [], record: { _id: 'o1' } }, true)
			expect(first.history).toBe(1)
			const second = await run(pu, [prod(A, 120)], { isPaid: true }, { stock: [], record: { _id: 'o1' }, taken: true }, true)
			expect(second.history).toBeUndefined()
		})

		it('черновик, по которому оформляется заказ, «вручную» не создать', async () => {
			const draft = { ...pu, isCreated: false }
			await expect(run(draft, [prod(A, 100)], { ...flags(true, false, false, false), items: [{ product: A, quantity: 10, confirmedQuantity: 0 }] })).rejects.toThrow('ещё оформляется')
			const { patch } = await run(draft, [prod(A, 100)], { isCreated: true }, { stock: [] }, true)
			expect(patch.isCreated).toBe(true)
		})
	})

	describe('удаление', () => {
		const remove = (purchase: any, record: any, bySite = false) => {
			const cap: any = {}
			const svc = new PurchasesService(
				{ findById: () => q(purchase), findByIdAndDelete: () => ((cap.deleted = true), q(purchase)) } as any,
				{ createChangeHistory: async () => null } as any,
				{} as any,
				{} as any,
				{} as any,
				{} as any,
				{} as any,
				{} as any,
				{ exists: () => q(record) } as any
			)
			return svc.remove('p1', user, bySite).then(() => cap)
		}
		it('закупку с заказом на lit-na.ru (и с намерением) обычным путём не удалить; из src/litna — можно', async () => {
			await expect(remove({ ...base, isPaid: false, litna: { orderId: 1 } }, null)).rejects.toThrow('lit-na.ru')
			await expect(remove({ ...base, isPaid: false, isCreated: false }, { _id: 'o1' })).rejects.toThrow('lit-na.ru')
			expect((await remove({ ...base, isPaid: false, litna: { orderId: 1 } }, { _id: 'o1' }, true)).deleted).toBe(true)
			expect((await remove({ ...base, isPaid: false }, null)).deleted).toBe(true)
		})
	})

	it('право подтверждать оплату ставит только оплату: приёмка и завершение — с правом редактирования, создание — создавать или править', async () => {
		const as = (...permissions: string[]): any => ({ stock: [], role: { isSystem: false, permissions } })
		const paid = { ...base, items: [{ product: A, quantity: 10, confirmedQuantity: 0, price: 100 }], totalAmount: 1000, totalConfirmedAmount: 0 }
		const unpaid = { ...paid, isPaid: false }
		const rows = (confirmedQuantity: number) => [{ product: A, quantity: 10, confirmedQuantity }]
		expect((await run(unpaid, [prod(A, 100)], { ...flags(true, true, false, false), items: rows(0) }, as('approve-payment'))).patch.isPaid).toBe(true)
		for (const dto of [{ isCompleted: true }, { partialCompleted: true }, { ...flags(true, true, false, true), items: rows(0) }]) {
			const cap = as('approve-payment')
			await expect(run(paid, [prod(A, 100)], dto, cap)).rejects.toThrow('Приёмка и завершение')
			expect(cap.patch).toBeUndefined()
			expect(cap.stock).toEqual([])
		}
		expect((await run(paid, [prod(A, 100)], { ...flags(true, true, false, true), items: rows(10) }, as('edit_purchases'))).patch.isCompleted).toBe(true)
		const draft = { ...unpaid, isCreated: false }
		await expect(run(draft, [prod(A, 100)], { isCreated: true }, as('approve-payment'))).rejects.toThrow('Нет права создавать закупки')
		expect((await run(draft, [prod(A, 100)], { isCreated: true }, as('create_purchases', 'approve-payment'))).patch.isCreated).toBe(true)
	})

	it('без галочки «Служащий» — только свои закупки: чужую не оплатить, не принять, не вернуть в черновик и не удалить', async () => {
		const mine = { ...base, user: 'u9', isPaid: false, items: [{ product: A, quantity: 10, confirmedQuantity: 0, price: 100 }], totalAmount: 1000, totalConfirmedAmount: 0 }
		const rows = [{ product: A, quantity: 10, confirmedQuantity: 0 }]
		const role = { isSystem: false, permissions: ['create_purchases', 'edit_purchases', 'approve-payment', 'delete_purchases'] }
		const model = (purchase: any, cap: any) => ({
			findById: () => q(clone(purchase)),
			findOneAndUpdate: (_: any, patch: any) => ((cap.patch = patch), q({ ...clone(purchase), ...patch })),
			findByIdAndUpdate: (_: any, patch: any) => ((cap.patch = patch), q({ ...clone(purchase), ...patch })),
		})
		const make = (purchase: any, cap: any) =>
			new PurchasesService(model(purchase, cap) as any, { createChangeHistory: async () => ({}) } as any, { find: () => q([prod(A, 100)]) } as any, { findById: () => q(role) } as any, { findOne: () => q(null) } as any, { findOne: () => q(null) } as any, {} as any, {} as any, { exists: () => q(null) } as any)
		const by = (id: string, isAdmin: boolean): any => ({ _id: id, role: { _id: 'r1', isSystem: false }, isAdmin, company: 'c1' })
		const pay = { ...flags(true, true, false, false), items: rows }
		const text = 'Чужую закупку меняет только служащий'
		for (const call of [(s: PurchasesService) => s.update('p1', pay, by('u2', false)), (s: PurchasesService) => s.backToDraft('p1', by('u2', false)), (s: PurchasesService) => s.remove('p1', by('u2', false))]) {
			const cap: any = {}
			await expect(call(make(mine, cap))).rejects.toThrow(text)
			expect(cap.patch).toBeUndefined()
		}
		// свою — можно; служащий и председатель — любую; вызов из src/litna правило не проверяет (оно стоит там же, у входа)
		for (const who of [by('u9', false), by('u2', true), { ...by('u2', false), role: { isSystem: true } }]) {
			const cap: any = {}
			await make(mine, cap).update('p1', pay, who)
			expect(cap.patch.isPaid).toBe(true)
		}
		const cap: any = {}
		await make(mine, cap).update('p1', { isPaid: true }, by('u2', false), true)
		expect(cap.patch.isPaid).toBe(true)
	})

	it('позиция без confirmedQuantity записывается с нулём, а не с пустым значением', async () => {
		const pu = { ...base, isPaid: false, items: [{ product: A, quantity: 1, confirmedQuantity: 0 }], totalAmount: 0, totalConfirmedAmount: 0 }
		const { patch } = await run(pu, [prod(A, 120)], { items: [{ product: A, quantity: 10 }] })
		expect(patch.items).toEqual([{ product: A, quantity: 10, confirmedQuantity: 0, price: 120 }])
	})
})

describe('toDraft: заказ на lit-na.ru отменён — снова черновик', () => {
	const A = 'a'.repeat(24)
	const q = (v: any) => {
		const o: any = { exec: async () => v }
		return o
	}
	const build = (purchase: any, record: any = null) => {
		const cap: any = {}
		const svc = new PurchasesService(
			{
				findById: () => q(purchase),
				findOneAndUpdate: (f: any, u: any) => ((cap.filter = f), (cap.update = u), q({ ...purchase, ...u, litna: undefined })),
			} as any,
			{ createChangeHistory: async (h: any) => (cap.history = h) } as any,
			{ find: (f: any) => ((cap.find = f), q([{ _id: A, price: 120 }, { _id: 'b'.repeat(24), price: 30, deletedAt: null }, { _id: 'c'.repeat(24), price: 9, deletedAt: new Date() }])) } as any,
			{} as any,
			{} as any,
			{} as any,
			{} as any,
			{} as any,
			{ exists: () => q(record) } as any
		)
		return { svc, cap }
	}
	const user: any = { _id: 'u1', isAdmin: true }

	it('созданная неоплаченная: цены — нынешние, как у черновика; недостающие товары местности — с нулём; litna снимается', async () => {
		const { svc, cap } = build({ _id: 'p1', isCreated: true, isPaid: false, litna: { orderId: 501 }, items: [{ product: A, quantity: 2, confirmedQuantity: 0, price: 100 }] })
		expect(await svc.toDraft('p1', user, 'Заказ №501 отменён')).toBeTruthy()
		expect(cap.filter).toEqual({ _id: 'p1', isCreated: true, isPaid: { $ne: true } })
		// как в createPurchase: все неудалённые товары местности, удалённый — только если он уже был в закупке
		expect(cap.find).toEqual({ $or: [{ _id: { $in: [A] } }, { deletedAt: null }] })
		expect(cap.update).toEqual({
			isCreated: false,
			items: [
				{ product: A, quantity: 2, confirmedQuantity: 0, price: 120 },
				{ product: 'b'.repeat(24), quantity: 0, confirmedQuantity: 0, price: 30 },
			],
			totalAmount: 240,
			totalConfirmedAmount: 0,
			$unset: { litna: 1 },
		})
		expect(cap.history).toMatchObject({ changeType: 'purchase-updated', description: 'Заказ №501 отменён' })
	})

	it('оплаченную, принятую и черновик не трогает', async () => {
		for (const p of [
			{ isCreated: true, isPaid: true, items: [] },
			{ isCreated: true, isPaid: false, items: [{ product: A, quantity: 2, confirmedQuantity: 1 }] },
			{ isCreated: false, isPaid: false, items: [] },
		]) {
			const { svc, cap } = build({ _id: 'p1', ...p })
			expect(await svc.toDraft('p1', user, 'x')).toBeNull()
			expect(cap.update).toBeUndefined()
		}
	})

	it('«В черновик» созданной вручную: тот же toDraft, в историю обычным событием закупки', async () => {
		const { svc, cap } = build({ _id: 'p1', purchaseNumber: 7, isCreated: true, isPaid: false, items: [{ product: A, quantity: 2, confirmedQuantity: 0, price: 100 }] })
		expect(await svc.backToDraft('p1', user)).toMatchObject({ isCreated: false, totalAmount: 240 })
		expect(cap.filter).toEqual({ _id: 'p1', isCreated: true, isPaid: { $ne: true } })
		expect(cap.history).toMatchObject({ user: 'u1', changeType: 'purchase-updated', description: 'Закупка №7 возвращена в черновик' })
	})

	it('«В черновик»: оплачена, принимали товар, есть заказ сайта, уже черновик — 400 с причиной, ничего не пишется', async () => {
		const created = { _id: 'p1', purchaseNumber: 7, isCreated: true, isPaid: false, items: [] }
		const cases: [any, any, string][] = [
			[{ ...created, isPaid: true }, null, 'Закупка уже оплачена'],
			[{ ...created, items: [{ product: A, quantity: 2, confirmedQuantity: 1 }] }, null, 'По закупке уже принимали товар'],
			[{ ...created, litna: { orderId: 501 } }, null, 'Сначала отвяжите закупку от lit-na.ru'],
			[created, { _id: 'o1' }, 'Сначала отвяжите закупку от lit-na.ru'],
			[{ ...created, isCreated: false }, null, 'Закупка уже черновик'],
		]
		for (const [purchase, record, message] of cases) {
			const { svc, cap } = build(purchase, record)
			const e: any = await svc.backToDraft('p1', user).catch((x) => x)
			expect([e.status, e.message]).toEqual([400, message])
			expect(cap.update).toBeUndefined()
			expect(cap.history).toBeUndefined()
		}
		await expect(build(null).svc.backToDraft('p1', user)).rejects.toThrow('Закупка не найдена')
	})

	it('«В черновик» — POST /purchases/:id/draft с правом создавать или править закупки', () => {
		const handler = PurchasesController.prototype.toDraft
		expect(Reflect.getMetadata('path', handler)).toBe(':id/draft')
		expect(Reflect.getMetadata('permissions', handler)).toEqual(['create_purchases', 'edit_purchases'])
	})
})
