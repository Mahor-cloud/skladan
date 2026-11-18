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
import { Message } from 'src/database/messages.model'
import { assertStockNotFrozen, openDocsAllowed } from 'src/inventory/inventory-lock'
import { Inventory } from 'src/inventory/inventory.model'
import { Product } from 'src/products/product.model'
import { Role } from 'src/roles/role.model'
import { keptPrices, linesSum, priceLines } from 'src/common/line-prices'
import { CreateOrderDto } from './dto/create-order.dto'
import { UpdateOrderDto } from './dto/update-order.dto'
import { Order } from './order.model'

// GET /orders window: active=1 → only unfinished; since=<ms> → unfinished + newer than since.
// No params → full list, as before (old cached PWA clients still call it that way).
// Ключ попытки оформления заказа: случайная строка от клиента
const ORDER_KEY = /^[A-Za-z0-9-]{8,64}$/

// Сколько заказчик уже внёс: сумма, подтверждённая казначеем (может быть и нулём — признак подтверждения событие,
// а не paidAmount > 0); до первого подтверждения — та, на которую он отметил оплату (событие paid), а не сумма заказа
// после прошлой правки. У старых заказов без событий — сумма заказа.
export function committedAmount(order: Pick<Order, 'paidAmount' | 'totalAmount' | 'paymentEvents'>): number {
	const events = order.paymentEvents || []
	if (order.paidAmount > 0 || events.some((e) => e.type === 'payment-confirmed')) return order.paidAmount || 0
	const paid = events.find((e) => e.type === 'paid')
	return paid?.amount ?? order.totalAmount ?? 0
}

// Сколько вернуть при удалении заказа. У завершённого правки после подтверждения уже рассчитаны отдельными записями
// (см. editCompletedOrderByAdmin), поэтому к подтверждённой сумме прибавляются их разницы; без подтверждения в событиях — сумма заказа.
export function refundOnRemove(order: Pick<Order, 'isPaid' | 'isCompleted' | 'paidAmount' | 'totalAmount' | 'paymentEvents'>): number {
	if (!order.isPaid && !(order.paidAmount > 0)) return 0
	if (!order.isCompleted) return committedAmount(order)
	const events = order.paymentEvents || []
	const confirmedAt = events.map((e) => e.type).lastIndexOf('payment-confirmed')
	if (confirmedAt < 0) return order.totalAmount || 0
	return events
		.slice(confirmedAt + 1)
		.filter((e) => e.type === 'items-changed')
		.reduce((sum, e) => sum + (e.amount || 0), order.paidAmount || 0)
}

export function ordersListFilter(active?: string, since?: string): Record<string, any> {
	const unfinished = { isCompleted: { $ne: true } }
	if (active === '1') return unfinished
	const from = Number(since)
	if (since && Number.isFinite(from)) return { $or: [unfinished, { orderDate: { $gte: from } }] }
	return {}
}

@Injectable()
export class OrdersService {
	constructor(
		@InjectModel(Order) private readonly orderModel: ModelType<Order>,
		@InjectModel(Role) private readonly roleModel: ModelType<Role>,
		@InjectModel(Product) private readonly productModel: ModelType<Product>,
		@InjectModel(Inventory) private readonly inventoryModel: ModelType<Inventory>,
		@InjectModel(Message) private readonly messageModel: ModelType<Message>,
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
		createOrderDto: CreateOrderDto[],
		currentUser: UserModel,
		clientKey?: string
	): Promise<Order> {
		const companyId = String((currentUser as any).company || currentUser.company)
		if (!companyId || companyId === 'null') {
			throw new BadRequestException('Заказ можно создать только в контексте компании')
		}

		// Повтор той же отправки (ответ не дошёл, нажали ещё раз) возвращает уже созданный заказ. Проверка первой:
		// товар под него уже занят, и повтор иначе упёрся бы в остатки.
		const key = typeof clientKey === 'string' && ORDER_KEY.test(clientKey) ? clientKey : undefined
		if (!key) return this.placeOrder(createOrderDto, currentUser, companyId)
		const sameAttempt = () => this.orderModel.findOne({ user: currentUser._id, clientKey: key }).exec()
		const existing = await sameAttempt()
		if (existing) return existing
		try {
			return await this.placeOrder(createOrderDto, currentUser, companyId, key)
		} catch (e) {
			// Такой же запрос мог успеть первым: тогда этот упёрся в занятые им остатки или в уникальный индекс
			const first = await sameAttempt()
			if (first) return first
			throw e
		}
	}

