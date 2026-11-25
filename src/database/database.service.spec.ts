/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { BadRequestException } from '@nestjs/common'
import { plainToInstance } from 'class-transformer'
import { DatabaseService } from './database.service'
import { PaymentMessageDto } from './messages.dto'

function makeService() {
	const messageModel: any = { findOneAndUpdate: jest.fn(() => ({ exec: async () => ({}) })) }
	const realtime: any = { emit: jest.fn() }
	const m: any = {}
	const service = new DatabaseService(m, messageModel, m, m, m, m, m, m, m, m, m, m, realtime, m)
	return { service, messageModel }
}

describe('updatePaymentMessage', () => {
	it('old client sending only paymentMessage leaves card, phone and holder untouched', async () => {
		const { service, messageModel } = makeService()
		await service.updatePaymentMessage(plainToInstance(PaymentMessageDto, { paymentMessage: 'Оплата переводом' }))
		expect(messageModel.findOneAndUpdate).toHaveBeenCalledWith(
			{},
			{ $set: { paymentMessage: 'Оплата переводом' } },
			{ new: true, upsert: true }
		)
	})

	it('new client writes the requisites it sends, empty string clears one', async () => {
		const { service, messageModel } = makeService()
		const dto = plainToInstance(PaymentMessageDto, {
			paymentMessage: 'Оплата переводом',
			paymentCard: '2202 0000 0000 0000',
			paymentHolder: '',
		})
		await service.updatePaymentMessage(dto)
		expect(messageModel.findOneAndUpdate.mock.calls[0][1]).toEqual({
			$set: { paymentMessage: 'Оплата переводом', paymentCard: '2202 0000 0000 0000', paymentHolder: '' },
		})
	})
})

function makeImportService() {
	const model = () => {
		// конструктор — для new model(record).validate() перед удалением
		const m: any = jest.fn(() => ({ validate: m.validate }))
		m.validate = jest.fn(async () => undefined)
		m.insertMany = jest.fn(async () => [])
		m.deleteMany = jest.fn(() => ({ setOptions: () => undefined }))
		m.current = []
		const query: any = { select: () => query, setOptions: () => query, lean: () => query, exec: async () => m.current }
		m.find = jest.fn(() => query)
		m.foreign = 0
		m.countDocuments = jest.fn(() => ({ setOptions: async () => m.foreign }))
		m.distinct = jest.fn(() => ({ setOptions: () => ({ exec: async () => m.tokens || [] }) }))
		m.updateMany = jest.fn(() => ({ setOptions: () => ({ exec: async () => undefined }) }))
		return m
	}
	const [inventory, message, role, purchase, product, order, user, subscription, history, company, counter, photo, cabinet] = Array.from({ length: 13 }, model)
	const realtime: any = { emit: jest.fn() }
	const service = new DatabaseService(inventory, message, role, purchase, product, order, user, subscription, history, company, counter, photo, realtime, cabinet)
	return { service, all: [inventory, message, role, purchase, product, order, user, subscription, history, company, counter, photo], product, photo, user, order, role, cabinet }
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(16).fill(0)])
const T1 = 'a'.repeat(32)
const T3 = 'c'.repeat(32)
const smuggled = [
	{ token: T1, contentType: 'text/html', data: Buffer.from('<script>alert(document.cookie)</script>').toString('base64') },
	{ token: '../not-a-token', contentType: 'image/png', data: PNG.toString('base64') },
	{ token: T3, contentType: 'text/html', data: PNG.toString('base64') },
]
const productsWith = [
	{ name: 'a', photo: T1 },
	{ name: 'b', photo: '../not-a-token' },
	{ name: 'c', photo: T3 },
]

describe('company import', () => {
	it('a field that is not a list of records is 400 before anything is deleted', async () => {
		for (const bad of [{ products: 'x' }, { users: [null] }, { productPhotos: {} }]) {
			const { service, all } = makeImportService()
			const e = await service.importCompanyData('c1', { _meta: { type: 'company' }, ...bad }).catch((err) => err)
			expect(e).toBeInstanceOf(BadRequestException)
			expect(e.message).toMatch(/^Повреждённый дамп: «(products|users|productPhotos)» должно быть списком записей$/)
			for (const m of all) expect(m.deleteMany).not.toHaveBeenCalled()
		}
	})

	it('old dump without productPhotos still imports', async () => {
		const { service, product } = makeImportService()
		await service.importCompanyData('c1', { _meta: { type: 'company' }, products: [{ name: 'a' }] })
		expect(product.insertMany).toHaveBeenCalledTimes(1)
	})

	it('pictures: type from bytes, key by pattern; dropped ones leave their product with photo null', async () => {
		const { service, product, photo } = makeImportService()
		await service.importCompanyData('c1', { _meta: { type: 'company' }, products: productsWith, productPhotos: smuggled })
		const saved = photo.insertMany.mock.calls[0][0]
		expect(saved).toHaveLength(1)
		expect(saved[0]).toMatchObject({ token: T3, contentType: 'image/png', company: 'c1' })
		expect(product.insertMany.mock.calls[0][0].map((p) => p.photo)).toEqual([null, null, T3])
	})
})

