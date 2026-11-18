/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { UnauthorizedException } from '@nestjs/common'
import { hash } from 'bcryptjs'
import { createHash } from 'crypto'
import { AuthService, loginLockMs } from './auth.service'
import { JwtStrategy } from './strategies/jwt.strategy'

const REFRESH = 'refresh-token'

async function makeService(user: any) {
	const passwordHash = await hash('secret', 4)
	const stored = { ...user, password: passwordHash, refreshToken: createHash('sha256').update(REFRESH).digest('hex') }
	// Запросы mongoose здесь ждут через await без .exec(): populate() отдаёт Promise
	const userModel: any = {
		findOne: jest.fn(() => ({ setOptions: () => ({ populate: async () => stored }) })),
		findById: jest.fn(() => ({ setOptions: () => ({ populate: async () => stored }) })),
		updateOne: jest.fn(() => ({ setOptions: async () => ({}) })),
	}
	const companyModel: any = { findById: jest.fn() }
	const jwt: any = { verifyAsync: jest.fn(async () => ({ _id: 'u1' })), signAsync: jest.fn(async () => 'signed') }
	const service = new AuthService(userModel, companyModel, jwt, {} as any)
	return { service, jwt }
}

async function caught(p: Promise<any>): Promise<any> {
	try {
		await p
	} catch (e) {
		return e
	}
	throw new Error('expected a rejection')
}

const base = { _id: 'u1', login: 'klad', isSuperAdmin: false, company: null, role: {}, tokenVersion: 1 }

describe('getNewTokens', () => {
	it('live user gets a new pair, as before', async () => {
		const { service } = await makeService(base)
		const res = await service.getNewTokens({ refreshToken: REFRESH })
		expect(res).toMatchObject({ accessToken: 'signed', refreshToken: 'signed', user: { login: 'klad' } })
	})

	it('deleted user is refused like a superseded session, no tokens issued', async () => {
		const { service, jwt } = await makeService({ ...base, deletedAt: new Date() })
		const e = await caught(service.getNewTokens({ refreshToken: REFRESH }))
		expect(e).toBeInstanceOf(UnauthorizedException)
		expect(e.getResponse()).toEqual({ message: 'SESSION_SUPERSEDED', error: 'Unauthorized', statusCode: 401 })
		expect(jwt.signAsync).not.toHaveBeenCalled()
	})
})

describe('login of a deleted user', () => {
	it('right password: 401 Пользователь деактивирован, no tokens', async () => {
		const { service, jwt } = await makeService({ ...base, deletedAt: new Date() })
		const e = await caught(service.login({ login: 'klad', password: 'secret' } as any))
		expect(e).toBeInstanceOf(UnauthorizedException)
		expect(e.message).toBe('Пользователь деактивирован')
		expect(jwt.signAsync).not.toHaveBeenCalled()
	})

	it('wrong password: the usual text, nothing revealed', async () => {
		const { service } = await makeService({ ...base, deletedAt: new Date() })
		const e = await caught(service.login({ login: 'klad', password: 'nope' } as any))
		expect(e.message).toBe('Неверный логин или пароль')
	})

	it('live user still logs in', async () => {
		const { service } = await makeService(base)
		const res = await service.login({ login: 'klad', password: 'secret' } as any)
		expect(res.accessToken).toBe('signed')
	})
})

describe('remove', () => {
	it('answers with the same fields as a user edit: no password or refresh token hash', async () => {
		const removed = { _id: 'u2', login: 'gone', password: '$2a$12$hash', refreshToken: 'sha', role: 'r1', isAdmin: false, company: 'c1', name: 'Ушёл', deletedAt: 1 }
		const userModel: any = { findByIdAndUpdate: jest.fn(() => ({ exec: async () => removed })) }
		const history: any = { createChangeHistory: jest.fn(async () => ({})) }
		const service = new AuthService(userModel, {} as any, {} as any, history)
		const res = await service.remove('u2', { _id: 'u1' } as any)
		expect(res).toEqual({ _id: 'u2', login: 'gone', role: 'r1', isAdmin: false, isSuperAdmin: false, company: 'c1', name: 'Ушёл' })
	})
})

