/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { Logger } from '@nestjs/common'
import { GUARDS_METADATA } from '@nestjs/common/constants'
import { plainToInstance } from 'class-transformer'
import { validateSync } from 'class-validator'
import { Types } from 'mongoose'
import { JwtGuard } from '../auth/guards/jwt.guard'
import { SuperAdminGuard } from '../auth/guards/super-admin.guard'
import { FeedbackDeleteDto, FeedbackDto, FeedbackListDto, FeedbackReadDto, FeedbackSettingsDto } from './dto/feedback.dto'
import { FeedbackController } from './feedback.controller'
import { FEEDBACK_LIMIT, FEEDBACK_TOTAL, FEEDBACK_WINDOW, FeedbackService, feedbackMessage, telegramReason } from './feedback.service'

// Telegram подменён: fetch отвечает как api.telegram.org. Токен ниже выдуман, настоящий Telegram тесты не трогают.
const TOKEN = '123456:FAKE_test-token_000000000000000'
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
			const d = { _id: new Types.ObjectId(), createdAt: new Date(), readAt: null, tg: 'none', ...doc }
			rows.push(d)
			return d
		},
		find: (f: any) => q(rows.filter((d) => match(d, f)).sort((a, b) => (String(a._id) < String(b._id) ? 1 : -1))),
		countDocuments: (f: any) => ({ exec: async () => rows.filter((d) => match(d, f)).length }),
		updateOne: (f: any, u: any) => ({ exec: async () => void Object.assign(rows.find((d) => match(d, f)) || {}, u.$set) }),
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

function build(stored: any = null, env: Record<string, string> = {}) {
	const db = { doc: stored }
	const settingsModel = {
		findOne: () => ({ lean: () => ({ exec: async () => db.doc }) }),
		updateOne: (_f: any, u: any) => ({ exec: async () => void (db.doc = { ...(db.doc || {}), ...u.$set }) }),
	}
	const messages = memoryMessages()
	const companyModel = { findById: () => ({ select: () => ({ setOptions: () => ({ lean: () => ({ exec: async () => ({ name: 'Саратов' }) }) }) }) }) }
	const config = { get: (k: string) => ({ JWT_SECRET: 'jwt-test', ...env })[k] }
	const svc = new FeedbackService(settingsModel as any, messages as any, companyModel as any, config as any)
	return { svc, db, messages }
}

async function configured() {
	const b = build()
	await b.svc.saveSettings({ token: TOKEN, chatId: '42' })
	return b
}

const telegram = (status: number, body: any) => (global.fetch = jest.fn(async () => new Response(JSON.stringify(body), { status })) as any)
// фоновая пересылка идёт после ответа: дать ей закончиться
const settle = async () => {
	for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
}

