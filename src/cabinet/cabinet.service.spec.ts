/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { Types } from 'mongoose'
import { PHOTO_QUOTA } from '../products/products.service'
import { CabinetService, OWN_PHOTO_QUOTA, USER_PHOTO_QUOTA } from './cabinet.service'
import { CreateCabinetItemDto } from './dto/create-cabinet-item.dto'
import { UpdateCabinetItemDto } from './dto/update-cabinet-item.dto'

// Подмена запроса mongoose: .select() возвращает себя, .exec() отдаёт значение
const q = (value: any) => {
	const query: any = { exec: async () => value }
	query.select = () => query
	return query
}

async function caught(p: Promise<any>): Promise<any> {
	try {
		await p
	} catch (e) {
		return e
	}
	throw new Error('expected a rejection')
}

const me = new Types.ObjectId()
const other = new Types.ObjectId()
const user: any = { _id: me }
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(16).fill(0)])

function make(opts: { item?: any; used?: any; before?: any } = {}) {
	const item = opts.item === undefined ? { company: 'c1', user: me, photo: 'old' } : opts.item
	const cabinetModel: any = {
		findOne: jest.fn(() => q(item)),
		findById: jest.fn(() => q(item && { ...item, save: jest.fn() })),
		findOneAndUpdate: jest.fn(() => q(opts.before === undefined ? { photo: item?.photo, toObject: () => ({ _id: 'i1' }) } : opts.before)),
		findByIdAndUpdate: jest.fn(() => q({ photo: item?.photo })),
	}
	// подсчёт видит записанные, но не удалённые картинки — как база (новая — своя, личная: во всех трёх суммах)
	const saved = new Map<string, number>()
	const photoModel: any = {
		aggregate: jest.fn(() => {
			const added = [...saved.values()].reduce((a, b) => a + b, 0)
			const used = opts.used || { all: 0, own: 0, mine: 0 }
			return q([{ all: (used.all || 0) + added, own: (used.own || 0) + added, mine: (used.mine || 0) + added }])
		}),
		create: jest.fn(async (doc: any) => saved.set(doc.token, doc.data.length)),
		deleteOne: jest.fn((f: any) => (saved.delete(f.token), q({}))),
	}
	const realtime: any = { emit: jest.fn() }
	const service = new CabinetService(cabinetModel, {} as any, {} as any, {} as any, realtime, photoModel)
	return { service, cabinetModel, photoModel }
}

