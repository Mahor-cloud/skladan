/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { priceBefore } from './013-freeze-line-prices'
import { completedAt } from './014-freeze-inventory-prices'

describe('completedAt', () => {
	it('самая ранняя запись о завершении между началом этой инвентаризации и началом следующей', () => {
		expect(completedAt(1000, 6000, [5000, 3000, 7000, 500])).toBe(3000)
	})

	it('запись о завершении следующей инвентаризации или более ранняя не годится — тогда дата начала', () => {
		expect(completedAt(1000, 6000, [500, 6000, 7000])).toBe(1000)
		expect(completedAt(1000, Infinity, [])).toBe(1000)
	})

	it('у последней инвентаризации верхней границы нет', () => {
		expect(completedAt(1000, Infinity, [9000])).toBe(9000)
	})
})

describe('цена на момент завершения инвентаризации', () => {
	const current = new Map([['a', 50]])
	const history = new Map([
		[
			'a',
			[
				{ at: 300, from: 40, to: 50 },
				{ at: 100, from: 30, to: 40 },
			],
		],
	])
	const at = (done: number) => priceBefore('a', done + 1, current, history)

	it('смены цены после завершения отматываются, случившиеся до него и в его момент — действуют', () => {
		expect(at(50)).toBe(30)
		expect(at(100)).toBe(40)
		expect(at(299)).toBe(40)
		expect(at(300)).toBe(50)
		expect(at(9999)).toBe(50)
	})

	it('товара нет в истории — нынешняя цена; нет и в базе — 0', () => {
		expect(priceBefore('b', 1, new Map([['b', 7]]), history)).toBe(7)
		expect(priceBefore('gone', 1, current, history)).toBe(0)
	})
})
