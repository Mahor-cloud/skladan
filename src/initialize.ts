/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { ConfigService } from '@nestjs/config'
import { Logger } from '@nestjs/common'
import { getModelForClass } from '@typegoose/typegoose'
import { genSalt, hash } from 'bcryptjs'
import mongoose from 'mongoose'
import { UserModel } from './auth/user.model'
import { Company } from './company/company.model'
import { ALL_PERMISSIONS, Role } from './roles/role.model'
import { DEFAULT_SEED_PRODUCTS, DEFAULT_SEED_ROLES } from './seeds/default-seed.data'
import { SeedTemplate } from './seeds/seed-template.model'

const logger = new Logger('Initialize')

export async function initializeDatabase(configService: ConfigService) {
	try {
		const mongoUri = configService.get<string>('MONGO_URI')
		if (!mongoUri) throw new Error('MONGO_URI is not defined in env')

		await mongoose.connect(mongoUri)

		const UserCls = getModelForClass(UserModel, { schemaOptions: { collection: 'Users' } })
		const CompanyCls = getModelForClass(Company, { schemaOptions: { collection: 'Company' } })
		const RoleCls = getModelForClass(Role, { schemaOptions: { collection: 'Roles' } })
		const SeedCls = getModelForClass(SeedTemplate, {
			schemaOptions: { collection: 'SeedTemplate' },
		})

		const superLogin = configService.get<string>('SUPER_ADMIN_LOGIN') || 'superadmin'
		const superPassword = configService.get<string>('SUPER_ADMIN_PASSWORD')
		const defaultName = configService.get<string>('DEFAULT_COMPANY_NAME') || 'Местность Саратов'
		const defaultSlug = configService.get<string>('DEFAULT_COMPANY_SLUG') || 'saratov'

		let superAdmin = await UserCls.findOne({ login: superLogin, isSuperAdmin: true })
			.setOptions({ skipTenantScope: true } as any)
		if (!superAdmin) {
			if (!superPassword) {
				logger.warn(
					'SUPER_ADMIN_PASSWORD not set and SuperAdmin missing — skipping SuperAdmin creation'
				)
			} else {
				const salt = await genSalt(12)
				superAdmin = await UserCls.create({
					login: superLogin,
					password: await hash(superPassword, salt),
					name: 'Super Admin',
					role: null,
					isAdmin: false,
					isSuperAdmin: true,
					company: null,
				} as any)
				logger.log(`SuperAdmin "${superLogin}" created.`)
			}
		}

		let defaultCompany = await CompanyCls.findOne({ slug: defaultSlug })
			.setOptions({ skipTenantScope: true } as any)
		if (!defaultCompany) {
			defaultCompany = await CompanyCls.create({
				name: defaultName,
				slug: defaultSlug,
				isActive: true,
				createdBy: superAdmin?._id || null,
				createdAt: Date.now(),
			} as any)
			logger.log(`Default Company "${defaultName}" created.`)
		}

		const allCompanies = await CompanyCls.find({ deletedAt: null })
			.setOptions({ skipTenantScope: true } as any)
		for (const company of allCompanies) {
			let adminRole = await RoleCls.findOne({ company: company._id, isSystem: true, name: 'Admin' })
				.setOptions({ skipTenantScope: true } as any)
			if (!adminRole) {
				adminRole = await RoleCls.create({
					company: company._id,
					name: 'Admin',
					isSystem: true,
					permissions: [...ALL_PERMISSIONS],
				} as any)
				logger.log(`Admin role created for company "${company.name}"`)
			} else {

				const missing = ALL_PERMISSIONS.filter((p) => !adminRole.permissions.includes(p))
				if (missing.length > 0) {
					adminRole.permissions = [...adminRole.permissions, ...missing]
					await adminRole.save()
					logger.log(`Admin role for "${company.name}" extended with: ${missing.join(', ')}`)
				}
			}
		}

		const seedDoc = await SeedCls.findOne({ key: 'default' })
			.setOptions({ skipTenantScope: true } as any)
		if (!seedDoc) {
			await SeedCls.create({
				key: 'default',
				roles: DEFAULT_SEED_ROLES.map((r) => ({ ...r })),
				products: DEFAULT_SEED_PRODUCTS.map((p) => ({ ...p })),
				updatedAt: Date.now(),
			} as any)
			logger.log(
				`SeedTemplate created (${DEFAULT_SEED_ROLES.length} roles, ${DEFAULT_SEED_PRODUCTS.length} products)`
			)
		} else {
			const rolesEmpty = !seedDoc.roles || seedDoc.roles.length === 0
			const productsEmpty = !seedDoc.products || seedDoc.products.length === 0
			if (rolesEmpty && productsEmpty) {
				seedDoc.roles = DEFAULT_SEED_ROLES.map((r) => ({ ...r })) as any
				seedDoc.products = DEFAULT_SEED_PRODUCTS.map((p) => ({ ...p })) as any
				seedDoc.updatedAt = Date.now()
				await seedDoc.save()
				logger.log(
					`SeedTemplate was empty — backfilled (${DEFAULT_SEED_ROLES.length} roles, ${DEFAULT_SEED_PRODUCTS.length} products)`
				)
			}
		}

		logger.log('initializeDatabase: OK')
		await mongoose.connection.close()
	} catch (error) {
		logger.error('Error initializing database', error as any)
		try { await mongoose.connection.close() } catch {  }
	}
}
