/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import {
	monthBack,
	mskDay,
	USAGE_ROWS_PER_DAY,
	usageOps,
	UsageService,
} from './usage.service'

const ROLE = {
	_id: '64a0000000000000000000a1',
	name: 'Кладовщик',
	isSystem: false,
	permissions: ['view_orders', 'edit_products'],
}
const USER = {
	_id: '64a000000000000000000001',
	company: '64a0000000000000000000c1',
	isAdmin: true,
	role: ROLE,
}
const batch = (events: any[]) => ({ device: 'phone', events })

describe('дни и месяцы', () => {
	it('день считается по Москве: 21:00 UTC — уже следующий день', () => {
		expect(mskDay(Date.parse('2026-11-19T20:59:59Z'))).toBe('2026-11-19')
		expect(mskDay(Date.parse('2026-11-19T21:00:00Z'))).toBe('2026-11-20')
	})
	it('месяц назад переходит через год', () => {
		expect([
			monthBack('2026-11', 6),
			monthBack('2026-02', 6),
			monthBack('2026-01', 1),
			monthBack('2026-12', 0),
		]).toEqual(['2026-05', '2025-08', '2025-12', '2026-12'])
	})
})

describe('usageOps', () => {
	const now = Date.parse('2026-11-19T10:00:00Z')

	it('подробная запись: пользователь, день, устройство, экран, элемент; роль — названием и постоянным номером', () => {
		const { daily } = usageOps(
			USER,
			batch([{ k: 'click', s: 'Заказы', l: 'К выдаче', n: 3 }]) as any,
			now
		)
		const [op] = daily
		expect(op.updateOne.upsert).toBe(true)
		expect(op.updateOne.filter).toMatchObject({
			day: '2026-11-19',
			device: 'phone',
			screen: 'Заказы',
			kind: 'click',
			label: 'К выдаче',
		})
		expect(String(op.updateOne.filter.user)).toBe(USER._id)
		expect(String(op.updateOne.filter.company)).toBe(USER.company)
		expect(op.updateOne.update.$inc).toEqual({ count: 3, ms: 0 })
		expect(op.updateOne.update.$set.role).toBe('Кладовщик')
		expect(String(op.updateOne.update.$set.roleId)).toBe(ROLE._id)
		expect(op.updateOne.update.$set.staff).toBe(true)
		expect(op.updateOne.update.$setOnInsert).toEqual({
			at: new Date('2026-11-19T00:00:00.000Z'),
		})
	})

	it('время экрана приходит и без нового посещения (n = 0); пустые строки пропускаются', () => {
		const { daily } = usageOps(
			USER,
			batch([
				{ k: 'view', s: 'Каталог', l: '', n: 0, ms: 12000, max: 40000 },
				{ k: 'view', s: 'Корзина', l: '', n: 0, ms: 0 },
			]) as any,
			now
		)
		expect(daily).toHaveLength(1)
		expect(daily[0].updateOne.update.$inc).toEqual({ count: 0, ms: 12000 })
		expect(daily[0].updateOne.update.$max).toEqual({ maxMs: 40000 })
	})

	it('месячные итоги: строка на элемент (роль в ключе — номером, человека в ключе нет) и одна строка самого человека', () => {
		const { monthly } = usageOps(
			USER,
			batch([
				{ k: 'open', s: '', l: '', n: 1 },
				{ k: 'view', s: 'Заказы', l: '', n: 2, ms: 30000, max: 20000 },
				{ k: 'click', s: 'Заказы', l: 'К выдаче', n: 3 },
				{ k: 'click', s: 'Заказы', l: 'Все', n: 1 },
			]) as any,
			now
		)
		expect(monthly).toHaveLength(4) // три элемента (заход — не элемент) и человек
		const click = monthly[1].updateOne
		expect(click.filter).toMatchObject({
			month: '2026-11',
			device: 'phone',
			screen: 'Заказы',
			kind: 'click',
			label: 'К выдаче',
		})
		expect(String(click.filter.roleId)).toBe(ROLE._id)
		expect(click.filter.user).toBeUndefined()
		expect(click.filter.role).toBeUndefined()
		expect(click.update.$inc).toEqual({ count: 3, ms: 0 })
		expect(click.update.$set).toEqual({ role: 'Кладовщик' })
		expect(String(click.update.$addToSet.users)).toBe(USER._id)
		const person = monthly[3].updateOne
		expect(person.filter).toMatchObject({
			month: '2026-11',
			kind: 'user',
			label: USER._id,
			screen: '',
		})
		expect(person.update.$inc).toEqual({
			opens: 1,
			visits: 2,
			clicks: 4,
			ms: 30000,
		})
		expect(person.update.$addToSet).toEqual({ days: '19' })
		expect(person.update.$set).toEqual({ role: 'Кладовщик', staff: true })
	})

	it('снимок прав роли: тот же состав — та же открытая запись с продлённым сроком; сменили права или название — новая', () => {
		const events = [{ k: 'click', s: 'Заказы', l: 'Все', n: 1 }]
		const a = usageOps(USER, batch(events) as any, now).role!
		const sameOtherOrder = usageOps(
			{
				...USER,
				role: { ...ROLE, permissions: ['edit_products', 'view_orders'] },
			},
			batch(events) as any,
			now + 86400000
		).role!
		const morePerms = usageOps(
			{
				...USER,
				role: {
					...ROLE,
					permissions: [...ROLE.permissions, 'approve-payment'],
				},
			},
			batch(events) as any,
			now
		).role!
		const renamed = usageOps(
			{ ...USER, role: { ...ROLE, name: 'Склад' } },
			batch(events) as any,
			now
		).role!
		expect(a.roleId).toBe(ROLE._id)
		expect(sameOtherOrder.key).toBe(a.key)
		expect(new Set([a.key, morePerms.key, renamed.key]).size).toBe(3)
		expect(a.op.updateOne.filter).toMatchObject({ key: a.key, open: true })
		expect(a.op.updateOne.update.$setOnInsert).toMatchObject({
			name: 'Кладовщик',
			isSystem: false,
			permissions: ['edit_products', 'view_orders'],
			from: '2026-11-19',
		})
		expect(a.op.updateOne.update.$max).toEqual({ to: '2026-11-19' })
		expect(sameOtherOrder.op.updateOne.update.$max).toEqual({
			to: '2026-11-20',
		})
	})

	it('пользователь без роли учитывается без номера роли и без снимка прав', () => {
		const out = usageOps(
			{ ...USER, role: null },
			batch([{ k: 'click', s: 'Заказы', l: 'Все', n: 1 }]) as any,
			now
		)
		expect(out.role).toBeNull()
		expect(out.daily[0].updateOne.update.$set).toMatchObject({
			role: '',
			roleId: null,
		})
		expect(out.monthly[0].updateOne.filter.roleId).toBeNull()
	})

	it('супер-админ и пользователь без местности не учитываются', () => {
		const events = [{ k: 'click', s: 'Компании', l: 'Новая', n: 1 }]
		const none = { daily: [], monthly: [], role: null }
		expect(
			usageOps({ ...USER, isSuperAdmin: true }, batch(events) as any, now)
		).toEqual(none)
		expect(
			usageOps({ ...USER, company: null }, batch(events) as any, now)
		).toEqual(none)
		expect(usageOps(null, batch(events) as any, now)).toEqual(none)
	})
})

