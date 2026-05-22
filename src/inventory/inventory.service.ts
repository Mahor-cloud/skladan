/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { BadRequestException, Injectable } from '@nestjs/common'
import { ModelType, Ref } from '@typegoose/typegoose/lib/types'
import { InjectModel } from 'nestjs-typegoose'
import { UserModel } from 'src/auth/user.model'
import { ChangeHistoryService } from 'src/change-history/change-history.service'
import { Order } from 'src/orders/order.model'
import { Product } from 'src/products/product.model'
import { Purchase } from 'src/purchases/purchase.model'
import { UpdateInventoryDto } from './dto/update-inventory.dto'
import { Inventory } from './inventory.model'

@Injectable()
export class InventoryService {
	constructor(
		@InjectModel(Inventory)
		private readonly inventoryModel: ModelType<Inventory>,
		@InjectModel(Product)
		private readonly productModel: ModelType<Product>,
		@InjectModel(Order)
		private readonly orderModel: ModelType<Order>,
		@InjectModel(Purchase)
		private readonly purchaseModel: ModelType<Purchase>,
		private readonly changeHistoryService: ChangeHistoryService
	) {}

	async createInventory(
		currentUser: UserModel,
		prefillFromStock = false
	): Promise<Inventory> {

		const activeInv = await this.inventoryModel
			.findOne({ isCompleted: false })
			.exec()
		if (activeInv) {
			throw new BadRequestException(
				'Уже есть незавершённая инвентаризация. Завершите её перед созданием новой.'
			)
		}

		const [openOrders, openPurchases] = await Promise.all([
			this.orderModel.countDocuments({ isCompleted: false }).exec(),
			this.purchaseModel.countDocuments({ isCompleted: false }).exec(),
		])
		if (openOrders > 0 || openPurchases > 0) {
			const parts: string[] = []
			if (openOrders > 0) parts.push(`незавершённых заказов: ${openOrders}`)
			if (openPurchases > 0) parts.push(`незавершённых закупок: ${openPurchases}`)
			throw new BadRequestException(
				`Нельзя начать инвентаризацию: есть ${parts.join(' и ')}. Сначала завершите все заказы и закупки.`
			)
		}

		const products = await this.productModel.find({ deletedAt: null }).exec()
		const companyId = (currentUser as any).company ? String((currentUser as any).company) : null

		const createdInventory = new this.inventoryModel({
			createdBy: currentUser._id,
			startDate: Date.now(),
			isCompleted: false,
			...(companyId ? { company: companyId } : {}),
			items: products.map((product) => ({
				product: product._id,

				newQuantity: prefillFromStock ? product.quantity : 0,
				quantity: product.quantity,
			})),
		})
		await createdInventory.save()
		await this.changeHistoryService.createChangeHistory({
			user: currentUser._id,
			changeType: 'inventory-created',
			description: `Инвентаризация от ${this.formatTimestamp(createdInventory.startDate)} начата.`,
			changeDate: Date.now(),
		})
		return createdInventory
	}

	async findAll(): Promise<Inventory[]> {
		return this.inventoryModel
			.find()
			.populate({
				path: 'items.product',
				model: 'Product',
			})
			.exec()
	}

	async findOne(id: string): Promise<any> {
		return await this.inventoryModel
			.findById(id)
			.populate({
				path: 'items.product',
				model: 'Product',
			})
			.populate({
				path: 'createdBy',
				select: '_id name isAdmin',
			})
			.exec()
	}

	async update(
		id: string,
		updateInventoryDto: UpdateInventoryDto,
		currentUser: UserModel
	): Promise<Inventory> {
		const oldInventory = await this.inventoryModel.findById(id).exec()
		if (!oldInventory) throw new BadRequestException('Инвентаризация не найдена')

		const wasCompleted = oldInventory.isCompleted

		await this.assertNoSubsequentInventory(oldInventory)
		if (wasCompleted) {
			if (!updateInventoryDto.editReason || !updateInventoryDto.editReason.trim()) {
				throw new BadRequestException('При редактировании завершённой инвентаризации укажите причину (editReason)')
			}
		}

		if (!wasCompleted && updateInventoryDto.isCompleted === true) {
			const [openOrders, openPurchases] = await Promise.all([
				this.orderModel.countDocuments({ isCompleted: false }).exec(),
				this.purchaseModel.countDocuments({ isCompleted: false }).exec(),
			])
			if (openOrders > 0 || openPurchases > 0) {
				const parts: string[] = []
				if (openOrders > 0) parts.push(`незавершённых заказов: ${openOrders}`)
				if (openPurchases > 0) parts.push(`незавершённых закупок: ${openPurchases}`)
				throw new BadRequestException(
					`Нельзя завершить инвентаризацию: есть ${parts.join(' и ')}. Сначала завершите все заказы и закупки.`
				)
			}
		}

		const oldItemsMap = new Map<string, { newQuantity: number; quantity: number }>(
			oldInventory.items.map((it: any) => [String(it.product), { newQuantity: it.newQuantity, quantity: it.quantity }])
		)

		if (updateInventoryDto.items?.length) {
			const productIds = updateInventoryDto.items.map((i: any) => i.product).filter(Boolean)
			if (productIds.length) {
				const validProducts = await this.productModel
					.find({ _id: { $in: productIds } })
					.exec()
				if (validProducts.length !== productIds.length) {
					throw new BadRequestException(
						'Один или несколько товаров в items не найдены в вашей компании'
					)
				}
			}
		}

		const sanitizedDto: any = { ...updateInventoryDto }
		delete sanitizedDto.createdBy
		delete sanitizedDto.startDate

		const updatedInventory = await this.inventoryModel
			.findByIdAndUpdate(id, sanitizedDto, { new: true })
			.exec()

		if (!wasCompleted && updatedInventory.isCompleted) {
			await this.applyCompletion(updatedInventory.items as any)
		} else if (wasCompleted && updateInventoryDto.items) {
			await this.applyDeltas(updatedInventory.items as any, oldItemsMap)
		}

		const changes = this.getChanges(oldInventory, updatedInventory)
		const reasonSuffix = updateInventoryDto.editReason
			? ` Причина: ${updateInventoryDto.editReason}`
			: ''
		await this.changeHistoryService.createChangeHistory({
			user: currentUser._id,
			changeType: wasCompleted ? 'inventory-edited-after-completion' : 'inventory-updated',
			description: `Инвентаризация от ${this.formatTimestamp(updatedInventory.startDate)} ${wasCompleted ? 'переписана' : 'обновлена'}. ${changes}.${reasonSuffix}`,
			changeDate: Date.now(),
		})

		return updatedInventory
	}

