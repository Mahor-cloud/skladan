/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { keptPrices, linesSum, priceLines } from './line-prices'

describe('keptPrices', () => {
	it('берёт записанные цены, товар — строкой, ObjectId или подставленным документом', () => {
		const kept = keptPrices([
			{ product: 'a', price: 30 },
			{ product: { _id: 'b', name: 'Книга' }, price: 0 },
			{ product: { toString: () => 'c' }, price: 12.5 },
		])
		expect([...kept]).toEqual([
			['a', 30],
			['b', 0],
			['c', 12.5],
		])
	})

	it('строки без цены (старые документы) и негодные значения пропускает', () => {
		expect(keptPrices([{ product: 'a' }, { product: 'b', price: null as any }, { product: 'c', price: '30' as any }]).size).toBe(0)
		expect(keptPrices(undefined).size).toBe(0)
	})
})

describe('priceLines', () => {
	const current = (id: string) => ({ a: 40, b: 15, c: 7 })[id] ?? 0
	const items = [
		{ product: 'a', quantity: 2 },
		{ product: 'b', quantity: 1 },
	]

	it('сумма не зафиксирована (неоплаченный заказ, закупка до оплаты): все строки по текущим ценам', () => {
		const lines = priceLines(items, new Map(), current)
		expect(lines).toEqual([
			{ product: 'a', quantity: 2, price: 40 },
			{ product: 'b', quantity: 1, price: 15 },
		])
		expect(linesSum(lines)).toBe(95)
	})

	it('оплаченный документ после смены цены: прежние товары по своей цене, добавленный — по текущей', () => {
		const kept = keptPrices([
			{ product: 'a', price: 30 },
			{ product: 'b', price: 10 },
		])
		const lines = priceLines([...items, { product: 'c', quantity: 3 }], kept, current)
		expect(lines.map((l) => l.price)).toEqual([30, 10, 7])
		expect(linesSum(lines)).toBe(2 * 30 + 10 + 21)
		// количество прежнего товара выросло — цена всё равно его прежняя
		expect(linesSum(priceLines([{ product: 'a', quantity: 5 }], kept, current))).toBe(150)
	})

	it('сумма не пересчитывается: записанные цены остаются, строке старого документа цена не назначается', () => {
		const lines = priceLines(items, keptPrices([{ product: 'a', price: 30 }]), () => undefined)
		expect(lines).toEqual([
			{ product: 'a', quantity: 2, price: 30 },
			{ product: 'b', quantity: 1 },
		])
		expect('price' in lines[1]).toBe(false)
	})

	it('в строку попадает только переданное: исходные объекты не меняются, цена 0 — тоже цена', () => {
		const source = [{ product: 'z', quantity: 1 }]
		const lines = priceLines(source, new Map(), current)
		expect(lines).toEqual([{ product: 'z', quantity: 1, price: 0 }])
		expect(source[0]).toEqual({ product: 'z', quantity: 1 })
	})

	it('суммы закупки: по заказанному и по принятому', () => {
		const lines = priceLines([{ product: 'a', quantity: 4, confirmedQuantity: 1 }], new Map(), current)
		expect(linesSum(lines)).toBe(160)
		expect(linesSum(lines, 'confirmedQuantity')).toBe(40)
	})
})