describe('подбор пароля', () => {
	it('пять попыток свободны, дальше пауза растёт вдвое до 15 минут', () => {
		expect([1, 4, 5, 6, 7, 9, 20].map(loginLockMs)).toEqual([0, 0, 60_000, 120_000, 240_000, 900_000, 900_000])
	})

	it('после пяти неверных паролей с адреса вход с него закрыт даже с верным паролем; с другого адреса и по другому логину — открыт', async () => {
		const { service } = await makeService(base)
		for (let i = 0; i < 5; i++) {
			const e = await caught(service.login({ login: 'klad', password: 'wrong' } as any, '1.1.1.1'))
			expect(e.message).toBe('Неверный логин или пароль')
		}
		const locked = await caught(service.login({ login: 'KLAD', password: 'secret' } as any, '1.1.1.1'))
		expect(locked.getStatus()).toBe(429)
		expect(locked.message).toContain('Слишком много неудачных попыток')
		await expect(service.login({ login: 'klad', password: 'secret' } as any, '2.2.2.2')).resolves.toMatchObject({ accessToken: 'signed' })
		await expect(service.login({ login: 'other', password: 'secret' } as any, '1.1.1.1')).resolves.toMatchObject({ accessToken: 'signed' })
	})

	it('пачка одновременных запросов не проходит мимо счёта: пароль проверяется не больше пяти раз', async () => {
		const { service } = await makeService(base)
		const findOne = (service as any).UserModel.findOne
		const results = await Promise.all(Array.from({ length: 30 }, () => caught(service.login({ login: 'klad', password: 'wrong' } as any, '1.1.1.1'))))
		expect(findOne).toHaveBeenCalledTimes(5)
		expect(results.filter((e) => e.getStatus() === 429)).toHaveLength(25)
	})

	it('подбор с многих адресов: после тридцати неудач логин закрыт для всех адресов', async () => {
		const { service } = await makeService(base)
		for (let i = 0; i < 30; i++) await caught(service.login({ login: 'klad', password: 'wrong' } as any, '10.0.0.' + i))
		const e = await caught(service.login({ login: 'klad', password: 'secret' } as any, '9.9.9.9'))
		expect(e.getStatus()).toBe(429)
		// попытки, отклонённые общим счётом, в счёт своего адреса не идут: после сброса владелец входит сразу
		for (let i = 0; i < 8; i++) await caught(service.login({ login: 'klad', password: 'secret' } as any, '9.9.9.9'))
		;(service as any).loginFails.delete(JSON.stringify(['klad']))
		await expect(service.login({ login: 'klad', password: 'secret' } as any, '9.9.9.9')).resolves.toMatchObject({ accessToken: 'signed' })
	})

	it('удачный вход обнуляет счёт; вход деактивированного подбором не считается', async () => {
		const { service } = await makeService(base)
		for (let i = 0; i < 4; i++) await caught(service.login({ login: 'klad', password: 'wrong' } as any, '1.1.1.1'))
		await service.login({ login: 'klad', password: 'secret' } as any, '1.1.1.1')
		for (let i = 0; i < 4; i++) await caught(service.login({ login: 'klad', password: 'wrong' } as any, '1.1.1.1'))
		await expect(service.login({ login: 'klad', password: 'secret' } as any, '1.1.1.1')).resolves.toMatchObject({ accessToken: 'signed' })

		// чужой логин со знаком «|» счёт пары «логин + адрес» не трогает
		for (let i = 0; i < 4; i++) await caught(service.login({ login: 'klad', password: 'wrong' } as any, '1.1.1.1'))
		await service.login({ login: 'klad|1.1.1.1', password: 'secret' } as any, '3.3.3.3')
		await caught(service.login({ login: 'klad', password: 'wrong' } as any, '1.1.1.1'))
		expect((await caught(service.login({ login: 'klad', password: 'secret' } as any, '1.1.1.1'))).getStatus()).toBe(429)

		const gone = await makeService({ ...base, deletedAt: new Date() })
		for (let i = 0; i < 8; i++) expect((await caught(gone.service.login({ login: 'klad', password: 'secret' } as any, '1.1.1.1'))).message).toBe('Пользователь деактивирован')
	})
})