describe('«Мой склад»: фото своей позиции', () => {
	it('хранится как фото товара, с владельцем; заменённое фото удаляется', async () => {
		const { service, photoModel, cabinetModel } = make()
		const res = await service.setPhoto('i1', png, user)
		expect(photoModel.create.mock.calls[0][0]).toMatchObject({ company: 'c1', user: me, contentType: 'image/png', data: png })
		const token = photoModel.create.mock.calls[0][0].token
		expect(cabinetModel.findOneAndUpdate).toHaveBeenCalledWith({ _id: 'i1', deletedAt: null }, { photo: token })
		expect(photoModel.deleteOne).toHaveBeenCalledWith({ token: 'old' })
		expect(res.photo).toBe(token)
		// нынешнее фото позиции в объём не входит
		expect(photoModel.aggregate.mock.calls[0][0][0]).toEqual({ $match: { company: 'c1', token: { $ne: 'old' } } })
	})

	it('не картинка — 400, ничего не сохраняется', async () => {
		const { service, photoModel } = make()
		expect(await caught(service.setPhoto('i1', Buffer.from('<svg></svg>'), user))).toBeInstanceOf(BadRequestException)
		expect(photoModel.create).not.toHaveBeenCalled()
	})

	it('квота: вся местность, все личные фото вместе и один человек — запись откатывается, 413', async () => {
		const cases: Array<[any, string]> = [
			[{ all: PHOTO_QUOTA - png.length + 1 }, 'Превышен объём фото местности'],
			[{ all: 0, own: OWN_PHOTO_QUOTA - png.length + 1 }, 'Превышен объём фото личных складов местности'],
			[{ all: 0, own: 0, mine: USER_PHOTO_QUOTA - png.length + 1 }, 'Превышен объём ваших фото в «Моём складе»'],
		]
		for (const [used, text] of cases) {
			const { service, photoModel, cabinetModel } = make({ used })
			const e = await caught(service.setPhoto('i1', png, user))
			expect(e.getStatus()).toBe(413)
			expect(e.message).toBe(text)
			expect(photoModel.create.mock.invocationCallOrder[0]).toBeLessThan(photoModel.aggregate.mock.invocationCallOrder[0])
			expect(photoModel.deleteOne).toHaveBeenCalledWith({ token: photoModel.create.mock.calls[0][0].token })
			expect(cabinetModel.findOneAndUpdate).not.toHaveBeenCalled()
		}
	})

	it('ровно на каждом пределе — ещё принимается', async () => {
		const { service, photoModel } = make({ used: { all: PHOTO_QUOTA - png.length, own: OWN_PHOTO_QUOTA - png.length, mine: USER_PHOTO_QUOTA - png.length } })
		await service.setPhoto('i1', png, user)
		expect(photoModel.create).toHaveBeenCalledTimes(1)
		expect(photoModel.deleteOne).not.toHaveBeenCalledWith({ token: photoModel.create.mock.calls[0][0].token })
	})

	it('личный объём и объём человека считаются по владельцу позиции', async () => {
		const { service, photoModel } = make()
		await service.setPhoto('i1', png, user)
		const group = photoModel.aggregate.mock.calls[0][0][1].$group
		expect(group.own.$sum.$cond[0]).toEqual({ $gt: ['$user', null] })
		expect(group.mine.$sum.$cond[0]).toEqual({ $eq: ['$user', me] })
	})

	it('чужая позиция: 403 на загрузку и удаление, ничего не сохраняется и не удаляется', async () => {
		const { service, photoModel, cabinetModel } = make({ item: { company: 'c1', user: other, photo: 'theirs' } })
		expect(await caught(service.setPhoto('i1', png, user))).toBeInstanceOf(ForbiddenException)
		expect(await caught(service.removePhoto('i1', user))).toBeInstanceOf(ForbiddenException)
		expect(photoModel.create).not.toHaveBeenCalled()
		expect(photoModel.deleteOne).not.toHaveBeenCalled()
		expect(cabinetModel.findOneAndUpdate).not.toHaveBeenCalled()
	})

	it('позиция из каталога остаётся с обложкой товара: 400', async () => {
		const { service, photoModel } = make({ item: { company: 'c1', user: me, product: 'p1' } })
		expect(await caught(service.setPhoto('i1', png, user))).toBeInstanceOf(BadRequestException)
		expect(photoModel.create).not.toHaveBeenCalled()
	})

	it('удалённая или несуществующая позиция — 404', async () => {
		const { service, cabinetModel, photoModel } = make({ item: null })
		expect(await caught(service.setPhoto('i1', png, user))).toBeInstanceOf(NotFoundException)
		expect(cabinetModel.findOne).toHaveBeenCalledWith({ _id: 'i1', deletedAt: null })
		expect(photoModel.create).not.toHaveBeenCalled()
	})

	it('позицию удалили между проверкой и записью: новое фото удаляется, 404', async () => {
		const { service, photoModel } = make({ before: null })
		expect(await caught(service.setPhoto('i1', png, user))).toBeInstanceOf(NotFoundException)
		const token = photoModel.create.mock.calls[0][0].token
		expect(photoModel.deleteOne).toHaveBeenCalledWith({ token })
	})

	it('удаление фото снимает ключ и удаляет картинку', async () => {
		const { service, cabinetModel, photoModel } = make()
		await service.removePhoto('i1', user)
		expect(cabinetModel.findOneAndUpdate).toHaveBeenCalledWith({ _id: 'i1', deletedAt: null }, { photo: null })
		expect(photoModel.deleteOne).toHaveBeenCalledWith({ token: 'old' })
	})
})

describe('«Мой склад»: удаление позиции', () => {
	it('удаляет и её фото', async () => {
		const { service, cabinetModel, photoModel } = make()
		const res = await service.softDelete('i1', user)
		const [id, upd] = cabinetModel.findByIdAndUpdate.mock.calls[0]
		expect(id).toBe('i1')
		expect(upd).toMatchObject({ photo: null })
		expect(upd.deletedAt).toBeInstanceOf(Date)
		expect(photoModel.deleteOne).toHaveBeenCalledWith({ token: 'old' })
		expect(res.photo).toBeNull()
	})

	it('без фото картинки не удаляет', async () => {
		const { service, photoModel } = make({ item: { company: 'c1', user: me } })
		await service.softDelete('i1', user)
		expect(photoModel.deleteOne).not.toHaveBeenCalled()
	})

	it('чужая позиция: 403, её фото остаётся', async () => {
		const { service, cabinetModel, photoModel } = make({ item: { company: 'c1', user: other, photo: 'theirs' } })
		expect(await caught(service.softDelete('i1', user))).toBeInstanceOf(ForbiddenException)
		expect(cabinetModel.findByIdAndUpdate).not.toHaveBeenCalled()
		expect(photoModel.deleteOne).not.toHaveBeenCalled()
	})
})

