/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { GUARDS_METADATA } from '@nestjs/common/constants'
import { plainToInstance } from 'class-transformer'
import { validateSync } from 'class-validator'
import { Types } from 'mongoose'
import { JwtGuard } from '../auth/guards/jwt.guard'
import { SuperAdminGuard } from '../auth/guards/super-admin.guard'
import { FeedbackDeleteDto, FeedbackDto, FeedbackListDto, FeedbackReadDto } from './dto/feedback.dto'
import { FeedbackController } from './feedback.controller'
import { FEEDBACK_LIMIT, FEEDBACK_TOTAL, FEEDBACK_WINDOW, FeedbackService } from './feedback.service'

const uid = (n: number) => `64a00000000000000000${String(n).padStart(4, '0')}`
const USER = { _id: uid(1), name: 'Иван', login: 'ivan', role: { name: 'Представитель' }, company: new Types.ObjectId('64a0000000000000000000c1') }

/** Коллекция сообщений в памяти: ровно те запросы, что делает сервис */
function memoryMessages() {
	const rows: any[] = []
	const same = (a: any, b: any) => String(a) === String(b)
	const match = (d: any, f: any = {}) =>
		Object.entries(f).every(([k, v]: [string, any]) => {
			if (v === null) return d[k] == null
			if (v?.$ne === null) return d[k] != null
			if (v?.$lt) return String(d[k]) < String(v.$lt)
			if (v?.$in) return v.$in.some((x: any) => same(x, d[k]))
			return same(d[k], v)
		})
	const q = (list: any[]) => {
		const chain: any = { sort: () => chain, select: () => chain, lean: () => chain, limit: (n: number) => ((list = list.slice(0, n)), chain), exec: async () => list.map((d) => ({ ...d })) }
		return chain
	}
	const model = {
		rows,
		create: async (doc: any) => {
			const d = { _id: new Types.ObjectId(), createdAt: new Date(), readAt: null, ...doc }
			rows.push(d)
			return d
		},
		find: (f: any) => q(rows.filter((d) => match(d, f)).sort((a, b) => (String(a._id) < String(b._id) ? 1 : -1))),
		countDocuments: (f: any) => ({ exec: async () => rows.filter((d) => match(d, f)).length }),
		updateMany: (f: any, u: any) => ({ exec: async () => void rows.filter((d) => match(d, f)).forEach((d) => Object.assign(d, u.$set)) }),
		deleteOne: (f: any) => ({
			exec: async () => {
				const i = rows.findIndex((d) => match(d, f))
				if (i >= 0) rows.splice(i, 1)
				return { deletedCount: i >= 0 ? 1 : 0 }
			},
		}),
		deleteMany: (f: any) => ({
			exec: async () => {
				const keep = rows.filter((d) => !match(d, f))
				const n = rows.length - keep.length
				rows.splice(0, rows.length, ...keep)
				return { deletedCount: n }
			},
		}),
	}
	return model
}

function build() {
	const messages = memoryMessages()
	const companyModel = { findById: () => ({ select: () => ({ setOptions: () => ({ lean: () => ({ exec: async () => ({ name: 'Саратов' }) }) }) }) }) }
	const svc = new FeedbackService(messages as any, companyModel as any)
	return { svc, messages }
}

afterEach(() => {
	jest.restoreAllMocks()
})

describe('проверка запросов', () => {
	const errors = (cls: any, plain: any) => validateSync(plainToInstance(cls, plain) as object, { whitelist: true, forbidNonWhitelisted: true })

	it('текст — 1…2000 знаков после обрезки пробелов', () => {
		expect(errors(FeedbackDto, { text: '   ' })).toHaveLength(1)
		expect(errors(FeedbackDto, {})).toHaveLength(1)
		expect(errors(FeedbackDto, { text: 'x'.repeat(2001) })).toHaveLength(1)
		expect(errors(FeedbackDto, { text: '  ' + 'x'.repeat(2000) + '  ' })).toHaveLength(0)
		expect((plainToInstance(FeedbackDto, { text: '  Баг  ' }) as FeedbackDto).text).toBe('Баг')
		expect(errors(FeedbackDto, { text: 'ok', extra: 1 })).toHaveLength(1)
	})

	it('список, отметка прочитанного и удаление: только номера сообщений и read=1', () => {
		expect(errors(FeedbackListDto, { limit: '20', before: uid(5) })).toHaveLength(0)
		expect(errors(FeedbackListDto, { before: 'x' })).toHaveLength(1)
		expect(errors(FeedbackListDto, { limit: '-1' })).toHaveLength(1)
		expect(errors(FeedbackReadDto, {})).toHaveLength(0)
		expect(errors(FeedbackReadDto, { ids: [uid(1)] })).toHaveLength(0)
		expect(errors(FeedbackReadDto, { ids: ['x'] })).toHaveLength(1)
		expect(errors(FeedbackDeleteDto, { read: '1' })).toHaveLength(0)
		expect(errors(FeedbackDeleteDto, { read: 'yes' })).toHaveLength(1)
	})
})

describe('права', () => {
	const guards = (m: keyof FeedbackController) => Reflect.getMetadata(GUARDS_METADATA, FeedbackController.prototype[m]) || []

	it('список, значок, прочитано и удаление — только супер-админ; отправка — любой вошедший', () => {
		for (const m of ['list', 'unread', 'read', 'remove', 'removeAll'] as const) {
			expect(guards(m)).toEqual(expect.arrayContaining([JwtGuard, SuperAdminGuard]))
		}
		expect(guards('submit')).toContain(JwtGuard)
		expect(guards('submit')).not.toContain(SuperAdminGuard)
	})
})