describe('import keeps links and passwords', () => {
	const U1 = '1'.repeat(24)
	const U2 = '2'.repeat(24)
	const O1 = 'a'.repeat(24)
	const R1 = 'b'.repeat(24)
	const dumpUsers = [
		{ _id: U1, login: 'a', role: R1, password: 'from-dump', tokenVersion: 1 },
		{ _id: U2, login: 'b', role: R1 },
	]
	const dump = (extra = {}) => ({ _meta: { type: 'company' }, users: dumpUsers, roles: [{ _id: R1, name: 'r' }], orders: [{ _id: O1, user: U1 }], ...extra })
	const nothingDeleted = (all) => all.forEach((m) => expect(m.deleteMany).not.toHaveBeenCalled())

	it('company: _id survives, known user keeps the current password and session, dump password is ignored', async () => {
		const { service, user, order, role } = makeImportService()
		user.current = [{ _id: U1, login: 'a', company: 'c1', password: 'hash-now', tokenVersion: 7 }]
		await service.importCompanyData('c1', dump(), { _id: U1, login: 'a' } as any)
		expect(user.find.mock.invocationCallOrder[0]).toBeLessThan(user.deleteMany.mock.invocationCallOrder[0])
		expect(user.insertMany.mock.calls[0][0]).toEqual([
			expect.objectContaining({ _id: U1, role: R1, password: 'hash-now', tokenVersion: 7, company: 'c1', isSuperAdmin: false }),
			expect.objectContaining({ _id: U2, password: undefined }),
		])
		expect(order.insertMany.mock.calls[0][0][0]).toMatchObject({ _id: O1, user: U1, company: 'c1' })
		// roles and users go in first: a failure further down still leaves a way to log in and retry
		expect(role.insertMany.mock.invocationCallOrder[0]).toBeLessThan(user.insertMany.mock.invocationCallOrder[0])
		expect(user.insertMany.mock.invocationCallOrder[0]).toBeLessThan(order.insertMany.mock.invocationCallOrder[0])
	})

	it('dump from a database with other ids: the password is found by login in the same company', async () => {
		const { service, user } = makeImportService()
		user.current = [{ _id: '9'.repeat(24), login: 'b', company: 'c1', password: 'hash-b' }]
		await service.importCompanyData('c1', dump(), { _id: '9'.repeat(24), login: 'b' } as any)
		expect(user.insertMany.mock.calls[0][0].map((u) => u.password)).toEqual([undefined, 'hash-b'])
	})

	it('refused before anything is deleted: the importer would be left without a login', async () => {
		for (const current of [[], [{ _id: U2, login: 'b', company: 'c1', password: 'h' }]]) {
			const { service, user, all } = makeImportService()
			user.current = current
			const e = await service.importCompanyData('c1', dump(), { _id: U1, login: 'a' } as any).catch((err) => err)
			expect(e).toBeInstanceOf(BadRequestException)
			expect(e.message).toMatch(/^Импорт отменён/)
			nothingDeleted(all)
		}
	})

	it('refused before anything is deleted: malformed or repeated _id, _id or login taken outside the company', async () => {
		const broken = [
			dump({ orders: [{ _id: 'not-an-id' }] }),
			dump({ orders: [{ _id: O1 }, { _id: O1 }] }),
		]
		for (const d of broken) {
			const { service, all } = makeImportService()
			const e = await service.importCompanyData('c1', d).catch((err) => err)
			expect(e.message).toBe('Повреждённый дамп: в «orders» неверный или повторяющийся _id')
			nothingDeleted(all)
		}
		const taken = makeImportService()
		taken.order.foreign = 1
		expect((await taken.service.importCompanyData('c1', dump()).catch((err) => err)).message).toBe('В дампе обнаружены записи другой компании')
		nothingDeleted(taken.all)
		expect(taken.order.countDocuments.mock.calls[0][0]).toEqual({ _id: { $in: [O1] }, company: { $ne: 'c1' } })
	})

	it('full: known user keeps the current password; ids are checked for shape only', async () => {
		const { service, user } = makeImportService()
		user.current = [{ _id: U2, login: 'b', password: 'hash-now' }]
		const superUsers = dumpUsers.map((u) => ({ ...u, isSuperAdmin: true }))
		await service.importFullData({ _meta: { type: 'full' }, users: superUsers }, 'i-know-what-i-am-doing', { _id: U2, login: 'b' } as any)
		expect(user.find.mock.invocationCallOrder[0]).toBeLessThan(user.deleteMany.mock.invocationCallOrder[0])
		expect(user.insertMany.mock.calls[0][0].map((u) => u.password)).toEqual([undefined, 'hash-now'])
		expect(user.countDocuments).not.toHaveBeenCalled()
	})

	it('full: refused when the importing super admin would not stay a super admin', async () => {
		for (const isSuperAdmin of [true, false]) {
			const { service, user, all } = makeImportService()
			user.current = [{ _id: U2, login: 'b', password: 'hash-now' }]
			const e = await service
				.importFullData({ _meta: { type: 'full' }, users: [{ _id: U2, login: 'b', isSuperAdmin }] }, 'i-know-what-i-am-doing', { _id: U2, login: 'b' } as any)
				.catch((err) => err)
			if (isSuperAdmin) expect(user.insertMany).toHaveBeenCalledTimes(1)
			else {
				expect(e.message).toMatch(/^Импорт отменён/)
				nothingDeleted(all)
			}
		}
	})

	it('refused before anything is deleted: a record the schema rejects, a repeated login or role name', async () => {
		const bad = makeImportService()
		bad.role.validate.mockRejectedValueOnce(new Error('`nope` is not a valid enum value'))
		expect((await bad.service.importCompanyData('c1', dump()).catch((err) => err)).message).toBe('Повреждённый дамп: запись в «roles» не проходит проверку — `nope` is not a valid enum value')
		nothingDeleted(bad.all)
		for (const extra of [{ users: [dumpUsers[0], { ...dumpUsers[1], login: 'a' }] }, { roles: [{ _id: R1, name: 'r' }, { _id: 'c'.repeat(24), name: 'r' }] }]) {
			const { service, all } = makeImportService()
			expect((await service.importCompanyData('c1', dump(extra)).catch((err) => err)).message).toBe('Повреждённый дамп: повторяется логин пользователя или название роли')
			nothingDeleted(all)
		}
	})
})

