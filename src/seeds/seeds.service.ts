/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { BadRequestException, Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common'
import { ModelType } from '@typegoose/typegoose/lib/types'
import { randomBytes } from 'crypto'
import { Types } from 'mongoose'
import { InjectModel } from 'nestjs-typegoose'
import { KindCover, Message } from '../database/messages.model'
import { ProductPhoto } from '../products/product-photo.model'
import { Product } from '../products/product.model'
import { IMAGE_TYPES, imageType, PHOTO_QUOTA, PHOTO_TOKEN } from '../products/products.service'
import { ALL_PERMISSIONS, Role } from '../roles/role.model'
import { DEFAULT_SEED_PRODUCTS, DEFAULT_SEED_ROLES } from './default-seed.data'
import {
	SeedPhoto,
	SeedProductTemplate,
	SeedRoleTemplate,
	SeedTemplate,
} from './seed-template.model'

const SINGLETON_KEY = 'default'
const COLOR = /^#[0-9a-fA-F]{6}$/
const COVER = /^[a-z0-9-]{1,32}$/

// Товары шаблона из запроса. legacy — клиент прежней версии (из кэша): про обложки он не знает и их не присылает,
// поэтому цвет и фото остаются от товара с тем же названием.
export function seedProducts(input: any[], previous: SeedProductTemplate[], legacy: boolean) {
	const before = new Map((previous || []).map((p) => [p.name, p]))
	return (Array.isArray(input) ? input : []).map((p) => {
		const name = String(p?.name || '').trim()
		const cover = legacy ? before.get(name) : p
		return {
			name,
			category: String(p?.category || '').trim(),
			price: Number.isFinite(Number(p?.price)) ? Number(p.price) : 0,
			targetQty: Number.isFinite(Number(p?.targetQty)) ? Number(p.targetQty) : 0,
			coverColor: typeof cover?.coverColor === 'string' && COLOR.test(cover.coverColor) ? cover.coverColor : undefined,
			photo: typeof cover?.photo === 'string' && PHOTO_TOKEN.test(cover.photo) ? cover.photo : undefined,
		}
	})
}

// Обложки видов шаблона: только для видов, которые есть у его товаров; повтор вида — побеждает последний
export function seedKindCovers(input: any, kinds: Set<string>): KindCover[] {
	const covers = new Map<string, string>()
	for (const k of Array.isArray(input) ? input : []) {
		if (typeof k?.category !== 'string' || typeof k.cover !== 'string') continue
		const category = k.category.trim()
		if (category && kinds.has(category) && COVER.test(k.cover)) covers.set(category, k.cover)
	}
	return [...covers].map(([category, cover]) => ({ category, cover }))
}

@Injectable()
export class SeedsService {
	constructor(
		@InjectModel(SeedTemplate) private readonly seedModel: ModelType<SeedTemplate>,
		@InjectModel(Role) private readonly roleModel: ModelType<Role>,
		@InjectModel(Product) private readonly productModel: ModelType<Product>,
		@InjectModel(SeedPhoto) private readonly seedPhotoModel: ModelType<SeedPhoto>,
		@InjectModel(ProductPhoto) private readonly photoModel: ModelType<ProductPhoto>,
		@InjectModel(Message) private readonly messageModel: ModelType<Message>
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

	async setPhoto(data?: Buffer) {
		const contentType = imageType(data)
		if (!contentType) throw new BadRequestException('Нужна картинка WebP, PNG или JPEG')
		// Половина объёма местности: копия шаблона должна в неё поместиться и оставить место своим фото
		const [used] = await this.seedPhotoModel
			.aggregate([{ $group: { _id: null, bytes: { $sum: { $binarySize: '$data' } } } }])
			.exec()
		if ((used?.bytes || 0) + data.length > PHOTO_QUOTA / 2) throw new PayloadTooLargeException('Превышен объём фото шаблона')
		const token = randomBytes(16).toString('hex')
		await this.seedPhotoModel.create({ token, contentType, data })
		return { token }
	}

	async getPhoto(token: string): Promise<SeedPhoto> {
		const photo = await this.seedPhotoModel.findOne({ token }).exec()
		if (!photo || !IMAGE_TYPES.includes(photo.contentType)) throw new NotFoundException('Картинка не найдена')
		return photo
	}

	// kindCoversInput нет — прислал клиент прежней версии: обложки видов, цвета и фото остаются прежними
	async updateProductsSeeds(productsInput: SeedProductTemplate[], kindCoversInput?: KindCover[]) {
		const doc = await this.getOrCreate()
		const cleaned = seedProducts(productsInput, doc.products, kindCoversInput === undefined)
		if (cleaned.some((p) => !p.name)) {
			throw new BadRequestException('Название товара не может быть пустым')
		}

		const names = cleaned.map((p) => p.name)
		if (new Set(names).size !== names.length) {
			throw new BadRequestException('Имена товаров должны быть уникальными')
		}
		const tokens = cleaned.map((p) => p.photo).filter(Boolean)
		if (new Set(tokens).size !== tokens.length) {
			throw new BadRequestException('Одно фото не может быть у двух товаров')
		}
		const stored = await this.seedPhotoModel.find({ token: { $in: tokens } }).select('token').lean().exec()
		const known = new Set(stored.map((p) => p.token))
		const lost = cleaned.find((p) => p.photo && !known.has(p.photo))
		if (lost) throw new BadRequestException(`Фото товара «${lost.name}» не найдено — загрузите его заново`)

		const dropped = doc.products.map((p) => p.photo).filter((t) => t && !known.has(t))
		doc.products = cleaned as any
		doc.kindCovers = seedKindCovers(kindCoversInput ?? doc.kindCovers, new Set(cleaned.map((p) => p.category)))
		doc.updatedAt = Date.now()
		await this.seedModel
			.updateOne({ _id: (doc as any)._id }, doc as any)
			.setOptions({ skipTenantScope: true } as any)
			.exec()
		// Убираются фото, ушедшие из шаблона этим сохранением, и загруженные больше суток назад, но так в него и не попавшие:
		// свежая загрузка из другой вкладки остаётся
		const dayAgo = Types.ObjectId.createFromTime(Math.floor(Date.now() / 1000) - 24 * 60 * 60)
		await this.seedPhotoModel
			.deleteMany({ $or: [{ token: { $in: dropped } }, { token: { $nin: tokens }, _id: { $lt: dayAgo } }] })
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
			const tokens = doc.products.map((p) => p.photo).filter(Boolean)
			const seedPhotos = new Map(
				(await this.seedPhotoModel.find({ token: { $in: tokens } }).exec()).map((p) => [p.token, p])
			)
			// Каждому товару своя копия картинки: фото местности меняются и удаляются вместе с её товарами
			const photos = []
			const productsToInsert = doc.products.map((p) => {
				const source = seedPhotos.get(p.photo)
				const photo = source ? randomBytes(16).toString('hex') : undefined
				if (source) photos.push({ company: companyOid, token: photo, contentType: source.contentType, data: source.data })
				return {
					company: companyOid,
					name: p.name,
					category: p.category || '',
					price: p.price || 0,
					quantity: 0,
					targetQty: 0,
					coverColor: p.coverColor,
					photo,
					deletedAt: null,
					createdAt: Date.now(),
				}
			})
			if (photos.length) await this.photoModel.insertMany(photos, { ordered: false })
			if (productsToInsert.length) {
				try {
					await this.productModel.insertMany(productsToInsert, { ordered: false })
				} catch (e) {
					// встать могла часть товаров (ordered: false): убираются фото только тех, что не встали
					const kept = await this.productModel.distinct('photo', { company: companyOid }).exec()
					await this.photoModel.deleteMany({ company: companyOid, token: { $nin: kept } }).exec()
					throw e
				}
				result.productsCreated = productsToInsert.length
			}
			if (doc.kindCovers?.length) {
				await this.messageModel
					.updateOne(
						{ company: companyOid },
						{ $set: { kindCovers: doc.kindCovers.map((k) => ({ category: k.category, cover: k.cover })) } },
						{ upsert: true }
					)
					.exec()
			}
		}

		return result
	}
}
