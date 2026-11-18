/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { plainToInstance } from 'class-transformer'
import { validateSync } from 'class-validator'
import { CreateRoleDto } from './dto/create-role.dto'
import { UpdateRoleDto } from './dto/update-role.dto'
import { RolesService } from './roles.service'

const errors = (body: any) => validateSync(plainToInstance(UpdateRoleDto, body)).map((e) => e.property)

describe('mobileTabs validation', () => {
	it('accepts up to 4 distinct known tabs, an empty list or no field', () => {
		expect(errors({ mobileTabs: ['storage', 'orders', 'cabinet-summary', 'admin'] })).toEqual([])
		expect(errors({ mobileTabs: [] })).toEqual([])
		expect(errors({})).toEqual([])
		expect(errors({ mobileTabs: null })).toEqual([])
		expect(validateSync(plainToInstance(CreateRoleDto, { name: 'Склад', permissions: [], mobileTabs: ['history'] }))).toEqual([])
	})

	it('rejects more than 4, repeats and unknown values', () => {
		expect(errors({ mobileTabs: ['storage', 'orders', 'cabinet', 'purchases', 'inventory'] })).toEqual(['mobileTabs'])
		expect(errors({ mobileTabs: ['storage', 'storage'] })).toEqual(['mobileTabs'])
		expect(errors({ mobileTabs: ['storage', 'settings'] })).toEqual(['mobileTabs'])
		expect(errors({ mobileTabs: 'storage' })).toEqual(['mobileTabs'])
	})
})

describe('createRole', () => {
	it('stores the company of the current user and the bottom menu', async () => {
		const saved: any[] = []
		class RoleModel {
			constructor(doc: any) {
				Object.assign(this, doc)
			}
			async save() {
				saved.push(this)
			}
		}
		const history: any = { createChangeHistory: jest.fn(async () => ({})) }
		const service = new RolesService(RoleModel as any, {} as any, history)
		const dto = plainToInstance(CreateRoleDto, { name: 'Склад', permissions: [], mobileTabs: ['history'] })
		await service.createRole(dto, { _id: 'u1', company: 'c1' } as any)
		expect(saved[0]).toMatchObject({ company: 'c1', name: 'Склад', mobileTabs: ['history'] })
	})
})

describe('remove', () => {
	function makeService(liveUsers: any[]) {
		const q = (value: any) => ({ exec: async () => value })
		const roleModel: any = { findByIdAndDelete: jest.fn(() => q({ _id: 'r1' })) }
		const userModel: any = { find: jest.fn(() => q(liveUsers)) }
		const history: any = { createChangeHistory: jest.fn(async () => ({})) }
		return { service: new RolesService(roleModel, userModel, history), roleModel, userModel }
	}

	it('counts only users that are not deleted, so a role of deleted users is removed', async () => {
		const { service, roleModel, userModel } = makeService([])
		await service.remove('r1', { _id: 'u1' } as any)
		expect(userModel.find).toHaveBeenCalledWith({ role: 'r1', deletedAt: null })
		expect(roleModel.findByIdAndDelete).toHaveBeenCalledWith('r1')
	})

	it('a role with a live user is refused with the same message', async () => {
		const { service, roleModel } = makeService([{ _id: 'u2' }])
		await expect(service.remove('r1', { _id: 'u1' } as any)).rejects.toThrow('Нельзя удалить роль, так как она используется.')
		expect(roleModel.findByIdAndDelete).not.toHaveBeenCalled()
	})
})

describe('system role update', () => {
	function makeService(oldRole: any) {
		const q = (value: any) => ({ exec: async () => value })
		const roleModel: any = {
			findById: jest.fn(() => q(oldRole)),
			findByIdAndUpdate: jest.fn((id, update) => q({ ...oldRole, ...update })),
		}
		const history: any = { createChangeHistory: jest.fn(async () => ({})) }
		return { service: new RolesService(roleModel, {} as any, history), roleModel, history }
	}

	it('Admin keeps its name and permissions, but the bottom menu changes', async () => {
		const admin = { _id: 'r1', name: 'Admin', isSystem: true, permissions: ['view_products'] }
		const { service, roleModel, history } = makeService(admin)
		const dto = plainToInstance(UpdateRoleDto, { name: 'Boss', permissions: [], mobileTabs: ['storage', 'admin'] })
		const res = await service.update('r1', dto, { _id: 'u1' } as any)
		expect(roleModel.findByIdAndUpdate.mock.calls[0][1]).toEqual({ mobileTabs: ['storage', 'admin'] })
		expect(res).toMatchObject({ name: 'Admin', permissions: ['view_products'], mobileTabs: ['storage', 'admin'] })
		expect(history.createChangeHistory.mock.calls[0][0].description).toBe(
			'Роль Admin обновлена. Изменения: Нижнее меню изменено на storage, admin'
		)
	})

	it('an ordinary role still changes name and permissions', async () => {
		const { service, roleModel } = makeService({ _id: 'r2', name: 'Склад', isSystem: false, permissions: [] })
		const dto = plainToInstance(UpdateRoleDto, { name: 'Кладовая', permissions: ['view_products'] })
		await service.update('r2', dto, { _id: 'u1' } as any)
		expect(roleModel.findByIdAndUpdate.mock.calls[0][1]).toEqual({ name: 'Кладовая', permissions: ['view_products'] })
	})
})
