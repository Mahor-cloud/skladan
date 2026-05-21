/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import {
	BadRequestException,
	ForbiddenException,
	Inject,
	Injectable,
	NotFoundException,
	forwardRef,
} from '@nestjs/common'
import { ModelType, Ref } from '@typegoose/typegoose/lib/types'
import { InjectModel } from 'nestjs-typegoose'
import { UserModel } from 'src/auth/user.model'
import { CabinetService } from 'src/cabinet/cabinet.service'
import { ChangeHistoryService } from 'src/change-history/change-history.service'
import { CounterService } from 'src/common/counters/counter.service'
import { Inventory } from 'src/inventory/inventory.model'
import { Product } from 'src/products/product.model'
import { Role } from 'src/roles/role.model'
import { CreateOrderDto } from './dto/create-order.dto'
import { UpdateOrderDto } from './dto/update-order.dto'
import { Order } from './order.model'

@Injectable()
export class OrdersService {
	constructor(
		@InjectModel(Order) private readonly orderModel: ModelType<Order>,
		@InjectModel(Role) private readonly roleModel: ModelType<Role>,
		@InjectModel(Product) private readonly productModel: ModelType<Product>,
		@InjectModel(Inventory) private readonly inventoryModel: ModelType<Inventory>,
		private readonly changeHistoryService: ChangeHistoryService,
		private readonly counterService: CounterService,
		@Inject(forwardRef(() => CabinetService))
		private readonly cabinetService: CabinetService
	) {}

	async computeShortages(): Promise<
		Array<{
			product: string
			productName: string
			required: number
			inStock: number
			orderNumbers: number[]
			orderIds: string[]
		}>
	> {
		const rows = (await this.orderModel
			.aggregate([
				{ $match: { isCompleted: false } },
				{ $unwind: '$items' },
				{
					$group: {
						_id: '$items.product',
						required: {
							$sum: { $ifNull: ['$items.quantity', 0] },
						},
						orderIds: { $addToSet: '$_id' },
						orderNumbers: { $addToSet: '$orderNumber' },
					},
				},
			])
			.exec()) as any[]
		if (!rows.length) return []
		const productIds = rows.map((r) => r._id).filter(Boolean)
		const products = await this.productModel
			.find({ _id: { $in: productIds } })
			.exec()
		const stockById = new Map(
			products.map((p) => [String(p._id), p])
		)
		const out: Array<{
			product: string
			productName: string
			required: number
			inStock: number
			orderNumbers: number[]
			orderIds: string[]
		}> = []
		for (const r of rows) {
			const pid = r._id ? String(r._id) : ''
			const p = stockById.get(pid)
			if (!p) continue
			const inStock = p.quantity || 0
			const required = Number(r.required) || 0
			if (required > inStock) {
				out.push({
					product: pid,
					productName: p.name,
					required,
					inStock,
					orderNumbers: ((r.orderNumbers as number[]) || [])
						.slice()
						.sort((a, b) => a - b),
					orderIds: ((r.orderIds as any[]) || []).map(String),
				})
			}
		}
		return out
	}

