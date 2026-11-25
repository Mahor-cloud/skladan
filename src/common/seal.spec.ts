/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { seal, sealSecret, unseal } from './seal'

describe('шифрование секретов', () => {
	it('расшифровывается тем же секретом; вектор случайный — одинаковый текст шифруется по-разному', () => {
		const a = seal('пароль', 's1')
		const b = seal('пароль', 's1')
		expect(a).not.toBe(b)
		expect(a).not.toContain('пароль')
		expect(unseal(a, 's1')).toBe('пароль')
		expect(unseal(b, 's1')).toBe('пароль')
	})

	it('другой секрет или подмена данных — ошибка, а не мусор', () => {
		const a = seal('пароль', 's1')
		expect(() => unseal(a, 's2')).toThrow()
		const [iv, tag, data] = a.split('.')
		const other = Buffer.from(data, 'base64')
		other[0] ^= 1
		expect(() => unseal([iv, tag, other.toString('base64')].join('.'), 's1')).toThrow()
		// короткая метка не принимается
		expect(() => unseal([iv, Buffer.from(tag, 'base64').subarray(0, 4).toString('base64'), data].join('.'), 's1')).toThrow()
		expect(() => unseal('мусор', 's1')).toThrow()
	})

	const cfg = (env: Record<string, string>) => ({ get: (k: string) => env[k] }) as any

	it('секрет: метка данных и LITNA_KEY, без него — JWT_SECRET', () => {
		expect(sealSecret(cfg({ LITNA_KEY: 'k', JWT_SECRET: 'j' }), 'feedback')).toBe('feedback:k')
		expect(sealSecret(cfg({ LITNA_KEY: 'k' }), 'litna')).toBe('litna:k')
		expect(sealSecret(cfg({ JWT_SECRET: 'j' }), 'feedback')).toBe('feedback:j')
		expect(sealSecret(cfg({ JWT_SECRET: 'j' }), 'litna')).toBe('litna:j')
		expect(() => sealSecret(cfg({}), 'feedback')).toThrow()
	})

	it('сохранённое прежним секретом без LITNA_KEY читается', () => {
		const before = seal('пароль', 'litna:j')
		expect(unseal(before, sealSecret(cfg({ JWT_SECRET: 'j' }), 'litna'))).toBe('пароль')
		expect(unseal(before, sealSecret(cfg({ JWT_SECRET: 'j', NODE_ENV: 'production' }), 'litna'))).toBe('пароль')
	})

	it('в бою без LITNA_KEY от 32 символов секреты не сохраняются, а читаются', () => {
		const prod = { JWT_SECRET: 'j', NODE_ENV: 'production' }
		expect(() => sealSecret(cfg(prod), 'litna', true)).toThrow('Не задан ключ LITNA_KEY')
		expect(() => sealSecret(cfg({ ...prod, LITNA_KEY: 'k'.repeat(31) }), 'feedback', true)).toThrow('Не задан ключ LITNA_KEY')
		expect(sealSecret(cfg(prod), 'litna')).toBe('litna:j')
		expect(sealSecret(cfg({ ...prod, LITNA_KEY: 'k'.repeat(32) }), 'litna', true)).toBe('litna:' + 'k'.repeat(32))
		expect(sealSecret(cfg({ JWT_SECRET: 'j' }), 'litna', true)).toBe('litna:j')
	})
})