const realFetch = global.fetch
let warn: jest.SpyInstance
beforeEach(() => {
	warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
	global.fetch = realFetch
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

	it('настройки: токен вида Telegram или пусто, ID — число (у группы с минусом)', () => {
		expect(errors(FeedbackSettingsDto, { token: TOKEN, chatId: '42' })).toHaveLength(0)
		expect(errors(FeedbackSettingsDto, { token: '', chatId: '-1001234' })).toHaveLength(0)
		expect(errors(FeedbackSettingsDto, {})).toHaveLength(0)
		expect(errors(FeedbackSettingsDto, { token: '123/../x' })).toHaveLength(1)
		expect(errors(FeedbackSettingsDto, { token: `${TOKEN}@evil` })).toHaveLength(1)
		expect(errors(FeedbackSettingsDto, { chatId: '@user' })).toHaveLength(1)
		expect(errors(FeedbackSettingsDto, { chatId: 42 })).toHaveLength(1)
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

	it('список, значок, прочитано, удаление, настройки и проверка — только супер-админ; отправка — любой вошедший', () => {
		for (const m of ['list', 'unread', 'read', 'remove', 'removeAll', 'settings', 'saveSettings', 'test'] as const) {
			expect(guards(m)).toEqual(expect.arrayContaining([JwtGuard, SuperAdminGuard]))
		}
		expect(guards('submit')).toContain(JwtGuard)
		expect(guards('submit')).not.toContain(SuperAdminGuard)
	})
})

describe('настройки', () => {
	it('токен хранится зашифрованным и наружу не отдаётся; пустой токен оставляет прежний', async () => {
		const { svc, db } = await configured()
		expect(db.doc.token).not.toContain(TOKEN)
		expect(db.doc.token.split('.')).toHaveLength(3)
		const sealed = db.doc.token
		expect(await svc.settings()).toEqual({ chatId: '42', hasToken: true })
		expect(await svc.saveSettings({ token: '', chatId: '77' })).toEqual({ chatId: '77', hasToken: true })
		expect(db.doc.token).toBe(sealed)
		expect(JSON.stringify(await svc.settings())).not.toContain(sealed)
	})

	it('в бою без LITNA_KEY токен не сохраняется, получатель — сохраняется', async () => {
		const { svc, db } = build(null, { NODE_ENV: 'production' })
		await expect(svc.saveSettings({ token: TOKEN, chatId: '42' })).rejects.toThrow('Не задан ключ LITNA_KEY')
		expect(db.doc).toBeNull()
		expect(await svc.saveSettings({ chatId: '42' })).toEqual({ chatId: '42', hasToken: false })
	})

	it('без записи — пусто', async () => {
		expect(await build().svc.settings()).toEqual({ chatId: '', hasToken: false })
	})
})

describe('сообщение в Telegram', () => {
	it('шапка, местность, кто, пустая строка, текст как есть', () => {
		const m = { company: { id: null, name: 'Саратов' }, user: { id: null, name: 'Иван', login: 'ivan', role: 'Представитель' }, text: 'Не грузится *каталог* <b>' }
		expect(feedbackMessage(m as any)).toBe('Skladan · обратная связь\nМестность: Саратов\nОт: Иван (ivan), Представитель\n\nНе грузится *каталог* <b>')
		expect(feedbackMessage({ ...m, company: { id: null, name: '' }, user: { ...m.user, role: 'Супер-админ' } } as any)).toContain('Местность: —')
	})
})

describe('отправка', () => {
	it('сохраняется снимком (местность, автор, роль) и сразу 201 { ok: true }; Telegram не настроен — tg: none, запросов нет', async () => {
		global.fetch = jest.fn() as any
		const { svc, messages } = build()
		expect(await svc.submit(USER, 'Не грузится каталог')).toEqual({ ok: true })
		await settle()
		expect(global.fetch).not.toHaveBeenCalled()
		expect(messages.rows).toHaveLength(1)
		expect(messages.rows[0]).toMatchObject({
			company: { name: 'Саратов' },
			user: { name: 'Иван', login: 'ivan', role: 'Представитель' },
			text: 'Не грузится каталог',
			readAt: null,
			tg: 'none',
		})
		expect(String(messages.rows[0].company.id)).toBe('64a0000000000000000000c1')
		expect(String(messages.rows[0].user.id)).toBe(uid(1))
	})

	it('супер-админ без местности — тоже сохраняется', async () => {
		const { svc, messages } = build()
		await svc.submit({ _id: uid(9), name: 'Главный', login: 'root', isSuperAdmin: true, company: null }, 'т')
		expect(messages.rows[0]).toMatchObject({ company: { id: null, name: '' }, user: { role: 'Супер-админ' } })
	})

	it('пересылка фоном: ответ не ждёт Telegram; успех — tg: sent; ушло на api.telegram.org обычным текстом', async () => {
		const { svc, messages } = await configured()
		let answer: (r: Response) => void
		global.fetch = jest.fn(() => new Promise<Response>((r) => (answer = r))) as any
		expect(await svc.submit(USER, 'Не грузится каталог')).toEqual({ ok: true })
		await settle()
		expect(messages.rows[0].tg).toBe('none')
		answer(new Response(JSON.stringify({ ok: true })))
		await settle()
		expect(messages.rows[0].tg).toBe('sent')
		const [url, init] = (global.fetch as jest.Mock).mock.calls[0]
		expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`)
		expect(init.redirect).toBe('error')
		expect(JSON.parse(init.body)).toEqual({ chat_id: '42', text: feedbackMessage(messages.rows[0]) })
	})

	it('Telegram недоступен — сообщение сохранено, ответ 201, tg: failed; в журнале нет ни токена, ни текста', async () => {
		const { svc, messages } = await configured()
		global.fetch = jest.fn(async () => {
			throw new TypeError('fetch failed')
		}) as any
		expect(await svc.submit(USER, 'секретный текст')).toEqual({ ok: true })
		await settle()
		expect(messages.rows[0]).toMatchObject({ text: 'секретный текст', tg: 'failed' })
		const logged = JSON.stringify(warn.mock.calls)
		expect(logged).toContain('Telegram недоступен')
		expect(logged).not.toContain(TOKEN)
		expect(logged).not.toContain('секретный текст')
	})

	it('Telegram ответил ошибкой — tg: failed, пользователю не видно', async () => {
		const { svc, messages } = await configured()
		telegram(400, { ok: false, description: `Bad Request: chat not found for bot${TOKEN}` })
		expect(await svc.submit(USER, 'т')).toEqual({ ok: true })
		await settle()
		expect(messages.rows[0].tg).toBe('failed')
		expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN)
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
		expect(Object.keys(p1.items[0]).sort()).toEqual(['_id', 'company', 'createdAt', 'readAt', 'text', 'tg', 'user'])
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

describe('проверка из супер-админки', () => {
	it('отправляет проверочное сообщение; без настройки — 503', async () => {
		const { svc } = await configured()
		telegram(200, { ok: true })
		expect(await svc.test()).toEqual({ ok: true })
		expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)).toEqual({ chat_id: '42', text: 'Skladan · проверка обратной связи' })
		await expect(build().svc.test()).rejects.toMatchObject({ status: 503, message: 'Обратная связь пока не настроена' })
	})

	it('причина отказа — коротко по-русски, без токена; Telegram недоступен — 502; ждём не дольше 8 с', async () => {
		const { svc } = await configured()
		const timeout = jest.spyOn(AbortSignal, 'timeout')
		telegram(400, { ok: false, description: 'Bad Request: chat not found' })
		await expect(svc.test()).rejects.toMatchObject({ status: 502, message: 'Чат не найден — получатель должен нажать Start у бота' })
		expect(timeout).toHaveBeenCalledWith(8_000)
		telegram(401, { ok: false, description: 'Unauthorized' })
		await expect(svc.test()).rejects.toMatchObject({ message: 'Telegram не принял токен бота' })
		global.fetch = jest.fn(async () => {
			throw new TypeError('fetch failed')
		}) as any
		await expect(svc.test()).rejects.toMatchObject({ status: 502, message: 'Telegram недоступен' })
		expect(telegramReason(400, `Bad Request: odd bot${TOKEN}`, TOKEN)).not.toContain(TOKEN)
		expect(telegramReason(403, 'Forbidden: bot was blocked by the user', TOKEN)).toBe('Получатель заблокировал бота')
	})

	it('токен, зашифрованный другим ключом, не расшифровывается — 502 с понятной причиной', async () => {
		const { db } = await configured()
		const other = new FeedbackService(
			{ findOne: () => ({ lean: () => ({ exec: async () => db.doc }) }) } as any,
			memoryMessages() as any,
			{} as any,
			{ get: (k: string) => ({ LITNA_KEY: 'другой' })[k] } as any
		)
		global.fetch = jest.fn() as any
		await expect(other.test()).rejects.toMatchObject({ status: 502, message: 'Сохранённый токен не читается — сохраните его заново' })
		expect(global.fetch).not.toHaveBeenCalled()
	})
})