	async createOrder(
		createOrderDto: CreateOrderDto[] & { approveTargetExceed?: boolean },
		currentUser: UserModel
	): Promise<Order> {
		const companyId = String((currentUser as any).company || currentUser.company)
		if (!companyId || companyId === 'null') {
			throw new BadRequestException('Заказ можно создать только в контексте компании')
		}

		const activeInventory = await this.inventoryModel
			.findOne({ isCompleted: false })
			.exec()
		if (activeInventory) {
			throw new BadRequestException({
				code: 'ACTIVE_INVENTORY',
				message:
					'Идёт инвентаризация — создание заказов невозможно. Свяжитесь с администратором.',
			})
		}

		const approveTargetExceed = Array.isArray(createOrderDto)
			? (createOrderDto as any[]).some((i) => i?.__approveTargetExceed === true)
			: (createOrderDto as any)?.__approveTargetExceed === true
		const items: CreateOrderDto[] = Array.isArray(createOrderDto)
			? (createOrderDto as any[]).filter((i) => !i.__approveTargetExceed)
			: []

		if (!items.length) {
			throw new BadRequestException('Заказ должен содержать хотя бы одну позицию')
		}

		const productIds = items.map((i) => i.product).filter(Boolean)
		const products = productIds.length
			? await this.productModel.find({ _id: { $in: productIds } }).exec()
			: []
		const productById = new Map(products.map((p) => [String(p._id), p]))

		const userRole = currentUser.role
			? await this.roleModel.findById(currentUser.role).exec()
			: null
		const canApproveExceed =
			currentUser.isAdmin ||
			(userRole?.permissions || []).includes('approve_target_exceed')
		for (const it of items) {
			const product = productById.get(String(it.product))
			if (product && product.targetQty > 0 && it.quantity > product.targetQty) {
				if (!canApproveExceed || !approveTargetExceed) {
					throw new BadRequestException({
						code: 'TARGET_EXCEED',
						product: String(product._id),
						productName: product.name,
						targetQty: product.targetQty,
						requested: it.quantity,
						message: `По товару "${product.name}" указано не больше ${product.targetQty} (запрошено ${it.quantity}). Требуется подтверждение администратора.`,
					})
				}
			}
		}

		await this.assertStockAvailable(
			items.map((i) => ({ product: String(i.product), quantity: i.quantity })),
			productById,
			null
		)

		const orderNumber = await this.counterService.getNext(companyId, 'order')

		let totalAmount = 0
		for (const item of items) {
			const product = productById.get(String(item.product))
			if (product) totalAmount += (item.quantity || 0) * (product.price || 0)
		}

		const createdOrder = new this.orderModel({
			orderNumber,
			items,
			user: currentUser._id,
			totalAmount,
			company: companyId,
		})
		await createdOrder.save()

		await this.changeHistoryService.createChangeHistory({
			user: currentUser._id,
			relatedUser: createdOrder.user,
			changeType: 'order-created',
			description: `${currentUser.name} Заказ ${createdOrder.orderNumber} создан.`,
			changeDate: Date.now(),
		})
		return createdOrder
	}

	async findAll(): Promise<Order[]> {
		return this.orderModel
			.find()
			.populate({
				path: 'user',
				select: '_id name isAdmin',
			})
			.exec()
	}

	async findOne(id: string): Promise<Order> {
		const order = await this.orderModel
			.findById(id)
			.populate({
				path: 'user',
				select: '_id name isAdmin',
			})
			.populate({
				path: 'items.product',
				model: 'Product',
			})
			.exec()
		if (!order) throw new NotFoundException('Заказ не найден')
		return order
	}

