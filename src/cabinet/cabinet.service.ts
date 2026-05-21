/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { ModelType } from '@typegoose/typegoose/lib/types'
import { Types } from 'mongoose'
import { InjectModel } from 'nestjs-typegoose'
import { UserModel } from '../auth/user.model'
import { RealtimeService } from '../change-history/realtime.service'
import { getTenantContext } from '../common/tenant-context/tenant-context.storage'
import { Order } from '../orders/order.model'
import { Product } from '../products/product.model'
import { CabinetItem } from './cabinet-item.model'
import { CreateCabinetItemDto } from './dto/create-cabinet-item.dto'
import { UpdateCabinetItemDto } from './dto/update-cabinet-item.dto'

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
		private readonly realtime: RealtimeService
	) {}

	private emitCabinetChanged() {
		const ctx = getTenantContext()
		this.realtime.emit(ctx?.company ? String(ctx.company) : null, 'cabinet-updated')
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
		await item.save()
		this.emitCabinetChanged()
		return item
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