describe('отправка', () => {
	it('сохраняется снимком (местность, автор, роль) и сразу 201 { ok: true }', async () => {
		const { svc, messages } = build()
		expect(await svc.submit(USER, 'Не грузится каталог')).toEqual({ ok: true })
		expect(messages.rows).toHaveLength(1)
		expect(messages.rows[0]).toMatchObject({
			company: { name: 'Саратов' },
			user: { name: 'Иван', login: 'ivan', role: 'Представитель' },
			text: 'Не грузится каталог',
			readAt: null,
		})
		expect(String(messages.rows[0].company.id)).toBe('64a0000000000000000000c1')
		expect(String(messages.rows[0].user.id)).toBe(uid(1))
	})

	it('супер-админ без местности — тоже сохраняется', async () => {
		const { svc, messages } = build()
		await svc.submit({ _id: uid(9), name: 'Главный', login: 'root', isSuperAdmin: true, company: null }, 'т')
		expect(messages.rows[0]).toMatchObject({ company: { id: null, name: '' }, user: { role: 'Супер-админ' } })
	})

	it('база не сохранила — ошибка видна, место в пределе освобождается', async () => {
		const { svc, messages } = build()
		const create = messages.create
		messages.create = async () => {
			throw new Error('db down')
		}
		await expect(svc.submit(USER, 'т')).rejects.toThrow('db down')
		messages.create = create
		for (let i = 0; i < FEEDBACK_LIMIT; i++) await svc.submit(USER, 'т')
		expect(messages.rows).toHaveLength(FEEDBACK_LIMIT)
	})

	it('предел: 5 сообщений за 10 минут на пользователя; у другого пользователя свой счёт', async () => {
		const { svc, messages } = build()
		let now = 1_800_000_000_000
		jest.spyOn(Date, 'now').mockImplementation(() => now)
		for (let i = 0; i < FEEDBACK_LIMIT; i++) {
			now += 1000
			await svc.submit(USER, 'т')
		}
		await expect(svc.submit(USER, 'т')).rejects.toMatchObject({ status: 429 })
		expect(messages.rows).toHaveLength(FEEDBACK_LIMIT)
		expect(await svc.submit({ ...USER, _id: uid(2) }, 'т')).toEqual({ ok: true })
		now += FEEDBACK_WINDOW
		expect(await svc.submit(USER, 'т')).toEqual({ ok: true })
	})

	it('общий предел установки: 60 сообщений в час — дальше 429 «попробуйте позже»', async () => {
		const { svc } = build()
		let now = 1_800_000_000_000
		jest.spyOn(Date, 'now').mockImplementation(() => now)
		for (let i = 0; i < FEEDBACK_TOTAL; i++) await svc.submit({ ...USER, _id: uid(100 + i) }, 'т')
		await expect(svc.submit({ ...USER, _id: uid(999) }, 'т')).rejects.toMatchObject({ status: 429, message: 'Слишком много сообщений — попробуйте позже' })
		now += 3600_000
		expect(await svc.submit({ ...USER, _id: uid(999) }, 'т')).toEqual({ ok: true })
	})
})

describe('страница супер-админа', () => {
	async function filled(n: number) {
		const b = build()
		for (let i = 0; i < n; i++) await b.svc.submit({ ...USER, _id: uid(200 + i) }, `сообщение ${i}`)
		return b
	}

	it('новые сверху, постранично по before; more — есть ли ещё; unread — сколько новых', async () => {
		const { svc } = await filled(5)
		const p1 = await svc.list({ limit: '2' })
		expect(p1.items.map((m: any) => m.text)).toEqual(['сообщение 4', 'сообщение 3'])
		expect(p1).toMatchObject({ unread: 5, more: true })
		expect(Object.keys(p1.items[0]).sort()).toEqual(['_id', 'company', 'createdAt', 'readAt', 'text', 'user'])
		const p2 = await svc.list({ limit: '2', before: String(p1.items[1]._id) })
		expect(p2.items.map((m: any) => m.text)).toEqual(['сообщение 2', 'сообщение 1'])
		const p3 = await svc.list({ limit: '2', before: String(p2.items[1]._id) })
		expect(p3.items.map((m: any) => m.text)).toEqual(['сообщение 0'])
		expect(p3.more).toBe(false)
		expect((await svc.list({})).items).toHaveLength(5)
	})

	it('отметка прочитанного: перечисленные или все; значок считает только новые', async () => {
		const { svc } = await filled(3)
		const { items } = await svc.list({})
		expect(await svc.markRead([String(items[0]._id)])).toEqual({ unread: 2 })
		expect((await svc.list({})).items[0].readAt).toBeInstanceOf(Date)
		expect(await svc.unreadCount()).toEqual({ unread: 2 })
		expect(await svc.markRead([])).toEqual({ unread: 2 })
		expect(await svc.markRead()).toEqual({ unread: 0 })
	})

	it('удаление: одно, только прочитанные (новые остаются), все', async () => {
		const { svc, messages } = await filled(4)
		const { items } = await svc.list({})
		expect(await svc.remove(String(items[0]._id))).toEqual({ deleted: 1 })
		expect(await svc.remove(String(items[0]._id))).toEqual({ deleted: 0 })
		await svc.markRead([String(items[1]._id)])
		expect(await svc.removeAll(true)).toEqual({ deleted: 1 })
		expect(messages.rows.map((m) => m.text).sort()).toEqual(['сообщение 0', 'сообщение 1'])
		expect(messages.rows.every((m) => m.readAt === null)).toBe(true)
		expect(await svc.removeAll(false)).toEqual({ deleted: 2 })
		expect(await svc.unreadCount()).toEqual({ unread: 0 })
	})
})