	async update(
		id: string,
		updateOrderDto: UpdateOrderDto,
		currentUser: UserModel
	): Promise<Order> {
		const oldOrder = await this.orderModel.findById(id).exec()
		if (!oldOrder) throw new NotFoundException('Заказ не найден')

		const userRole = currentUser.role
			? await this.roleModel.findById(currentUser.role).exec()
			: null

		const isOwner = oldOrder.user.toString() === currentUser._id.toString()
		const isAdmin = !!currentUser.isAdmin
		const canApprovePayment =
			isAdmin || (userRole?.permissions || []).includes('approve-payment')
		const canEditOrders =
			isAdmin || (userRole?.permissions || []).includes('edit_orders')

		if (!isOwner && !isAdmin && !canApprovePayment && !canEditOrders) {
			throw new ForbiddenException('У вас нет прав для доступа к этому заказу')
		}
		const isMainAdmin = userRole?.isSystem === true
		if (oldOrder.isCompleted) {
			const wantsItemsEdit = Array.isArray(updateOrderDto.items)
			if (!isMainAdmin || !wantsItemsEdit) {
				throw new BadRequestException('Заказ уже завершен')
			}
			if (!updateOrderDto.editReason?.trim()) {
				throw new BadRequestException(
					'Для изменения завершённого заказа укажите причину (editReason)'
				)
			}
			return this.editCompletedOrderByAdmin(
				oldOrder,
				updateOrderDto,
				currentUser
			)
		}

		if (
			updateOrderDto.confirmedPaid !== undefined &&
			updateOrderDto.confirmedPaid &&
			!oldOrder.confirmedPaid
		) {
			if (!userRole?.permissions?.includes('approve-payment')) {
				throw new ForbiddenException('У вас нет прав для подтверждения платежа')
			}
		}

		if (
			updateOrderDto.isPaid === true &&
			!oldOrder.isPaid &&
			!isOwner &&
			!canEditOrders
		) {
			throw new ForbiddenException(
				'Отметить заказ оплаченным может только заказчик или служащий с правом редактирования заказов'
			)
		}

		if (updateOrderDto.confirmedPaid === true && !oldOrder.isPaid && updateOrderDto.isPaid !== true) {
			throw new BadRequestException(
				'Нельзя подтвердить оплату до того, как заказ отмечен как оплаченный'
			)
		}
		if (updateOrderDto.isCompleted === true && !oldOrder.confirmedPaid && updateOrderDto.confirmedPaid !== true) {
			throw new BadRequestException(
				'Нельзя завершить заказ до подтверждения оплаты казначеем'
			)
		}
		if (updateOrderDto.isPaid === false && oldOrder.isPaid) {
			throw new BadRequestException(
				'Отметку «оплачен» нельзя снять. Если нужна корректировка — отмените заказ или измените позиции'
			)
		}

		const itemsChanged =
			Array.isArray(updateOrderDto.items) &&
			!this.itemsEqual(oldOrder.items as any, updateOrderDto.items as any)

		if (itemsChanged) {
			const ownerStage5 = isOwner && !oldOrder.isPaid
			const ownerStage6 = isOwner && oldOrder.isPaid && !oldOrder.confirmedPaid
			if (!ownerStage5 && !ownerStage6 && !canEditOrders) {
				throw new ForbiddenException(
					'У вас нет прав для изменения позиций этого заказа'
				)
			}

			if (oldOrder.isPaid && !updateOrderDto.editReason?.trim()) {
				throw new BadRequestException(
					'При изменении оплаченного заказа укажите причину (editReason)'
				)
			}
		}

		const patch: any = { ...updateOrderDto }
		delete patch.editReason
		delete patch.approveTargetExceed

		let newTotalAmount = oldOrder.totalAmount || 0
		let productById = new Map<string, any>()

		if (updateOrderDto.items) {
			const productIds = updateOrderDto.items.map((i) => i.product).filter(Boolean)
			const products = productIds.length
				? await this.productModel.find({ _id: { $in: productIds } }).exec()
				: []
			productById = new Map(products.map((p) => [String(p._id), p]))

			await this.assertStockAvailable(
				updateOrderDto.items,
				productById,
				String(oldOrder._id)
			)

			const canApproveExceed =
				isAdmin ||
				(userRole?.permissions || []).includes('approve_target_exceed')
			for (const it of updateOrderDto.items) {
				const product = productById.get(String(it.product))
				if (
					product &&
					product.targetQty > 0 &&
					it.quantity > product.targetQty
				) {
					if (!canApproveExceed || !updateOrderDto.approveTargetExceed) {
						throw new BadRequestException({
							code: 'TARGET_EXCEED',
							product: String(product._id),
							productName: product.name,
							targetQty: product.targetQty,
							requested: it.quantity,
							message: `По товару "${product.name}" указано не больше ${product.targetQty} (запрошено ${it.quantity}). Требуется подтверждение администратора.`,
						})
					}
				}
			}

			newTotalAmount = 0
			for (const item of updateOrderDto.items) {
				const product = productById.get(String(item.product))
				if (product)
					newTotalAmount += (item.quantity || 0) * (product.price || 0)
			}
			patch.totalAmount = newTotalAmount
		}

		const eventsToAppend: any[] = []
		if (itemsChanged && oldOrder.isPaid) {
			const alreadyCommitted =
				oldOrder.paidAmount && oldOrder.paidAmount > 0
					? oldOrder.paidAmount
					: oldOrder.totalAmount || 0
			const diff = newTotalAmount - alreadyCommitted
			patch.confirmedPaid = false
			eventsToAppend.push({
				type: 'items-changed',
				amount: newTotalAmount - (oldOrder.totalAmount || 0),
				by: currentUser._id,
				at: Date.now(),
				reason: updateOrderDto.editReason || '',
				note: `Сумма заказа: ${oldOrder.totalAmount || 0} → ${newTotalAmount} руб`,
			})
			if (diff > 0) {
				eventsToAppend.push({
					type: 'surcharge-pending',
					amount: diff,
					by: currentUser._id,
					at: Date.now(),
					reason: updateOrderDto.editReason || '',
					note: `Всего к оплате: ${newTotalAmount} руб. Если предыдущий заказ уже оплачен — доплатить ${diff} руб`,
				})
			} else if (diff < 0) {
				eventsToAppend.push({
					type: 'refund-pending',
					amount: diff,
					by: currentUser._id,
					at: Date.now(),
					reason: updateOrderDto.editReason || '',
					note: `Всего к оплате: ${newTotalAmount} руб. Сумма уменьшилась — возврат ${Math.abs(diff)} руб`,
				})
			}
		}

		if (
			updateOrderDto.isPaid === true &&
			!oldOrder.isPaid
		) {
			eventsToAppend.push({
				type: 'paid',
				amount: newTotalAmount,
				by: currentUser._id,
				at: Date.now(),
				note: `Заказчик отметил заказ как оплаченный`,
			})
		}

		if (
			updateOrderDto.confirmedPaid === true &&
			!oldOrder.confirmedPaid
		) {
			eventsToAppend.push({
				type: 'payment-confirmed',
				amount: newTotalAmount,
				by: currentUser._id,
				at: Date.now(),
				note: `Казначей подтвердил оплату на сумму ${newTotalAmount} руб`,
			})
			patch.paidAmount = newTotalAmount
		}

		if (eventsToAppend.length) {
			patch.$push = { paymentEvents: { $each: eventsToAppend } }
		}

		const isCompletingNow =
			updateOrderDto.isCompleted === true && !oldOrder.isCompleted

		if (isCompletingNow) {
			const shortages = await this.computeShortages()
			const blocking = shortages.filter((s) =>
				s.orderIds.includes(String(id))
			)
			if (blocking.length) {
				throw new BadRequestException({
					code: 'STOCK_SHORTAGE',
					message: `Нельзя завершить: дефицит по товарам — ${blocking
						.map(
							(b) =>
								`${b.productName} (требуется ${b.required}, на складе ${b.inStock})`
						)
						.join(
							'; '
						)}. Пополните склад или скорректируйте заказы.`,
					products: blocking,
				})
			}
		}

		let updatedOrder: Order | null
		if (isCompletingNow) {
			updatedOrder = await this.orderModel
				.findOneAndUpdate(
					{ _id: id, isCompleted: { $ne: true } },
					patch,
					{ new: true }
				)
				.exec()
			if (!updatedOrder) {

				return (await this.orderModel.findById(id).exec()) as Order
			}
			await this.updateProducts(updatedOrder.items)
			await this.cabinetService.replenishAfterOrder(
				updatedOrder.items as any,
				updatedOrder.user
			)
		} else {
			updatedOrder = await this.orderModel
				.findByIdAndUpdate(id, patch, { new: true })
				.exec()
			if (!updatedOrder) throw new NotFoundException('Заказ не найден')
		}

		const changes = this.getChanges(oldOrder, updatedOrder)
		const reasonSuffix = updateOrderDto.editReason
			? ` Причина: ${updateOrderDto.editReason}`
			: ''

		await this.changeHistoryService.createChangeHistory({
			user: currentUser._id,
			relatedUser: updatedOrder.user,
			changeType: 'order-updated',
			description: `${currentUser.name}: Заказ ${updatedOrder.orderNumber} обновлен. Изменения: ${changes}.${reasonSuffix}`,
			changeDate: Date.now(),
		})

		for (const ev of eventsToAppend) {
			if (ev.type === 'surcharge-pending') {
				await this.changeHistoryService.createChangeHistory({
					user: currentUser._id,
					changeType: 'order-surcharge-pending',
					description: `Заказ ${updatedOrder.orderNumber}: всего к оплате ${updatedOrder.totalAmount} руб. Если уже оплачен — доплатить ${ev.amount} руб.${reasonSuffix}`,
					changeDate: Date.now(),
				})
			} else if (ev.type === 'refund-pending') {
				await this.changeHistoryService.createChangeHistory({
					user: currentUser._id,
					changeType: 'order-refund-pending',
					description: `Заказ ${updatedOrder.orderNumber}: всего к оплате ${updatedOrder.totalAmount} руб. Сумма уменьшилась — возврат ${Math.abs(ev.amount)} руб.${reasonSuffix}`,
					changeDate: Date.now(),
				})
			}
		}

		return updatedOrder
	}