describe('full import', () => {
	it('applies the same picture checks and shape check', async () => {
		const { service, product, photo } = makeImportService()
		await service.importFullData({ _meta: { type: 'full' }, products: productsWith, productPhotos: smuggled }, 'i-know-what-i-am-doing')
		expect(photo.insertMany.mock.calls[0][0].map((p) => p.token)).toEqual([T3])
		expect(product.insertMany.mock.calls[0][0].map((p) => p.photo)).toEqual([null, null, T3])
		const bad = makeImportService()
		const e = await bad.service.importFullData({ _meta: { type: 'full' }, companies: 'x' }, 'i-know-what-i-am-doing').catch((err) => err)
		expect(e.message).toBe('Повреждённый дамп: «companies» должно быть списком записей')
		for (const m of bad.all) expect(m.deleteMany).not.toHaveBeenCalled()
	})
})

describe('фото своих позиций «Моего склада» в выгрузке и импорте', () => {
	it('в выгрузку не идут; импорт их не берёт и не стирает; ключи пропавших фото у позиций склада обнуляются', async () => {
		const { service, photo, cabinet, user } = makeImportService()
		user.current = [{ _id: 'u1', login: 'adm', company: 'c1', password: 'h' }]
		photo.tokens = [T1]
		const dump = {
			_meta: { type: 'company' },
			users: [{ _id: '64a000000000000000000001', login: 'adm', company: 'c1' }],
			productPhotos: [
				{ token: T1, data: PNG.toString('base64') },
				{ token: T3, data: PNG.toString('base64'), user: 'u7' },
			],
		}
		await service.importCompanyData('c1', dump, { _id: '64a000000000000000000001', login: 'adm' } as any)
		expect(photo.insertMany.mock.calls[0][0].map((p: any) => p.token)).toEqual([T1])
		expect(photo.deleteMany).toHaveBeenCalledWith({ user: null })
		expect(cabinet.updateMany).toHaveBeenCalledWith({ photo: { $ne: null, $nin: [T1] } }, { photo: null })
	})

	it('выгрузка местности берёт только общие фото товаров', async () => {
		const find = jest.fn(() => ({ select: () => ({ exec: async () => [] }), exec: async () => [] }))
		const m: any = { find }
		const service = new DatabaseService(m, m, m, m, m, m, m, m, m, m, m, m, { emit: jest.fn() } as any, m)
		await service.exportCompanyData()
		expect(find.mock.calls.some((c: any[]) => c[0]?.user === null)).toBe(true)
	})
})