describe('«Мой склад»: цвет обложки', () => {
	it('своя позиция принимает цвет, позиция из каталога его не берёт', async () => {
		const own: any = { user: me, save: jest.fn() }
		const catalog: any = { user: me, product: 'p1', save: jest.fn() }
		for (const item of [own, catalog]) {
			const { service, cabinetModel } = make()
			cabinetModel.findById = jest.fn(() => q(item))
			await service.update('i1', { coverColor: '#0147B9' }, user)
		}
		expect(own.coverColor).toBe('#0147B9')
		expect(catalog.coverColor).toBeUndefined()
	})
})

describe('«Мой склад»: тип обложки', () => {
	const errors = async (cls: any, body: any) => (await validate(plainToInstance(cls, body))).map((e) => e.property)

	it('тип как у вида — принимается; пусто и null — обложка по умолчанию', async () => {
		for (const cls of [CreateCabinetItemDto, UpdateCabinetItemDto]) {
			const base = cls === CreateCabinetItemDto ? { baseQty: 1, currentQty: 0 } : {}
			for (const cover of ['book', 'hardbook', 'keytag', null]) expect(await errors(cls, { ...base, cover })).toEqual([])
			expect(plainToInstance(cls, { ...base, cover: '' }).cover).toBeNull()
		}
	})

	it('чужой формат — 400 по полю cover', async () => {
		for (const cls of [CreateCabinetItemDto, UpdateCabinetItemDto]) {
			const base = cls === CreateCabinetItemDto ? { baseQty: 1, currentQty: 0 } : {}
			for (const cover of ['Book', '<svg onload=x>', 'a'.repeat(33), 'book cover', 5]) expect(await errors(cls, { ...base, cover })).toEqual(['cover'])
		}
	})

	it('правка: своя позиция принимает тип и сбрасывает его null, позиция из каталога не берёт', async () => {
		const own: any = { user: me, save: jest.fn() }
		const catalog: any = { user: me, product: 'p1', save: jest.fn() }
		for (const item of [own, catalog]) {
			const { service, cabinetModel } = make()
			cabinetModel.findById = jest.fn(() => q(item))
			await service.update('i1', { cover: 'medal' }, user)
		}
		expect(own.cover).toBe('medal')
		expect(catalog.cover).toBeUndefined()
		const { service, cabinetModel } = make()
		cabinetModel.findById = jest.fn(() => q(own))
		await service.update('i1', { cover: null }, user)
		expect(own.cover).toBeNull()
	})

	it('создание: тип пишется только у своей позиции', async () => {
		const Model: any = jest.fn(function (this: any, doc: any) {
			Object.assign(this, doc)
			this.save = jest.fn()
		})
		Model.findOne = jest.fn(() => q(null))
		const productModel: any = { findById: jest.fn(() => q({ _id: 'p1' })) }
		const service = new CabinetService(Model, productModel, {} as any, {} as any, { emit: jest.fn() } as any, {} as any)
		const own: any = await service.createOrUpsert({ customName: 'Своё', baseQty: 1, currentQty: 0, cover: 'keytag' }, user)
		const fromCatalog: any = await service.createOrUpsert({ product: 'p1', baseQty: 1, currentQty: 0, cover: 'keytag' }, user)
		expect(own.cover).toBe('keytag')
		expect(fromCatalog.cover).toBeUndefined()
	})

	it('список «Моего склада» отдаёт у своей позиции тип, цвет и фото', async () => {
		const custom = { _id: 'c1', customName: 'Своё', baseQty: 1, currentQty: 0, cover: 'medal', coverColor: '#0147B9', photo: 'f'.repeat(32) }
		const service = new CabinetService(
			{ find: jest.fn(() => q([custom])) } as any,
			{ find: jest.fn(() => q([])) } as any,
			{ aggregate: jest.fn(() => q([])) } as any,
			{} as any,
			{ emit: jest.fn() } as any,
			{} as any
		)
		const [row]: any[] = await service.listMerged(user)
		expect(row).toMatchObject({ isCustom: true, cover: 'medal', coverColor: '#0147B9', photo: 'f'.repeat(32) })
	})
})