	private async editCompletedOrderByAdmin(
		oldOrder: Order,
		dto: UpdateOrderDto,
		currentUser: UserModel
	): Promise<Order> {
		const newItems = (dto.items || []).map((i) => ({
			product: String(i.product),
			quantity: Number(i.quantity) || 0,
		}))
		if (!newItems.length) {
			throw new BadRequestException('Заказ не может быть пустым')
		}

		const productIds = newItems.map((i) => i.product)
		const products = productIds.length
			? await this.productModel.find({ _id: { $in: productIds } }).exec()
			: []
		const productById = new Map(products.map((p) => [String(p._id), p]))

		const oldByProduct = new Map<string, number>()
		for (const it of oldOrder.items || []) {
			const pid = String((it.product as any)?._id || it.product)
			oldByProduct.set(pid, (oldByProduct.get(pid) || 0) + (it.quantity || 0))
		}
		const newByProduct = new Map<string, number>()
		for (const it of newItems) {
			newByProduct.set(
				it.product,
				(newByProduct.get(it.product) || 0) + it.quantity
			)
		}

		const allPids = new Set<string>([
			...oldByProduct.keys(),
			...newByProduct.keys(),
		])
		for (const pid of allPids) {
			const delta = (oldByProduct.get(pid) || 0) - (newByProduct.get(pid) || 0)
			if (delta === 0) continue
			await this.productModel
				.updateOne({ _id: pid }, { $inc: { quantity: delta } })
				.exec()
		}

		let newTotalAmount = 0
		for (const it of newItems) {
			const p = productById.get(it.product)
			if (p) newTotalAmount += it.quantity * (p.price || 0)
		}

		const base =
			oldOrder.paidAmount && oldOrder.paidAmount > 0
				? oldOrder.paidAmount
				: oldOrder.totalAmount || 0
		const diff = newTotalAmount - base
		const reason = dto.editReason?.trim() || ''
		const eventsToAppend: any[] = [
			{
				type: 'items-changed',
				amount: newTotalAmount - (oldOrder.totalAmount || 0),
				by: currentUser._id,
				at: Date.now(),
				reason,
				note: `Завершённый заказ изменён админом. Сумма: ${
					oldOrder.totalAmount || 0
				} → ${newTotalAmount} руб`,
			},
		]
		if (diff > 0) {
			eventsToAppend.push({
				type: 'surcharge-pending',
				amount: diff,
				by: currentUser._id,
				at: Date.now(),
				reason,
				note: `Требуется доплата ${diff} руб (заказ был завершён).`,
			})
		} else if (diff < 0) {
			eventsToAppend.push({
				type: 'refund-pending',
				amount: diff,
				by: currentUser._id,
				at: Date.now(),
				reason,
				note: `Требуется возврат ${Math.abs(diff)} руб (заказ был завершён).`,
			})
		}

		const patch: any = {
			items: newItems,
			totalAmount: newTotalAmount,
			$push: { paymentEvents: { $each: eventsToAppend } },
		}
		if (typeof dto.comment === 'string') patch.comment = dto.comment

		const updatedOrder = await this.orderModel
			.findByIdAndUpdate(oldOrder._id, patch, { new: true })
			.exec()
		if (!updatedOrder) throw new NotFoundException('Заказ не найден')

		await this.changeHistoryService.createChangeHistory({
			user: currentUser._id,
			relatedUser: updatedOrder.user,
			changeType: 'order-updated',
			description: `${currentUser.name}: Завершённый заказ ${updatedOrder.orderNumber} изменён админом. Сумма ${
				oldOrder.totalAmount || 0
			} → ${newTotalAmount} руб. Причина: ${reason}`,
			changeDate: Date.now(),
		})
		if (diff > 0) {
			await this.changeHistoryService.createChangeHistory({
				user: currentUser._id,
				changeType: 'order-surcharge-pending',
				description: `Завершённый заказ ${updatedOrder.orderNumber}: требуется доплата ${diff} руб. Причина: ${reason}`,
				changeDate: Date.now(),
			})
		} else if (diff < 0) {
			await this.changeHistoryService.createChangeHistory({
				user: currentUser._id,
				changeType: 'order-refund-pending',
				description: `Завершённый заказ ${updatedOrder.orderNumber}: требуется возврат ${Math.abs(
					diff
				)} руб. Причина: ${reason}`,
				changeDate: Date.now(),
			})
		}

		return updatedOrder
	}