describe('UsageService.record', () => {
	const big = batch(
		Array.from({ length: 300 }, (_, i) => ({
			k: 'click',
			s: 'Экран',
			l: 'Элемент ' + i,
			n: 1,
		}))
	)
	const make = (monthlyFails = false) => {
		const daily = jest.fn().mockResolvedValue({})
		const monthly = monthlyFails
			? jest.fn().mockRejectedValue(new Error('socket timeout'))
			: jest.fn().mockResolvedValue({})
		const snapshot = jest.fn().mockResolvedValue({ upsertedCount: 1 })
		const close = jest.fn().mockResolvedValue({})
		const service = new UsageService(
			{ bulkWrite: daily } as any,
			{ bulkWrite: monthly } as any,
			{ bulkWrite: snapshot, updateMany: close } as any
		)
		;(service as any).logger = { warn: jest.fn() }
		return { service, daily, monthly, snapshot, close }
	}

	it('пишет подробные записи и месячные итоги; сверх дневного предела строки от пользователя не пишутся', async () => {
		const { service, daily, monthly } = make()
		const accepted = Math.ceil(USAGE_ROWS_PER_DAY / 300)
		for (let i = 0; i < 30; i++) await service.record(USER, big as any)
		expect(daily).toHaveBeenCalledTimes(accepted)
		expect(monthly).toHaveBeenCalledTimes(accepted)
		await service.record(
			{ ...USER, _id: '64a000000000000000000002' },
			big as any
		)
		expect(daily).toHaveBeenCalledTimes(accepted + 1)
	})

	it('снимок прав роли пишется раз в день; роль изменилась — новый снимок, прежние закрываются; вернули прежние права — снова новый', async () => {
		const { service, snapshot, close } = make()
		const small = batch([{ k: 'click', s: 'Заказы', l: 'Все', n: 1 }])
		const changed = { ...USER, role: { ...ROLE, permissions: ['view_orders'] } }
		await service.record(USER, small as any)
		await service.record(
			{ ...USER, _id: '64a000000000000000000002' },
			small as any
		)
		expect(snapshot).toHaveBeenCalledTimes(1)
		await service.record(changed, small as any)
		expect(snapshot).toHaveBeenCalledTimes(2)
		expect(close).toHaveBeenCalledTimes(2)
		expect(close.mock.calls[1][0]).toMatchObject({
			open: true,
			key: { $ne: expect.any(String) },
		})
		await service.record(USER, small as any)
		expect(snapshot).toHaveBeenCalledTimes(3)
	})

	it('сбой одной из записей не превращается в ошибку ответа: клиент не пришлёт пачку повторно и не удвоит счёт', async () => {
		const { service, daily } = make(true)
		await expect(service.record(USER, big as any)).resolves.toBeUndefined()
		expect(daily).toHaveBeenCalledTimes(1)
		expect((service as any).logger.warn).toHaveBeenCalledTimes(1)
	})
})