	private async placeOrder(
		createOrderDto: CreateOrderDto[],
		currentUser: UserModel,
		companyId: string,
		clientKey?: string
	): Promise<Order> {

		const activeInventory = await this.inventoryModel
			.findOne({ isCompleted: false })
			.exec()
		if (activeInventory && !(await openDocsAllowed(this.messageModel))) {
			throw new BadRequestException({
				code: 'ACTIVE_INVENTORY',
				message:
					'Идёт инвентаризация — создание заказов невозможно. Свяжитесь с администратором.',
			})
		}

		const items: CreateOrderDto[] = Array.isArray(createOrderDto) ? createOrderDto : []

		if (!items.length) {
			throw new BadRequestException('Заказ должен содержать хотя бы одну позицию')
		}
		// Тело запроса — массив, и проверка полей по DTO к нему не применяется
		if (!items.every((i) => typeof i?.product === 'string' && /^[0-9a-f]{24}$/i.test(i.product) && Number.isInteger(i.quantity) && i.quantity >= 1)) {
			throw new BadRequestException('Позиция заказа: нужен товар и целое количество от 1')
		}

		const productIds = items.map((i) => i.product).filter(Boolean)
		const products = productIds.length
			? await this.productModel.find({ _id: { $in: productIds } }).exec()
			: []
		const productById = new Map(products.map((p) => [String(p._id), p]))

		await this.assertStockAvailable(
			items.map((i) => ({ product: String(i.product), quantity: i.quantity })),
			productById,
			null
		)

		const orderNumber = await this.counterService.getNext(companyId, 'order')

		// В строку идёт цена, по которой посчитана сумма; из запроса берутся только товар и количество
		const pricedItems = priceLines(
			items.map((item) => ({ product: item.product, quantity: item.quantity })),
			new Map(),
			(id) => productById.get(id)?.price || 0
		)
		const totalAmount = linesSum(pricedItems)

		const createdOrder = new this.orderModel({
			orderNumber,
			items: pricedItems,
			user: currentUser._id,
			totalAmount,
			company: companyId,
			clientKey,
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

	async findAll(active?: string, since?: string): Promise<Order[]> {
		return this.orderModel
			.find(ordersListFilter(active, since))
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
		const isStaff = !!currentUser.isAdmin
		const isMainAdmin = userRole?.isSystem === true
		const hasEditOrdersPerm = (userRole?.permissions || []).includes('edit_orders')
		const hasApprovePaymentPerm = (userRole?.permissions || []).includes('approve-payment')

		const canEditOthersOrders = isMainAdmin || (isStaff && hasEditOrdersPerm)
		const canApproveOthersPayment =
			isMainAdmin || (isStaff && hasApprovePaymentPerm)

		if (!isOwner && !canEditOthersOrders && !canApproveOthersPayment) {
			throw new ForbiddenException('У вас нет прав для доступа к этому заказу')
		}
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
			await assertStockNotFrozen(
				this.inventoryModel,
				'Идёт инвентаризация — изменение завершённых заказов недоступно до её завершения.'
			)
			return this.editCompletedOrderByAdmin(
				oldOrder,
				updateOrderDto,
				currentUser
			)
		}
		if (updateOrderDto.isCompleted === true) {
			await assertStockNotFrozen(
				this.inventoryModel,
				'Идёт инвентаризация — выдача заказов заморожена до её завершения.'
			)
		}

		if (
			updateOrderDto.confirmedPaid !== undefined &&
			updateOrderDto.confirmedPaid &&
			!oldOrder.confirmedPaid
		) {
			if (!canApproveOthersPayment) {
				throw new ForbiddenException('У вас нет прав для подтверждения платежа')
			}
		}

		if (
			updateOrderDto.isPaid === true &&
			!oldOrder.isPaid &&
			!isOwner &&
			!canEditOthersOrders
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

		if (itemsChanged && oldOrder.isPaid && updateOrderDto.isCompleted === true) {
			throw new BadRequestException(
				'Нельзя завершить заказ тем же запросом, что меняет его позиции: новую сумму сначала подтверждает казначей'
			)
		}

		if (itemsChanged) {
			const ownerStage5 = isOwner && !oldOrder.isPaid
			const ownerStage6 = isOwner && oldOrder.isPaid && !oldOrder.confirmedPaid
			if (!ownerStage5 && !ownerStage6 && !canEditOthersOrders) {
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

		// В запись идут только позиции, комментарий и поставленные флаги. Запросом флаги не снимаются: экран с устаревшим
		// заказом шлёт прежние false, а null прошёл бы мимо проверок выше — подтверждение оплаты снимает только правка
		// позиций (ниже). Владелец и дата заказа через правку не меняются.
		const patch: any = {}
		if (typeof updateOrderDto.comment === 'string') patch.comment = updateOrderDto.comment
		for (const flag of ['isPaid', 'confirmedPaid', 'isCompleted'] as const) {
			if (updateOrderDto[flag] === true) patch[flag] = true
		}

		let newTotalAmount = oldOrder.totalAmount || 0
		let productById = new Map<string, any>()

		if (updateOrderDto.items) {
			const productIds = updateOrderDto.items.map((i) => i.product).filter(Boolean)
			const products = productIds.length
				? await this.productModel.find({ _id: { $in: productIds } }).exec()
				: []
			productById = new Map(products.map((p) => [String(p._id), p]))

			// Only a changed basket is re-checked: the UI resends unchanged items with every pay/confirm,
			// and a shortage found later (e.g. by an inventory) is caught at issue time (STOCK_SHORTAGE).
			if (itemsChanged) {
				await this.assertStockAvailable(
					updateOrderDto.items,
					productById,
					String(oldOrder._id)
				)
			}

			// После отметки оплаты сумму меняет только правка позиций: экран пересылает прежние позиции с каждым
			// действием, и новая цена товара не должна молча переписать сумму оплаченного заказа
			const recalc = itemsChanged || !oldOrder.isPaid || !oldOrder.totalAmount
			// Цены строк записываются вместе с суммой. У оплаченного заказа они зафиксированы: товар, который в нём уже был,
			// остаётся по своей цене и при правке позиций, по текущей идут только добавленные. У неоплаченного всё по текущим.
			patch.items = priceLines(
				updateOrderDto.items.map((item) => ({ product: item.product, quantity: item.quantity })),
				oldOrder.isPaid ? keptPrices(oldOrder.items) : new Map(),
				(id) => (recalc ? productById.get(id)?.price || 0 : undefined)
			)
			if (recalc) {
				newTotalAmount = linesSum(patch.items)
				patch.totalAmount = newTotalAmount
			}
		}

		const eventsToAppend: any[] = []
		if (itemsChanged && oldOrder.isPaid) {
			const alreadyCommitted = committedAmount(oldOrder)
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

		// Правка позиций оплаченного заказа тем же запросом подтверждение не ставит: новую сумму подтверждают отдельно
		if (
			updateOrderDto.confirmedPaid === true &&
			!oldOrder.confirmedPaid &&
			!(itemsChanged && oldOrder.isPaid)
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
		// id приводится к нижнему регистру: так он записан в строках заказа и так ищется его прежняя цена
		let newItems: { product: string; quantity: number; price?: number }[] = (dto.items || []).map((i) => ({
			product: String(i.product).toLowerCase(),
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
		// Проверка — до пересчёта склада ниже: товара нет ни в заказе, ни в каталоге — посчитать его нечем
		const kept = keptPrices(oldOrder.items)
		const unknown = newItems.find((it) => !kept.has(it.product) && !productById.has(it.product))
		if (unknown) throw new BadRequestException(`Товар ${unknown.product} не найден`)

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

		// Товар, который уже был в заказе, остаётся по своей цене: правка завершённого заказа не переоценивает его
		// по сегодняшним ценам. По текущей идут только добавленные товары (и строки старых заказов без записанной цены).
		newItems = priceLines(newItems, kept, (id) => productById.get(id)?.price || 0)
		const newTotalAmount = linesSum(newItems)

		// У завершённого заказа нет шага подтверждения: каждая запись о доплате или возврате исполняется сама по себе,
		// поэтому разница — от прежней суммы заказа, и записи нескольких правок складываются верно
		const diff = newTotalAmount - (oldOrder.totalAmount || 0)
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
		const order = await this.orderModel
			.findById(id)
			// items.product is stored as a string: without `model` nothing is populated and stock is not returned
			.populate({ path: 'items.product', model: 'Product' })
			.exec()
		if (!order) throw new NotFoundException('Заказ не найден')

		const userRole = currentUser.role
			? await this.roleModel.findById(currentUser.role).exec()
			: null
		const isMainAdmin = userRole?.isSystem === true
		const isOwner = order.user.toString() === currentUser._id.toString()
		const isStaff = !!currentUser.isAdmin
		const hasEditOrdersPerm = (userRole?.permissions || []).includes('edit_orders')
		const canDeleteOthersOrders = isMainAdmin || (isStaff && hasEditOrdersPerm)

		if (!isOwner && !canDeleteOthersOrders) {
			throw new ForbiddenException('У вас нет прав для доступа к этому заказу')
		}

		const wasCompleted = !!order.isCompleted
		if (wasCompleted && !isMainAdmin) {
			throw new BadRequestException(
				'Завершённый заказ может удалить только главный администратор'
			)
		}
		if (wasCompleted) {
			await assertStockNotFrozen(
				this.inventoryModel,
				'Идёт инвентаризация — удаление завершённых заказов недоступно до её завершения.'
			)
		}

		const removedOrder = await this.orderModel.findByIdAndDelete(id).exec()
		// второй одновременный запрос удаления: товар на склад уже вернул первый
		if (!removedOrder) throw new NotFoundException('Заказ не найден')

		let returnedSummary = ''
		if (wasCompleted) {
			const restored: string[] = []
			for (const item of order.items || []) {
				const prod: any = item.product
				const qty = Number(item.quantity) || 0
				if (!prod || qty <= 0) continue
				await this.productModel
					.updateOne({ _id: prod._id }, { $inc: { quantity: qty } })
					.exec()
				restored.push(`${prod.name} — ${qty} шт`)
			}
			returnedSummary = restored.join(', ')
		}

		const refundAmount = refundOnRemove(removedOrder)

		await this.changeHistoryService.createChangeHistory({
			user: currentUser._id,
			relatedUser: removedOrder.user,
			changeType: 'order-deleted',
			description:
				`${currentUser.name}: Заказ ${removedOrder.orderNumber} удалён.` +
				(wasCompleted
					? ` Возвращено на склад: ${returnedSummary || 'нет позиций'}.`
					: '') +
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
