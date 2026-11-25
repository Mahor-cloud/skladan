/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { seedKindCovers, seedProducts, SeedsService } from './seeds.service'

describe('seedKindCovers', () => {
	const kinds = new Set(['Книга', 'Брелок'])

	it('оставляет обложки только видов, которые есть в шаблоне', () => {
		expect(
			seedKindCovers(
				[
					{ category: 'Книга', cover: 'hardbook' },
					{ category: 'Удалённый вид', cover: 'box' },
				],
				kinds
			)
		).toEqual([{ category: 'Книга', cover: 'hardbook' }])
	})

	it('отбрасывает негодные записи, из повторов берёт последнюю', () => {
		expect(
			seedKindCovers(
				[
					{ category: 'Книга', cover: 'book' },
					{ category: 'Книга', cover: 'brochure' },
					{ category: 'Брелок', cover: '<svg>' },
					{ category: 'Брелок' },
					null,
					'Книга',
				],
				kinds
			)
		).toEqual([{ category: 'Книга', cover: 'brochure' }])
		expect(seedKindCovers({ category: 'Книга', cover: 'book' }, kinds)).toEqual([])
		expect(seedKindCovers(undefined, kinds)).toEqual([])
	})
})

describe('seedProducts', () => {
	const photo = 'a'.repeat(32)
	const previous: any = [
		{ name: 'Книга', category: 'Книга', price: 100, targetQty: 0, coverColor: '#7A2140', photo },
		{ name: 'Брелок', category: 'Брелок', price: 30, targetQty: 0 },
	]

	it('новый клиент: цвет и фото берутся из запроса, негодные отбрасываются', () => {
		const out = seedProducts(
			[
				{ name: ' Книга ', category: 'Книга', price: '120', coverColor: '#0147B9', photo: 'b'.repeat(32) },
				{ name: 'Брелок', category: 'Брелок', price: 30, coverColor: 'red', photo: '../etc' },
				{ name: 'Без обложки', price: 'x' },
			],
			previous,
			false
		)
		expect(out[0]).toEqual({ name: 'Книга', category: 'Книга', price: 120, targetQty: 0, coverColor: '#0147B9', photo: 'b'.repeat(32) })
		expect(out[1]).toMatchObject({ coverColor: undefined, photo: undefined })
		expect(out[2]).toEqual({ name: 'Без обложки', category: '', price: 0, targetQty: 0, coverColor: undefined, photo: undefined })
	})

	it('новый клиент убрал фото и цвет — они убираются', () => {
		expect(seedProducts([{ name: 'Книга', category: 'Книга', price: 100, coverColor: '', photo: '' }], previous, false)[0]).toMatchObject({
			coverColor: undefined,
			photo: undefined,
		})
	})

	it('пара на lit-na.ru: число или null из запроса; поля нет — остаётся прежняя; негодное — не задано', () => {
		const before: any = [{ name: 'Книга', litnaId: 12941 }, { name: 'Брелок', litnaId: null }]
		const out = seedProducts(
			[
				{ name: 'Книга' },
				{ name: 'Брелок', litnaId: 7 },
				{ name: 'Новый', litnaId: null },
				{ name: 'Кривой', litnaId: 0 },
				{ name: 'Строкой', litnaId: '5' },
			],
			before,
			false
		)
		expect(out.map((p) => p.litnaId)).toEqual([12941, 7, null, undefined, undefined])
	})

	it('клиент прежней версии: цвет и фото остаются от товара с тем же названием', () => {
		const out = seedProducts(
			[
				{ name: 'Книга', category: 'Книга', price: 150 },
				{ name: 'Новый', category: 'Книга', price: 10, photo: 'c'.repeat(32) },
			],
			previous,
			true
		)
		expect(out[0]).toMatchObject({ price: 150, coverColor: '#7A2140', photo })
		expect(out[1]).toMatchObject({ coverColor: undefined, photo: undefined })
	})
})

describe('applySeedsToCompany', () => {
	it('пара на lit-na.ru из шаблона копируется в товары новой местности', async () => {
		const q = (v: any) => ({ exec: async () => v, setOptions: () => q(v) })
		const inserted: any[] = []
		const doc = { roles: [], products: [{ name: 'Книга', category: 'Книга', price: 100, litnaId: 12941 }, { name: 'Брелок', price: 30, litnaId: null }, { name: 'Ручка', price: 5 }] }
		const svc = new SeedsService(
			{ findOne: () => q(doc) } as any,
			{} as any,
			{ insertMany: async (rows: any[]) => inserted.push(...rows) } as any,
			{ find: () => q([]) } as any,
			{ insertMany: async () => null } as any,
			{} as any
		)
		await svc.applySeedsToCompany('64a0000000000000000000c1', { seedProducts: true })
		expect(inserted.map((p) => [p.name, p.litnaId])).toEqual([['Книга', 12941], ['Брелок', null], ['Ручка', undefined]])
	})
})

describe('applySeedsToCompany со своими товарами (засев с lit-na.ru)', () => {
	it('товары и обложки видов — переданные, а не из шаблона; роли — из шаблона', async () => {
		const q = (v: any) => ({ exec: async () => v, setOptions: () => q(v) })
		const inserted: any[] = []
		const roles: any[] = []
		const covers: any[] = []
		const doc = { roles: [{ name: 'Кладовщик', permissions: [] }], products: [{ name: 'Из шаблона', price: 1 }], kindCovers: [{ category: 'Книга', cover: 'book' }] }
		const svc = new SeedsService(
			{ findOne: () => q(doc) } as any,
			{ insertMany: async (rows: any[]) => roles.push(...rows) } as any,
			{ insertMany: async (rows: any[]) => inserted.push(...rows) } as any,
			{ find: () => q([]) } as any,
			{ insertMany: async () => null } as any,
			{ updateOne: (_f: any, u: any) => (covers.push(u.$set.kindCovers), q(null)) } as any
		)
		const result = await svc.applySeedsToCompany('64a0000000000000000000c1', {
			seedRoles: true,
			seedProducts: true,
			products: [{ name: 'Базовый текст', category: 'Книги', price: 450, targetQty: 0, litnaId: 12 }],
			kindCovers: [{ category: 'Книги', cover: 'book' }],
		})
		expect(inserted.map((p) => [p.name, p.category, p.price, p.quantity, p.litnaId])).toEqual([['Базовый текст', 'Книги', 450, 0, 12]])
		expect(covers).toEqual([[{ category: 'Книги', cover: 'book' }]])
		expect(roles.map((r) => r.name)).toEqual(['Кладовщик'])
		expect(result).toEqual({ rolesCreated: 1, productsCreated: 1 })
	})
})