	async delete(id: string, currentUser: UserModel, editReason?: string) {
		const inventory = await this.inventoryModel.findById(id).exec()
		if (!inventory) throw new BadRequestException('Инвентаризация не найдена')

		if (inventory.isCompleted) {
			if (!editReason || !editReason.trim()) {
				throw new BadRequestException('При удалении завершённой инвентаризации укажите причину (editReason)')
			}
			await this.assertNoSubsequentInventory(inventory)
			await this.reverseCompletion(inventory.items as any)
		}

		const deletedInventory = await this.inventoryModel.findByIdAndDelete(id).exec()

		const reasonSuffix = editReason ? ` Причина: ${editReason}` : ''
		await this.changeHistoryService.createChangeHistory({
			user: currentUser._id,
			changeType: inventory.isCompleted ? 'inventory-deleted-after-completion' : 'inventory-deleted',
			description: `Инвентаризация от ${this.formatTimestamp(deletedInventory.startDate)} удалена${inventory.isCompleted ? ' (откат на склад выполнен)' : ''}.${reasonSuffix}`,
			changeDate: Date.now(),
		})
		return deletedInventory
	}

	private async assertNoSubsequentInventory(current: Inventory) {
		const subsequent = await this.inventoryModel
			.findOne({ startDate: { $gt: current.startDate }, _id: { $ne: current._id } })
			.exec()
		if (subsequent) {
			throw new BadRequestException(
				'Нельзя изменить/удалить инвентаризацию: есть более поздняя инвентаризация.'
			)
		}
	}

	private async applyCompletion(
		items: { product: Ref<Product>; newQuantity: number; quantity: number }[]
	): Promise<void> {
		for (const item of items) {
			await this.productModel
				.updateOne(
					{ _id: item.product },
					{ $set: { quantity: item.newQuantity } }
				)
				.exec()
		}
	}

	private async applyDeltas(
		newItems: { product: Ref<Product>; newQuantity: number; quantity: number }[],
		oldMap: Map<string, { newQuantity: number; quantity: number }>
	): Promise<void> {
		for (const item of newItems) {
			const pid = String(item.product?._id || item.product)
			const oldNew = oldMap.get(pid)?.newQuantity ?? 0
			const delta = (item.newQuantity || 0) - oldNew
			if (delta === 0) continue
			await this.productModel
				.updateOne({ _id: pid }, { $inc: { quantity: delta } })
				.exec()
		}
	}

	private async reverseCompletion(
		items: { product: Ref<Product>; newQuantity: number; quantity: number }[]
	): Promise<void> {
		for (const item of items) {
			const pid = String(item.product?._id || item.product)
			const effect = (item.newQuantity || 0) - (item.quantity || 0)
			if (effect === 0) continue
			await this.productModel
				.updateOne({ _id: pid }, { $inc: { quantity: -effect } })
				.exec()
		}
	}

	private formatTimestamp(timestamp: number) {
		const date = new Date(timestamp)
		const year = date.getFullYear()
		const month = String(date.getMonth() + 1).padStart(2, '0')
		const day = String(date.getDate()).padStart(2, '0')
		return `${day}.${month}.${year}`
	}

	private getChanges(oldInventory: Inventory, newInventory: Inventory): string {
		const changes = []
		if (!oldInventory.isCompleted && newInventory.isCompleted) {
			changes.push('Инвентаризация завершена')
		}
		if (
			JSON.stringify(oldInventory.items) !== JSON.stringify(newInventory.items)
		) {
			changes.push(`Количество товаров изменено`)
		}
		if (oldInventory.comment !== newInventory.comment) {
			changes.push(
				`Комментарий изменен с ${oldInventory.comment} на ${newInventory.comment}`
			)
		}
		return changes.join(', ')
	}
}
