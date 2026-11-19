/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { backupName, tarHeader } from './backup.service'

describe('бэкап базы', () => {
	it('заголовок tar: имя, размер восьмеричным числом, отметка ustar и верная контрольная сумма', () => {
		const h = tarHeader('skladan/Orders.bson.gz', 1234, 1795000000)
		expect(h.length).toBe(512)
		expect(h.toString('utf8', 0, 22)).toBe('skladan/Orders.bson.gz')
		expect(parseInt(h.toString('ascii', 124, 135), 8)).toBe(1234)
		expect(parseInt(h.toString('ascii', 136, 147), 8)).toBe(1795000000)
		expect(h.toString('ascii', 257, 262)).toBe('ustar')
		const stored = parseInt(h.toString('ascii', 148, 154), 8)
		const blank = Buffer.from(h)
		blank.fill(' ', 148, 156)
		expect(blank.reduce((s, b) => s + b, 0)).toBe(stored)
	})

	it('слишком длинное имя не обрезается молча', () => {
		expect(() => tarHeader('a'.repeat(101), 1)).toThrow()
	})

	it('имя файла — по московскому времени', () => {
		expect(backupName(Date.parse('2026-11-19T22:30:05Z'))).toBe(
			'skladan-manual-2026-11-20_013005.tar'
		)
	})
})
