/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { seedKindCovers, seedProducts } from './seeds.service'

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
