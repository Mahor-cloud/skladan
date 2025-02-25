import { BadRequestException, Injectable } from '@nestjs/common'
import { ModelType, Ref } from '@typegoose/typegoose/lib/types'
import { InjectModel } from 'nestjs-typegoose'
import { UserModel } from 'src/auth/user.model'
import { ChangeHistoryService } from 'src/change-history/change-history.service'
import { Product } from 'src/products/product.model' // Предполагается, что у вас есть модель Product
import { UpdateInventoryDto } from './dto/update-inventory.dto'
import { Inventory } from './inventory.model'

@Injectable()
export class InventoryService {
	constructor(
		@InjectModel(Inventory)
		private readonly inventoryModel: ModelType<Inventory>,
		@InjectModel(Product)
		private readonly productModel: ModelType<Product>,
		private readonly changeHistoryService: ChangeHistoryService
	) {}

	async createInventory(currentUser: UserModel): Promise<Inventory> {
		const products = await this.productModel.find({ deletedAt: null }).exec()

		const createdInventory = new this.inventoryModel({
			createdBy: currentUser._id,
			startDate: Date.now(),
			isCompleted: false,
			items: products.map((product) => ({
				product: product._id,
				newQuantity: 0,
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
		const oldInventory = await this.inventoryModel
			.findById(id)
			.populate({
				path: 'items.product',
				model: 'Product',
			})
			.exec()
		if (oldInventory.isCompleted) {
			throw new BadRequestException('Инвентаризация уже завершена')
		}

		const updatedInventory = await this.inventoryModel
			.findByIdAndUpdate(id, updateInventoryDto, { new: true })
			.exec()

		const changes = this.getChanges(oldInventory, updatedInventory)
		await this.changeHistoryService.createChangeHistory({
			user: currentUser._id,
			changeType: 'inventory-updated',
			description: `Инвентаризация от ${this.formatTimestamp(updatedInventory.startDate)} обновлена. Изменения: ${changes}`,
			changeDate: Date.now(),
		})
		if (updatedInventory.isCompleted) {
			await this.updateProducts(updatedInventory.items)
		}

		return updatedInventory
	}

	async delete(id: string, currentUser: UserModel) {
		const inventory = await this.inventoryModel.findById(id)
		if (inventory.isCompleted) {
			throw new BadRequestException('Инвентаризация уже завершена')
		}
		const deletedInventory = await this.inventoryModel
			.findByIdAndDelete(id)
			.exec()
		await this.changeHistoryService.createChangeHistory({
			user: currentUser._id,
			changeType: 'inventory-deleted',
			description: `Инвентаризация от ${this.formatTimestamp(deletedInventory.startDate)} удалена`,
			changeDate: Date.now(),
		})
		return deletedInventory
	}

	private async updateProducts(
		items: { product: Ref<Product>; newQuantity: number; quantity: number }[]
	): Promise<void> {
		for (const item of items) {
			await this.productModel
				.findByIdAndUpdate(
					item.product,
					{ quantity: item.newQuantity },
					{ new: true }
				)
				.exec()
		}
	}
	private formatTimestamp(timestamp: number) {
		const date = new Date(timestamp)
		const year = date.getFullYear()
		const month = String(date.getMonth() + 1).padStart(2, '0')
		const day = String(date.getDate()).padStart(2, '0')
		return `${year}-${month}-${day}`
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
