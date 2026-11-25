/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { BadGatewayException } from '@nestjs/common'
import { CompanyService } from './company.service'

// Создание местности «с lit-na.ru»: каталог сайта берётся до создания, фото — фоном
describe('createWithAdmin: товары с lit-na.ru', () => {
	function build(siteSeed: () => Promise<any>) {
		const saved: any[] = []
		function FakeCompany(this: any, doc: any) {
			Object.assign(this, doc, { _id: '64a0000000000000000000c1' })
			this.save = async () => saved.push(this)
		}
		;(FakeCompany as any).findOne = () => ({ setOptions: async () => null })
		const users: any[] = []
		const seeds = { applySeedsToCompany: jest.fn(async () => ({ rolesCreated: 2, productsCreated: 1 })) }
		// фото фоном не завершаются: ответ о создании их ждать не должен
		const litna = { siteSeed: jest.fn(siteSeed), seedPhotos: jest.fn(() => new Promise(() => null)) }
		const svc = new CompanyService(
			FakeCompany as any,
			{ findOne: () => ({ setOptions: async () => null }), create: async (u: any) => (users.push(u), { _id: 'u1', ...u }) } as any,
			{ create: async (r: any) => ({ _id: 'r1', ...r }) } as any,
			{} as any,
			seeds as any,
			litna as any,
			{} as any,
			{} as any
		)
		return { svc, saved, users, seeds, litna }
	}
	const dto: any = { name: 'Новая', adminLogin: 'adm9', adminPassword: 'pass12345', seedRoles: true, products: 'litna' }

	it('сайт недоступен — 502, местность и председатель не созданы', async () => {
		const { svc, saved, users } = build(async () => {
			throw new BadGatewayException('Не удалось получить каталог lit-na.ru — местность не создана')
		})
		await expect(svc.createWithAdmin(dto, { _id: 's1' } as any)).rejects.toThrow('местность не создана')
		expect(saved).toEqual([])
		expect(users).toEqual([])
	})

	it('товары и обложки видов — с сайта, роли — из семян, фото — фоном (ответ их не ждёт)', async () => {
		const plan = { products: [{ name: 'Базовый текст', category: 'Книги', price: 450, targetQty: 0, litnaId: 12 }], kindCovers: [{ category: 'Книги', cover: 'book' }] }
		const { svc, saved, seeds, litna } = build(async () => plan)
		const res = await svc.createWithAdmin(dto, { _id: 's1' } as any)
		expect(saved).toHaveLength(1)
		expect(seeds.applySeedsToCompany).toHaveBeenCalledWith('64a0000000000000000000c1', { seedRoles: true, seedProducts: true, ...plan })
		expect(litna.seedPhotos).toHaveBeenCalledWith('64a0000000000000000000c1')
		expect(res.seedReport).toEqual({ rolesCreated: 2, productsCreated: 1 })
	})

	it('без products: litna — как раньше, сайт не трогается', async () => {
		const { svc, seeds, litna } = build(async () => null)
		await svc.createWithAdmin({ ...dto, products: undefined, seedProducts: true }, { _id: 's1' } as any)
		expect(litna.siteSeed).not.toHaveBeenCalled()
		expect(seeds.applySeedsToCompany).toHaveBeenCalledWith('64a0000000000000000000c1', { seedRoles: true, seedProducts: true })
	})
})
