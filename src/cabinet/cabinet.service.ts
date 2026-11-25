/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { BadRequestException, ForbiddenException, Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common'
import { ModelType } from '@typegoose/typegoose/lib/types'
import { randomBytes } from 'crypto'
import { Types } from 'mongoose'
import { InjectModel } from 'nestjs-typegoose'
import { UserModel } from '../auth/user.model'
import { RealtimeService } from '../change-history/realtime.service'
import { getTenantContext } from '../common/tenant-context/tenant-context.storage'
import { Order } from '../orders/order.model'
import { ProductPhoto } from '../products/product-photo.model'
import { Product } from '../products/product.model'
import { imageType, PHOTO_QUOTA } from '../products/products.service'
import { CabinetItem } from './cabinet-item.model'
import { CreateCabinetItemDto } from './dto/create-cabinet-item.dto'
import { UpdateCabinetItemDto } from './dto/update-cabinet-item.dto'

// Фото своих позиций входят в общий объём фото местности (PHOTO_QUOTA). Сверх того: все личные вместе — не больше трети его,
// чтобы каталогу всегда оставалось место, у одного человека — не больше 2 МБ (кадр WebP весит десятки КБ).
export const OWN_PHOTO_QUOTA = 10 * 1024 * 1024
export const USER_PHOTO_QUOTA = 2 * 1024 * 1024

export interface AutofillSuggestion {
	product: string
	productName: string
	category?: string
	price: number
	neededQty: number
	availableQty: number
	isMissing: boolean
}

@Injectable()
export class CabinetService {
	constructor(
		@InjectModel(CabinetItem) private readonly cabinetModel: ModelType<CabinetItem>,
		@InjectModel(Product) private readonly productModel: ModelType<Product>,
		@InjectModel(Order) private readonly orderModel: ModelType<Order>,
		@InjectModel(UserModel) private readonly userModel: ModelType<UserModel>,
		private readonly realtime: RealtimeService,
		@InjectModel(ProductPhoto) private readonly photoModel: ModelType<ProductPhoto>
	) {}

	private emitCabinetChanged() {
		const ctx = getTenantContext()
		this.realtime.emit(ctx?.company ? String(ctx.company) : null, 'cabinet-updated')
	}

	async getStatus(user: UserModel): Promise<{ initialized: boolean }> {
		const fresh = await this.userModel
			.findById(user._id)
			.setOptions({ skipTenantScope: true } as any)
			.select('cabinetInitialized')
			.exec()
		return { initialized: !!(fresh as any)?.cabinetInitialized }
	}

	async markInitialized(user: UserModel): Promise<{ initialized: boolean }> {
		await this.userModel
			.updateOne({ _id: user._id }, { $set: { cabinetInitialized: true } })
			.setOptions({ skipTenantScope: true } as any)
		return { initialized: true }
	}

	async findAllForUser(user: UserModel): Promise<CabinetItem[]> {
		return this.cabinetModel
			.find({ user: user._id, deletedAt: null })
			.populate('product')
			.sort({ position: 1, createdAt: 1 })
			.exec()
	}

	private async getUserPendingOrderQtyByProduct(
		userId: any
	): Promise<Map<string, number>> {

		const ctx = getTenantContext()
		const companyOid = ctx?.company ? new Types.ObjectId(ctx.company) : null
		const rows = await this.orderModel
			.aggregate([
				{
					$match: {
						...(companyOid ? { company: companyOid } : {}),
						user: new Types.ObjectId(String(userId)),
						isCompleted: false,
					},
				},
				{ $unwind: '$items' },
				{
					$group: {
						_id: '$items.product',
						qty: { $sum: { $ifNull: ['$items.quantity', 0] } },
					},
				},
			])
			.exec()
		const map = new Map<string, number>()
		for (const r of rows as any[]) {
			if (!r._id) continue
			map.set(String(r._id), Number(r.qty || 0))
		}
		return map
	}

	async getOrdersSummaryForUser(
		user: UserModel
	): Promise<{ ordersTotal: number; ordersCount: number }> {
		const ctx = getTenantContext()
		const companyOid = ctx?.company ? new Types.ObjectId(ctx.company) : null
		const rows = await this.orderModel
			.aggregate([
				{
					$match: {
						...(companyOid ? { company: companyOid } : {}),
						user: new Types.ObjectId(String(user._id)),
						isCompleted: false,
					},
				},
				{
					$group: {
						_id: null,
						total: { $sum: { $ifNull: ['$totalAmount', 0] } },
						count: { $sum: 1 },
					},
				},
			])
			.exec()
		const r = (rows as any[])[0]
		return {
			ordersTotal: Number(r?.total || 0),
			ordersCount: Number(r?.count || 0),
		}
	}

	async listMerged(user: UserModel) {
		const products = await this.productModel.find({ deletedAt: null }).exec()
		const cabinetItems = await this.cabinetModel
			.find({ user: user._id, deletedAt: null })
			.exec()
		const pendingByProduct = await this.getUserPendingOrderQtyByProduct(
			user._id
		)
		const byProduct = new Map<string, CabinetItem>()
		const customs: CabinetItem[] = []
		for (const it of cabinetItems) {
			if (it.product) byProduct.set(String(it.product), it)
			else customs.push(it)
		}
		const merged = products.map((p) => {
			const cab = byProduct.get(String(p._id))
			return {
				productId: String(p._id),
				productName: p.name,
				category: p.category,
				price: p.price,
				stockQty: p.quantity,
				targetQty: p.targetQty || 0,
				cabinetItemId: cab?._id?.toString() || null,
				baseQty: cab?.baseQty || 0,
				currentQty: cab?.currentQty || 0,
				inOrderQty: pendingByProduct.get(String(p._id)) || 0,
				note: cab?.note || '',
				isCustom: false,
			}
		})
		const customRows = customs.map((c) => ({
			productId: null,
			productName: c.customName || '(своя позиция)',
			category: null,
			price: c.customPrice || 0,
			stockQty: null,
			targetQty: 0,
			cabinetItemId: c._id?.toString(),
			baseQty: c.baseQty,
			currentQty: c.currentQty,
			inOrderQty: 0,
			note: c.note || '',
			cover: c.cover || null,
			coverColor: c.coverColor || null,
			photo: c.photo || null,
			isCustom: true,
		}))
		return [...merged, ...customRows]
	}

	async listAllForCompany() {
		return this.cabinetModel
			.find({ deletedAt: null })
			.populate('product')
			.populate('user', 'name login')
			.sort({ user: 1, position: 1 })
			.exec()
	}

	async getSummary() {
		const ctx = getTenantContext()
		const companyOid = ctx?.company ? new Types.ObjectId(ctx.company) : null
		const productCollection = this.productModel.collection.name
		const ordersCollection = this.orderModel.collection.name

		const agg = await this.cabinetModel.aggregate([
			{ $match: { deletedAt: null, product: { $ne: null } } },
			{
				$group: {
					_id: '$product',
					totalBaseQty: { $sum: '$baseQty' },
					totalCurrentQty: { $sum: '$currentQty' },
					usersCount: { $sum: 1 },
				},
			},
			{
				$lookup: {
					from: productCollection,
					let: { pid: '$_id' },
					pipeline: [
						{
							$match: {
								$expr: companyOid
									? {
										$and: [
											{ $eq: ['$_id', '$$pid'] },
											{ $eq: ['$company', companyOid] },
										],
									}
									: { $eq: ['$_id', '$$pid'] },
							},
						},
					],
					as: 'product',
				},
			},
			{ $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
			{
				$lookup: {
					from: ordersCollection,
					let: { pid: '$_id' },
					pipeline: [
						{
							$match: {
								$expr: {
									$and: [
										{ $eq: ['$isCompleted', false] },
										...(companyOid
											? [{ $eq: ['$company', companyOid] }]
											: []),
									],
								},
							},
						},
						{ $unwind: '$items' },
						{ $match: { $expr: { $eq: ['$items.product', '$$pid'] } } },
						{
							$group: {
								_id: null,
								qty: { $sum: { $ifNull: ['$items.quantity', 0] } },
							},
						},
					],
					as: '_ord',
				},
			},
			{
				$addFields: {
					totalInOrders: {
						$ifNull: [{ $arrayElemAt: ['$_ord.qty', 0] }, 0],
					},
				},
			},
			{
				$project: {
					_id: 0,
					productId: '$_id',
					name: '$product.name',
					category: '$product.category',
					price: '$product.price',
					stockQty: '$product.quantity',
					productTargetQty: { $ifNull: ['$product.targetQty', 0] },
					totalBaseQty: 1,
					totalCurrentQty: 1,
					totalInOrders: 1,
					totalDeficit: {
						$max: [
							{
								$subtract: [
									{
										$subtract: [
											'$totalBaseQty',
											'$totalCurrentQty',
										],
									},
									'$totalInOrders',
								],
							},
							0,
						],
					},
					usersCount: 1,
				},
			},
			{ $sort: { totalDeficit: -1, name: 1 } },
		])

		return agg
	}

	async createOrUpsert(dto: CreateCabinetItemDto, user: UserModel): Promise<CabinetItem> {
		const companyId = (user as any).company ? String((user as any).company) : null
		const isCustom = !dto.product
		if (isCustom && !dto.customName) {
			throw new BadRequestException('Для своей позиции укажите название')
		}
		if (dto.product) {
			const product = await this.productModel.findById(dto.product).exec()
			if (!product) throw new NotFoundException('Товар не найден')
			if (companyId && product.company && String(product.company) !== companyId) {
				throw new ForbiddenException('Товар принадлежит другой компании')
			}

			const existing = await this.cabinetModel
				.findOne({ user: user._id, product: dto.product, deletedAt: null })
				.exec()
			if (existing) {
				existing.baseQty = dto.baseQty
				existing.currentQty = dto.currentQty
				if (dto.note !== undefined) existing.note = dto.note
				await existing.save()
				this.emitCabinetChanged()
				return existing
			}
		}

		const created = new this.cabinetModel({
			user: user._id,
			product: dto.product || undefined,
			customName: dto.customName || undefined,
			baseQty: dto.baseQty,
			currentQty: dto.currentQty,
			customPrice: dto.customPrice || 0,
			note: dto.note,
			cover: (isCustom && dto.cover) || undefined,
			coverColor: (isCustom && dto.coverColor) || undefined,
			...(companyId ? { company: companyId } : {}),
		})
		await created.save()
		this.emitCabinetChanged()
		return created
	}

	async update(id: string, dto: UpdateCabinetItemDto, user: UserModel): Promise<CabinetItem> {
		const item = await this.cabinetModel.findById(id).exec()
		if (!item || item.deletedAt) throw new NotFoundException('Позиция личного склада не найдена')
		if (String(item.user) !== String(user._id)) {
			throw new ForbiddenException('Нельзя редактировать чужой кабинет')
		}
		if (dto.baseQty !== undefined) item.baseQty = dto.baseQty
		if (dto.currentQty !== undefined) item.currentQty = dto.currentQty
		if (dto.note !== undefined) item.note = dto.note
		if (dto.customPrice !== undefined) item.customPrice = dto.customPrice
		if (dto.customName !== undefined && item.customName !== undefined) item.customName = dto.customName
		// у позиции со склада обложка товара
		if (dto.coverColor !== undefined && !item.product) item.coverColor = dto.coverColor
		if (dto.cover !== undefined && !item.product) item.cover = dto.cover
		await item.save()
		this.emitCabinetChanged()
		return item
	}

	async softDelete(id: string, user: UserModel): Promise<CabinetItem> {
		const item = await this.cabinetModel.findById(id).exec()
		if (!item) throw new NotFoundException('Позиция не найдена')
		if (String(item.user) !== String(user._id)) {
			throw new ForbiddenException('Нельзя удалять чужой кабинет')
		}
		item.deletedAt = new Date()
		// Прежний документ: удаляется фото, которое было у позиции в момент удаления, даже если его только что заменили
		const before = await this.cabinetModel.findByIdAndUpdate(id, { deletedAt: item.deletedAt, photo: null }).exec()
		if (before?.photo) await this.photoModel.deleteOne({ token: before.photo }).exec()
		item.photo = null
		this.emitCabinetChanged()
		return item
	}

	private async ownCustomItem(id: string, user: UserModel) {
		const item = await this.cabinetModel.findOne({ _id: id, deletedAt: null }).select('company user product photo').exec()
		if (!item) throw new NotFoundException('Позиция личного склада не найдена')
		if (String(item.user) !== String(user._id)) throw new ForbiddenException('Нельзя редактировать чужой кабинет')
		if (item.product) throw new BadRequestException('У позиции со склада обложка товара')
		return item
	}

	async setPhoto(id: string, data: Buffer | undefined, user: UserModel) {
		const contentType = imageType(data)
		if (!contentType) throw new BadRequestException('Нужна картинка WebP, PNG или JPEG')
		const item = await this.ownCustomItem(id, user)
		const size = { $binarySize: '$data' }
		// как у товара: сначала запись, потом подсчёт вместе с ней — одновременные загрузки пределы не превысят
		const token = randomBytes(16).toString('hex')
		await this.photoModel.create({ company: item.company, user: item.user, token, contentType, data })
		const [used] = await this.photoModel
			.aggregate([
				// нынешнее фото позиции не считается: при замене оно удаляется
				{ $match: { company: item.company, token: { $ne: item.photo ?? null } } },
				{
					$group: {
						_id: null,
						all: { $sum: size },
						own: { $sum: { $cond: [{ $gt: ['$user', null] }, size, 0] } },
						mine: { $sum: { $cond: [{ $eq: ['$user', item.user] }, size, 0] } },
					},
				},
			])
			.exec()
		const over =
			(used?.all || 0) > PHOTO_QUOTA
				? 'Превышен объём фото местности'
				: (used?.own || 0) > OWN_PHOTO_QUOTA
					? 'Превышен объём фото личных складов местности'
					: (used?.mine || 0) > USER_PHOTO_QUOTA && 'Превышен объём ваших фото в «Моём складе»'
		if (over) {
			await this.photoModel.deleteOne({ token }).exec()
			throw new PayloadTooLargeException(over)
		}
		return this.swapPhoto(id, token)
	}

	async removePhoto(id: string, user: UserModel) {
		await this.ownCustomItem(id, user)
		return this.swapPhoto(id, null)
	}

	// Прежний документ: удаляется ровно та картинка, которую заменили, даже при двух загрузках сразу
	private async swapPhoto(id: string, photo: string | null) {
		const before = await this.cabinetModel.findOneAndUpdate({ _id: id, deletedAt: null }, { photo }).exec()
		if (!before) {
			// позицию удалили между проверкой и записью — новая картинка ей уже не нужна
			if (photo) await this.photoModel.deleteOne({ token: photo }).exec()
			throw new NotFoundException('Позиция личного склада не найдена')
		}
		if (before.photo) await this.photoModel.deleteOne({ token: before.photo }).exec()
		this.emitCabinetChanged()
		return { ...before.toObject(), photo }
	}

	async replenishAfterOrder(orderItems: Array<{ product: any; quantity: number }>, userId: any) {
		if (!Array.isArray(orderItems) || !orderItems.length) return
		const userObjId = new Types.ObjectId(String(userId))
		for (const oi of orderItems) {
			const productId = oi.product?._id || oi.product
			if (!productId) continue
			const productObjId = new Types.ObjectId(String(productId))
			const qty = oi.quantity || 0
			if (qty <= 0) continue
			await this.cabinetModel
				.updateOne(
					{ user: userObjId, product: productObjId, deletedAt: null },
					{
						$inc: { currentQty: qty },
						$setOnInsert: { baseQty: 0, position: 0, createdAt: Date.now() },
					},
					{ upsert: true }
				)
				.exec()
		}
	}

	async computeAutofill(user: UserModel): Promise<AutofillSuggestion[]> {
		const items = await this.cabinetModel
			.find({ user: user._id, deletedAt: null })
			.populate('product')
			.exec()

		const productIds = items
			.map((i: any) => i.product?._id)
			.filter(Boolean)
			.map(String)
		const reservedByProduct = new Map<string, number>()
		if (productIds.length) {
			const uncompletedOrders = await this.orderModel
				.find({
					isCompleted: false,
					'items.product': { $in: productIds },
				})
				.exec()
			for (const order of uncompletedOrders) {
				for (const item of order.items || []) {
					const pid = String(item.product)
					if (!productIds.includes(pid)) continue
					reservedByProduct.set(
						pid,
						(reservedByProduct.get(pid) || 0) + (item.quantity || 0)
					)
				}
			}
		}

		const userPendingByProduct = await this.getUserPendingOrderQtyByProduct(
			user._id
		)

		const suggestions: AutofillSuggestion[] = []
		for (const cab of items) {
			const product: any = cab.product
			if (!product || product.deletedAt) {
				const needed = Math.max(0, cab.baseQty - cab.currentQty)
				if (needed > 0) {
					suggestions.push({
						product: product?._id?.toString() || '',
						productName: product?.name || cab.customName || '(своя)',
						category: product?.category,
						price: 0,
						neededQty: needed,
						availableQty: 0,
						isMissing: true,
					})
				}
				continue
			}
			const myPending = userPendingByProduct.get(String(product._id)) || 0
			const needed = Math.max(
				0,
				cab.baseQty - cab.currentQty - myPending
			)
			const reserved = reservedByProduct.get(String(product._id)) || 0
			const available = Math.max(0, (product.quantity || 0) - reserved)
			suggestions.push({
				product: String(product._id),
				productName: product.name,
				category: product.category,
				price: product.price || 0,
				neededQty: needed,
				availableQty: available,
				isMissing: needed > 0 && available < needed,
			})
		}
		return suggestions
	}
}
