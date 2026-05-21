import { BadRequestException, Injectable } from '@nestjs/common'
import { ModelType } from '@typegoose/typegoose/lib/types'
import { Types } from 'mongoose'
import { InjectModel } from 'nestjs-typegoose'
import { Product } from '../products/product.model'
import { ALL_PERMISSIONS, Role } from '../roles/role.model'
import { DEFAULT_SEED_PRODUCTS, DEFAULT_SEED_ROLES } from './default-seed.data'
import {
	SeedProductTemplate,
	SeedRoleTemplate,
	SeedTemplate,
} from './seed-template.model'

const SINGLETON_KEY = 'default'

@Injectable()
export class SeedsService {
	constructor(
		@InjectModel(SeedTemplate) private readonly seedModel: ModelType<SeedTemplate>,
		@InjectModel(Role) private readonly roleModel: ModelType<Role>,
		@InjectModel(Product) private readonly productModel: ModelType<Product>
	) {}

	private async getOrCreate(): Promise<SeedTemplate> {
		let doc = await this.seedModel
			.findOne({ key: SINGLETON_KEY })
			.setOptions({ skipTenantScope: true } as any)
			.exec()
		if (!doc) {
			doc = await this.seedModel.create({
				key: SINGLETON_KEY,
				roles: DEFAULT_SEED_ROLES.map((r) => ({ ...r })) as any,
				products: DEFAULT_SEED_PRODUCTS.map((p) => ({ ...p })) as any,
				updatedAt: Date.now(),
			})
			return doc
		}
		const rolesEmpty = !doc.roles || doc.roles.length === 0
		const productsEmpty = !doc.products || doc.products.length === 0
		if (rolesEmpty && productsEmpty) {
			doc.roles = DEFAULT_SEED_ROLES.map((r) => ({ ...r })) as any
			doc.products = DEFAULT_SEED_PRODUCTS.map((p) => ({ ...p })) as any
			doc.updatedAt = Date.now()
			await this.seedModel
				.updateOne({ _id: (doc as any)._id }, doc as any)
				.setOptions({ skipTenantScope: true } as any)
				.exec()
		}
		return doc
	}

	async getSeeds() {
		return this.getOrCreate()
	}

	async updateRolesSeeds(rolesInput: SeedRoleTemplate[]) {
		const cleaned = (rolesInput || []).map((r) => ({
			name: String(r.name || '').trim(),

			permissions: (r.permissions || []).filter((p) =>
				(ALL_PERMISSIONS as unknown as string[]).includes(p)
			),
		}))

		const names = cleaned.map((r) => r.name)
		if (cleaned.some((r) => !r.name)) {
			throw new BadRequestException('Имя роли не может быть пустым')
		}
		if (new Set(names).size !== names.length) {
			throw new BadRequestException('Имена ролей должны быть уникальными')
		}
		const doc = await this.getOrCreate()
		doc.roles = cleaned as any
		doc.updatedAt = Date.now()
		await this.seedModel
			.updateOne({ _id: (doc as any)._id }, doc as any)
			.setOptions({ skipTenantScope: true } as any)
			.exec()
		return doc
	}

	async updateProductsSeeds(productsInput: SeedProductTemplate[]) {
		const cleaned = (productsInput || []).map((p) => ({
			name: String(p.name || '').trim(),
			category: String(p.category || '').trim(),
			price: Number.isFinite(Number(p.price)) ? Number(p.price) : 0,
			targetQty: Number.isFinite(Number(p.targetQty)) ? Number(p.targetQty) : 0,
		}))
		if (cleaned.some((p) => !p.name)) {
			throw new BadRequestException('Название товара не может быть пустым')
		}

		const names = cleaned.map((p) => p.name)
		if (new Set(names).size !== names.length) {
			throw new BadRequestException('Имена товаров должны быть уникальными')
		}
		const doc = await this.getOrCreate()
		doc.products = cleaned as any
		doc.updatedAt = Date.now()
		await this.seedModel
			.updateOne({ _id: (doc as any)._id }, doc as any)
			.setOptions({ skipTenantScope: true } as any)
			.exec()
		return doc
	}


	async applySeedsToCompany(
		companyId: string,
		opts: { seedRoles?: boolean; seedProducts?: boolean }
	) {
		const doc = await this.getOrCreate()
		const companyOid = new Types.ObjectId(String(companyId))
		const result = { rolesCreated: 0, productsCreated: 0 }

		if (opts.seedRoles && doc.roles?.length) {

			const rolesToInsert = doc.roles
				.filter((r) => r.name.toLowerCase() !== 'admin')
				.map((r) => ({
					company: companyOid,
					name: r.name,
					permissions: [...(r.permissions || [])],
					isSystem: false,
				}))
			if (rolesToInsert.length) {
				await this.roleModel.insertMany(rolesToInsert, { ordered: false })
				result.rolesCreated = rolesToInsert.length
			}
		}

		if (opts.seedProducts && doc.products?.length) {
			const productsToInsert = doc.products.map((p) => ({
				company: companyOid,
				name: p.name,
				category: p.category || '',
				price: p.price || 0,
				quantity: 0,
				targetQty: 0,
				deletedAt: null,
				createdAt: Date.now(),
			}))
			if (productsToInsert.length) {
				await this.productModel.insertMany(productsToInsert, { ordered: false })
				result.productsCreated = productsToInsert.length
			}
		}

		return result
	}
}