describe('ключи доступа и обновления', () => {
	const strategy = () => new JwtStrategy({ get: () => 'secret' } as any, { findById: () => ({ setOptions: () => ({ populate: () => ({ exec: async () => ({ ...base, isSuperAdmin: true, tokenVersion: 3 }) }) }) }) } as any, {} as any)

	it('ключ обновления помечен и как ключ доступа не принимается — в том числе старый, без пометки, по сроку жизни', async () => {
		const { service, jwt } = await makeService(base)
		await service.issueTokenPair(base as any)
		expect(jwt.signAsync.mock.calls.map((c: any[]) => [c[0].typ, c[1].expiresIn])).toEqual([
			['refresh', '30d'],
			[undefined, '1h'],
		])
		expect(await caught(strategy().validate({ _id: 'u1', typ: 'refresh' } as any))).toBeInstanceOf(UnauthorizedException)
		expect(await caught(strategy().validate({ _id: 'u1', iat: 1000, exp: 1000 + 30 * 86400 } as any))).toBeInstanceOf(UnauthorizedException)
	})

	it('номер сессии сверяется и у супер-админа: после выхода или смены пароля прежний ключ доступа не годится', async () => {
		await expect(strategy().validate({ _id: 'u1', iat: 1000, exp: 4600, tokenVersion: 3 } as any)).resolves.toMatchObject({ login: 'klad' })
		const e = await caught(strategy().validate({ _id: 'u1', iat: 1000, exp: 4600, tokenVersion: 2 } as any))
		expect(e.message).toBe('SESSION_SUPERSEDED')
	})

	it('смена своего пароля завершает прежние сессии: номер сессии растёт до выдачи новой пары', async () => {
		const { service, jwt } = await makeService(base)
		const doc: any = { ...base, password: await hash('secret', 4), save: jest.fn(async () => null) }
		;(service as any).UserModel.findById = jest.fn(() => ({ setOptions: () => ({ exec: async () => doc }) }))
		await service.changeOwnPassword(base as any, 'secret', 'new-secret')
		expect(doc.tokenVersion).toBe(2)
		expect(jwt.signAsync.mock.calls[0][0].tokenVersion).toBe(2)
	})

	it('выход по ключу обновления: сервер забывает именно эту сессию; негодный ключ — без ошибки и без записи', async () => {
		const { service, jwt } = await makeService(base)
		const updateOne = jest.fn(() => ({ setOptions: () => ({ exec: async () => ({}) }) }))
		;(service as any).UserModel.updateOne = updateOne
		await service.logout({ refreshToken: REFRESH })
		expect(updateOne).toHaveBeenCalledWith(
			{ _id: 'u1', refreshToken: createHash('sha256').update(REFRESH).digest('hex') },
			{ $unset: { refreshToken: 1 }, $inc: { tokenVersion: 1 } }
		)
		jwt.verifyAsync.mockRejectedValueOnce(new Error('jwt expired'))
		await expect(service.logout({ refreshToken: 'bad' })).resolves.toEqual({ ok: true })
		expect(updateOne).toHaveBeenCalledTimes(1)
	})

	it('негодный ключ обновления — 401, а не ошибка сервера', async () => {
		const { service, jwt } = await makeService(base)
		jwt.verifyAsync.mockRejectedValueOnce(new Error('jwt malformed'))
		expect(await caught(service.getNewTokens({ refreshToken: 'bad' }))).toBeInstanceOf(UnauthorizedException)
	})
})