	private itemsEqual(
		a: { product: any; quantity: number }[] | undefined,
		b: { product: any; quantity: number }[] | undefined
	): boolean {
		if (!a || !b) return false
		if (a.length !== b.length) return false
		const norm = (arr: any[]) =>
			arr
				.map((i) => ({
					p: String(i.product?._id || i.product),
					q: i.quantity || 0,
				}))
				.sort((x, y) => x.p.localeCompare(y.p))
		const an = norm(a as any)
		const bn = norm(b as any)
		for (let i = 0; i < an.length; i++) {
			if (an[i].p !== bn[i].p || an[i].q !== bn[i].q) return false
		}
		return true
	}

	private async assertStockAvailable(
		items: { product: string; quantity: number }[],
		productById: Map<string, any>,
		excludeOrderId: string | null
	): Promise<void> {

		const productIds = items.map((i) => i.product).filter(Boolean)
		const findFilter: any = {
			isCompleted: false,
			'items.product': { $in: productIds },
		}
		if (excludeOrderId) {
			findFilter._id = { $ne: excludeOrderId }
		}
		const otherOrders = await this.orderModel.find(findFilter).exec()
		const committed: Record<string, number> = {}
		for (const o of otherOrders) {
			for (const it of o.items || []) {
				const pid = String((it.product as any)?._id || it.product)
				committed[pid] = (committed[pid] || 0) + (it.quantity || 0)
			}
		}
		for (const item of items) {
			const product = productById.get(String(item.product))
			if (!product) {
				throw new BadRequestException({
					code: 'PRODUCT_NOT_FOUND',
					product: String(item.product),
					message: `Товар ${item.product} не найден в вашей компании`,
				})
			}
			if (!item.quantity || item.quantity < 1) {
				throw new BadRequestException({
					code: 'INVALID_QUANTITY',
					product: String(product._id),
					productName: product.name,
					message: `Количество товара "${product.name}" должно быть не меньше 1`,
				})
			}
			const available =
				(product.quantity || 0) - (committed[String(item.product)] || 0)
			if (item.quantity > available) {
				throw new BadRequestException({
					code: 'INSUFFICIENT_STOCK',
					product: String(product._id),
					productName: product.name,
					requested: item.quantity,
					available,
					message: `Недостаточно товара "${product.name}" на складе: запрошено ${item.quantity}, доступно ${available}.`,
				})
			}
		}
	}

