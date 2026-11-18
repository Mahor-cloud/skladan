/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { priceHistory, restorePrices } from './013-freeze-line-prices'

const rec = (changeDate: number, name: string, changes: string) => ({
	changeDate,
	description: `Председатель: Товар ${name} обновлен. Изменения: ${changes}`,
})

describe('priceHistory', () => {
	const products = [
		{ _id: 'a', name: 'Брелок 30 дней' },
		{ _id: 'b', name: 'Белый буклет (удалён 01.02.2026)' },
		{ _id: 'c', name: 'Двойник' },
		{ _id: 'd', name: 'Двойник' },
	]

	it('собирает смены цены по товарам от новых к старым, удалённый товар узнаётся по названию без пометки', () => {
		const history = priceHistory(products, [
			rec(300, 'Брелок 30 дней', 'Цена изменена с 40 на 50'),
			rec(200, 'Белый буклет', 'Цена изменена с 10 на 15, Количество изменено с 1 на 2'),
			rec(100, 'Брелок 30 дней', 'Цена изменена с 30 на 40'),
		])
		expect(history.get('a')).toEqual([
			{ at: 300, from: 40, to: 50 },
			{ at: 100, from: 30, to: 40 },
		])
		expect(history.get('b')).toEqual([{ at: 200, from: 10, to: 15 }])
	})

	it('удалённый товар с прежней пометкой «_удален_<дата>» тоже узнаётся', () => {
		const history = priceHistory([{ _id: 'o', name: 'Старый буклет_удален_2026-03-01T10:00:00.000Z' }], [rec(100, 'Старый буклет', 'Цена изменена с 5 на 7')])
		expect(history.get('o')).toEqual([{ at: 100, from: 5, to: 7 }])
	})

	it('идёт за переименованием: старые записи под прежним названием относятся к тому же товару', () => {
		const history = priceHistory(products, [
			rec(300, 'Брелок 30 дней', 'Название изменено с Брелок, 30 на Брелок 30 дней, Цена изменена с 40 на 50'),
			rec(100, 'Брелок, 30', 'Цена изменена с 30 на 40'),
		])
		expect(history.get('a')).toEqual([
			{ at: 300, from: 40, to: 50 },
			{ at: 100, from: 30, to: 40 },
		])
	})

	it('название, которое носят два товара, и посторонние записи пропускаются', () => {
		const history = priceHistory(products, [
			rec(300, 'Двойник', 'Цена изменена с 1 на 2'),
			rec(200, 'Нет такого', 'Цена изменена с 1 на 2'),
			{ changeDate: 100, description: 'Заказ 5 создан.' },
			{ changeDate: 90 },
		])
		expect(history.size).toBe(0)
	})
})

describe('restorePrices', () => {
	const current = new Map([
		['a', 50],
		['b', 15],
	])
	const history = new Map([
		[
			'a',
			[
				{ at: 300, from: 40, to: 50 },
				{ at: 100, from: 30, to: 40 },
			],
		],
		['b', [{ at: 200, from: 10, to: 15 }]],
	])
	const items = [
		{ product: 'a', quantity: 2, confirmedQuantity: 1 },
		{ product: 'b', quantity: 1, confirmedQuantity: 1 },
	]
	const sum = (total: number): [string, number][] => [['quantity', total]]

	it('сумма сходится по текущим ценам — они и записываются', () => {
		expect([...restorePrices(items, sum(115), 0, current, history)]).toEqual([
			['a', 50],
			['b', 15],
		])
	})

	it('сумма сходится по ценам одного прошлого момента', () => {
		// между сменами 200 и 300: a = 40, b = 15
		expect([...restorePrices(items, sum(95), 0, current, history)]).toEqual([
			['a', 40],
			['b', 15],
		])
		// до первой смены: a = 30, b = 10
		expect([...restorePrices(items, sum(70), 0, current, history)]).toEqual([
			['a', 30],
			['b', 10],
		])
	})

	it('цены разных моментов не смешиваются, сумма без подходящего момента — отказ', () => {
		// a = 30 (до 100) вместе с b = 15 (после 200) не было никогда
		expect(restorePrices(items, sum(75), 0, current, history)).toBeNull()
		expect(restorePrices(items, sum(1), 0, current, history)).toBeNull()
	})

	it('состояния раньше создания документа не рассматриваются', () => {
		// документ создан в 250: a = 30 и b = 10 к этому времени уже ушли
		expect(restorePrices(items, sum(70), 250, current, history)).toBeNull()
		expect([...restorePrices(items, sum(95), 250, current, history)]).toEqual([
			['a', 40],
			['b', 15],
		])
	})

	it('закупка: должны сойтись обе суммы — заказанного и принятого', () => {
		const both = (total: number, confirmed: number): [string, number][] => [
			['quantity', total],
			['confirmedQuantity', confirmed],
		]
		expect([...restorePrices(items, both(95, 55), 0, current, history)]).toEqual([
			['a', 40],
			['b', 15],
		])
		expect(restorePrices(items, both(95, 65), 0, current, history)).toBeNull()
	})

	it('два разных состояния дают ту же сумму — отказ; одно и то же состояние в разные моменты — годится', () => {
		// x: 10 → 20, y: 20 → 10 в разное время; количество равное: суммы 30 дают три состояния, два из них разные
		const cur = new Map([
			['x', 20],
			['y', 10],
		])
		const hist = new Map([
			['x', [{ at: 100, from: 10, to: 20 }]],
			['y', [{ at: 200, from: 20, to: 10 }]],
		])
		const pair = [
			{ product: 'x', quantity: 1 },
			{ product: 'y', quantity: 1 },
		]
		expect(restorePrices(pair, sum(30), 0, cur, hist)).toBeNull()
		// цена ушла и вернулась (30 → 20 → 30): состояние то же
		const back = new Map([['z', [{ at: 300, from: 20, to: 30 }, { at: 200, from: 30, to: 20 }]]])
		expect([...restorePrices([{ product: 'z', quantity: 2 }], sum(60), 0, new Map([['z', 30]]), back)]).toEqual([['z', 30]])
	})

	it('строки без количества (в закупке лежат все товары) не создают неоднозначности и получают цену позднего состояния', () => {
		// b менял цену, но в закупке его 0 штук: оба состояния дают ту же сумму и считаются одним
		const purchase = [
			{ product: 'a', quantity: 2, confirmedQuantity: 2 },
			{ product: 'b', quantity: 0, confirmedQuantity: 0 },
		]
		const onlyB = new Map([['b', [{ at: 200, from: 10, to: 15 }]]])
		expect([...restorePrices(purchase, [['quantity', 100], ['confirmedQuantity', 100]], 0, current, onlyB)]).toEqual([
			['a', 50],
			['b', 15],
		])
	})

	it('товара нет в базе — цена 0, как считал прежний сервер', () => {
		expect([...restorePrices([{ product: 'gone', quantity: 3 }, { product: 'b', quantity: 1 }], sum(15), 0, current, history)]).toEqual([
			['gone', 0],
			['b', 15],
		])
	})
})
