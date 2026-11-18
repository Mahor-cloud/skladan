/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { BadRequestException, NotFoundException } from '@nestjs/common'
import { imageType, ProductsService, renamedKindCovers, withKindCover } from './products.service'

// Подмена запроса mongoose: .select()/.lean() возвращают себя, .exec() отдаёт значение
const q = (value: any) => {
	const query: any = { exec: async () => value }
	query.select = () => query
	query.lean = () => query
	return query
}

const pad = (head: number[]) => Buffer.from([...head, ...new Array(16).fill(0)])

describe('imageType', () => {
	it('recognises JPEG, PNG and WebP by signature', () => {
		expect(imageType(pad([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
		expect(imageType(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
		const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 '), Buffer.alloc(8)])
		expect(imageType(webp)).toBe('image/webp')
	})

	it('rejects other files whatever their name or declared type', () => {
		expect(imageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull()
		expect(imageType(pad([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBeNull() // GIF
		expect(imageType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(8)]))).toBeNull()
		expect(imageType(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull() // короче любой картинки
		expect(imageType(undefined)).toBeNull()
	})
})

describe('kind covers', () => {
	const list = [
		{ category: 'Книги', cover: 'book' },
		{ category: 'Брошюры т.1', cover: 'leaflet' },
	]

	it('withKindCover replaces, adds and removes one entry', () => {
		expect(withKindCover(list, 'Книги', 'box')).toEqual([
			{ category: 'Брошюры т.1', cover: 'leaflet' },
			{ category: 'Книги', cover: 'box' },
		])
		expect(withKindCover(list, 'Новое', 'pack')).toHaveLength(3)
		expect(withKindCover(list, 'Книги', null)).toEqual([{ category: 'Брошюры т.1', cover: 'leaflet' }])
	})

	it('rename moves the cover to the new name', () => {
		expect(renamedKindCovers(list, 'Книги', 'Литература')).toEqual([
			{ category: 'Брошюры т.1', cover: 'leaflet' },
			{ category: 'Литература', cover: 'book' },
		])
	})

	it('merge into an existing kind keeps the target cover', () => {
		expect(renamedKindCovers(list, 'Книги', 'Брошюры т.1')).toEqual([{ category: 'Брошюры т.1', cover: 'leaflet' }])
	})

	it('rename of a kind without cover leaves the list as is', () => {
		expect(renamedKindCovers(list, 'Прочее', 'Книги')).toBe(list)
	})
})

function makeService(opts: { activeInventory?: any; matched?: number; covers?: any[] } = {}) {
	const productModel: any = {
		updateMany: jest.fn(() => q({ matchedCount: opts.matched ?? 0, modifiedCount: opts.matched ?? 0 })),
	}
	const inventoryModel: any = { findOne: jest.fn(() => q(opts.activeInventory ?? null)) }
	const messageModel: any = {
		findOne: jest.fn(() => q(opts.covers ? { kindCovers: opts.covers } : null)),
		updateOne: jest.fn(() => q(undefined)),
	}
	const history: any = { createChangeHistory: jest.fn(async () => ({})) }
	const realtime: any = { emit: jest.fn() }
	const service = new ProductsService(productModel, {} as any, inventoryModel, history, {} as any, messageModel, realtime)
	return { service, productModel, messageModel, history }
}

const user: any = { _id: 'u1', name: 'Кладовщик', role: {} }

async function caught(p: Promise<any>): Promise<any> {
	try {
		await p
	} catch (e) {
		return e
	}
	throw new Error('expected a rejection')
}

describe('renameKind', () => {
	it('empty or unchanged name is 400 and touches nothing', async () => {
		const { service, productModel } = makeService({ matched: 3 })
		expect(await caught(service.renameKind({ from: 'Книги', to: '   ' }, user))).toBeInstanceOf(BadRequestException)
		expect(await caught(service.renameKind({ from: '', to: 'Книги' }, user))).toBeInstanceOf(BadRequestException)
		const same = await caught(service.renameKind({ from: 'Книги', to: ' Книги ' }, user))
		expect(same.message).toBe('Новое название вида совпадает с прежним')
		expect(productModel.updateMany).not.toHaveBeenCalled()
	})

	it('is refused during an inventory, like editing a product', async () => {
		const { service, productModel } = makeService({ matched: 3, activeInventory: { _id: 'i1' } })
		const e = await caught(service.renameKind({ from: 'Книги', to: 'Литература' }, user))
		expect(e.getResponse().code).toBe('ACTIVE_INVENTORY')
		expect(productModel.updateMany).not.toHaveBeenCalled()
	})

	it('merges into an existing kind: all products of the company, deleted included, one history entry', async () => {
		const covers = [
			{ category: 'Книги', cover: 'book' },
			{ category: 'Литература', cover: 'shelf' },
		]
		const { service, productModel, messageModel, history } = makeService({ matched: 4, covers })
		const res = await service.renameKind({ from: 'Книги', to: 'Литература ' }, user)
		expect(productModel.updateMany).toHaveBeenCalledWith({ category: 'Книги' }, { $set: { category: 'Литература' } })
		expect(messageModel.updateOne).toHaveBeenCalledWith(
			{},
			{ $set: { kindCovers: [{ category: 'Литература', cover: 'shelf' }] } },
			{ upsert: true }
		)
		expect(res).toEqual({ modified: 4, covers: { Литература: 'shelf' } })
		expect(history.createChangeHistory).toHaveBeenCalledTimes(1)
		expect(history.createChangeHistory.mock.calls[0][0]).toMatchObject({
			changeType: 'product-updated',
			description: 'Кладовщик: Товары вида Книги обновлены (4). Изменения: Категория изменена с Книги на Литература',
		})
	})

	it('unknown kind is 404 without a history entry', async () => {
		const { service, history, messageModel } = makeService({ matched: 0 })
		expect(await caught(service.renameKind({ from: 'Нет такого', to: 'Книги' }, user))).toBeInstanceOf(NotFoundException)
		expect(messageModel.updateOne).not.toHaveBeenCalled()
		expect(history.createChangeHistory).not.toHaveBeenCalled()
	})
})

function makePhotoService(opts: { product?: any; usedBytes?: number; stored?: any; covers?: any[] } = {}) {
	const productModel: any = {
		findOne: jest.fn(() => q(opts.product ?? null)),
		findByIdAndUpdate: jest.fn(() => q({ photo: opts.product?.photo, toObject: () => ({ _id: 'p1' }) })),
	}
	const photoModel: any = {
		aggregate: jest.fn(() => q(opts.usedBytes == null ? [] : [{ bytes: opts.usedBytes }])),
		create: jest.fn(async () => ({})),
		deleteOne: jest.fn(() => q({})),
		findOne: jest.fn(() => q(opts.stored ?? null)),
	}
	const messageModel: any = {
		findOne: jest.fn(() => q(opts.covers ? { kindCovers: opts.covers } : null)),
		updateOne: jest.fn(() => q(undefined)),
	}
	const realtime: any = { emit: jest.fn() }
	const service = new ProductsService(productModel, {} as any, {} as any, {} as any, photoModel, messageModel, realtime)
	return { service, productModel, photoModel, messageModel }
}

const QUOTA = 30 * 1024 * 1024
const png = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('setPhoto limits', () => {
	it('company quota: over 30 MB is 413 with Russian text, nothing stored; the photo being replaced is not counted', async () => {
		const { service, photoModel } = makePhotoService({ product: { company: 'c1', photo: 'old' }, usedBytes: QUOTA - png.length + 1 })
		const e = await caught(service.setPhoto('p1', png))
		expect(e.getStatus()).toBe(413)
		expect(e.message).toBe('Превышен объём фото местности')
		expect(photoModel.aggregate.mock.calls[0][0][0]).toEqual({ $match: { company: 'c1', token: { $ne: 'old' } } })
		expect(photoModel.create).not.toHaveBeenCalled()
	})

	it('exactly at the quota is still accepted', async () => {
		const { service, photoModel } = makePhotoService({ product: { company: 'c1' }, usedBytes: QUOTA - png.length })
		await service.setPhoto('p1', png)
		expect(photoModel.create).toHaveBeenCalledTimes(1)
	})

	it('only a product that is not deleted can get a photo', async () => {
		const { service, productModel, photoModel } = makePhotoService({ product: null })
		expect(await caught(service.setPhoto('p1', png))).toBeInstanceOf(NotFoundException)
		expect(productModel.findOne).toHaveBeenCalledWith({ _id: 'p1', deletedAt: null })
		expect(photoModel.create).not.toHaveBeenCalled()
	})
})

describe('getPhoto', () => {
	it('serves only image types: anything else in the base is 404', async () => {
		expect(await caught(makePhotoService({ stored: { contentType: 'text/html' } }).service.getPhoto('t'))).toBeInstanceOf(NotFoundException)
		expect(await makePhotoService({ stored: { contentType: 'image/webp' } }).service.getPhoto('t')).toEqual({ contentType: 'image/webp' })
	})
})

describe('kind covers limit', () => {
	const full = Array.from({ length: 500 }, (_, i) => ({ category: `Вид ${i}`, cover: 'box' }))

	it('501st kind is refused with a clear text, nothing saved', async () => {
		const { service, messageModel } = makePhotoService({ covers: full })
		const e = await caught(service.setKindCover({ category: 'Ещё один', cover: 'box' }))
		expect(e).toBeInstanceOf(BadRequestException)
		expect(e.message).toBe('Слишком много обложек видов: не больше 500')
		expect(messageModel.updateOne).not.toHaveBeenCalled()
	})

	it('changing an existing cover at the limit is allowed', async () => {
		const { service, messageModel } = makePhotoService({ covers: full })
		await service.setKindCover({ category: 'Вид 7', cover: 'book' })
		expect(messageModel.updateOne).toHaveBeenCalledTimes(1)
	})
})