	private async updateProducts(
		items: { product: Ref<Product>; quantity: number }[]
	): Promise<void> {

		for (const item of items) {
			await this.productModel
				.updateOne(
					{ _id: item.product },
					{ $inc: { quantity: -(item.quantity || 0) } }
				)
				.exec()
		}
	}

	async remove(id: string, currentUser: UserModel): Promise<Order> {
		const order = await this.orderModel.findById(id).exec()
		if (!order) throw new NotFoundException('Заказ не найден')

		if (
			order.user.toString() !== currentUser._id.toString() &&
			!currentUser.isAdmin
		) {
			throw new ForbiddenException('У вас нет прав для доступа к этому заказу')
		}

		if (order.isCompleted) {
			throw new BadRequestException('Заказ уже завершен — нельзя удалить')
		}

		const removedOrder = await this.orderModel.findByIdAndDelete(id).exec()

		const refundAmount =
			removedOrder.paidAmount && removedOrder.paidAmount > 0
				? removedOrder.paidAmount
				: removedOrder.isPaid
					? removedOrder.totalAmount || 0
					: 0

		await this.changeHistoryService.createChangeHistory({
			user: currentUser._id,
			relatedUser: removedOrder.user,
			changeType: 'order-deleted',
			description:
				`${currentUser.name}: Заказ ${removedOrder.orderNumber} удален.` +
				(refundAmount > 0
					? ` Заказ был оплачен — требуется возврат ${refundAmount} руб.`
					: ''),
			changeDate: Date.now(),
		})

		if (refundAmount > 0) {
			await this.changeHistoryService.createChangeHistory({
				user: currentUser._id,
				changeType: 'order-refund-pending',
				description: `Заказ ${removedOrder.orderNumber} отменён (был оплачен). Требуется возврат ${refundAmount} руб.`,
				changeDate: Date.now(),
			})
		}

		return removedOrder
	}

	private getChanges(oldOrder: Order, newOrder: Order): string {
		const changes = []
		if (JSON.stringify(oldOrder.items) !== JSON.stringify(newOrder.items)) {
			changes.push(`Список товаров изменен`)
		}
		if (oldOrder.confirmedPaid !== newOrder.confirmedPaid) {
			changes.push(
				oldOrder.confirmedPaid
					? 'Оплата не подтверждена'
					: 'Оплата подтверждена'
			)
		}
		if (oldOrder.isPaid !== newOrder.isPaid) {
			changes.push(newOrder.isPaid ? 'Заказ оплачен' : 'Заказ не оплачен')
		}
		if (oldOrder.comment !== newOrder.comment) {
			changes.push(
				`Комментарий изменен с ${oldOrder.comment} на ${newOrder.comment}`
			)
		}
		if (oldOrder.isCompleted !== newOrder.isCompleted) {
			changes.push(
				newOrder.isCompleted ? 'Заказ завершен' : 'Заказ не завершен'
			)
		}
		return changes.join(', ')
	}
}
