import { BadRequestException, Injectable } from '@nestjs/common'
import { ModelType, Ref } from '@typegoose/typegoose/lib/types'
import { InjectModel } from 'nestjs-typegoose'
import { UserModel } from 'src/auth/user.model'
import { ChangeHistoryService } from 'src/change-history/change-history.service'
import { Product } from 'src/products/product.model'
import { ProductsService } from 'src/products/products.service'
import { UpdatePurchaseDto } from './dto/update-purchase.dto'
import { Purchase } from './purchase.model'

@Injectable()
export class PurchasesService {
	constructor(
		@InjectModel(Purchase) private readonly purchaseModel: ModelType<Purchase>,
		private readonly changeHistoryService: ChangeHistoryService,
		@InjectModel(Product) private readonly productModel: ModelType<Product>,
		private readonly productsService: ProductsService
	) {}

	async createPurchase(currentUser: UserModel): Promise<Purchase> {
		const maxPurchaseNumber = await this.purchaseModel
			.findOne()
			.sort({
				purchaseNumber: -1,
			})
			.select('purchaseNumber')
			.exec()

		const purchaseNumber = maxPurchaseNumber
			? maxPurchaseNumber.purchaseNumber + 1
			: 1

		const products = await this.productsService.findAll()

		const createdPurchase = new this.purchaseModel({
			user: currentUser._id,
			purchaseNumber: purchaseNumber,
			items: products.map((product) => ({
				product: product._id,
				quantity: 0,
				confirmedQuantity: 0,
			})),
		})
		await createdPurchase.save()
		await this.changeHistoryService.createChangeHistory({
			user: currentUser._id,
			changeType: 'purchase-created',
			description: `Закупка ${createdPurchase.purchaseNumber} создана.`,
			changeDate: Date.now(),
		})
		return createdPurchase
	}

	async findAll(): Promise<Purchase[]> {
		return this.purchaseModel
			.find()
			.populate({
				path: 'user',
				select: '_id name isAdmin',
			})
			.exec()
	}

	async findOne(id: string): Promise<Purchase> {
		return this.purchaseModel
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
	}

	async update(
		id: string,
		updatePurchaseDto: UpdatePurchaseDto,
		currentUser: UserModel
	): Promise<Purchase> {
		const oldPurchase = await this.purchaseModel.findById(id).exec()

		if (oldPurchase.isCompleted) {
			throw new BadRequestException('Закупка уже завершен')
		}

		const updatedPurchase = await this.purchaseModel
			.findByIdAndUpdate(id, updatePurchaseDto, { new: true })
			.exec()

		if (updatedPurchase.partialCompleted || updatedPurchase.isCompleted) {
			await Promise.all(
				updatedPurchase.items.map((item, index) =>
					this.updateProducts({
						product: item.product,
						quantity:
							item.confirmedQuantity -
							oldPurchase.items[index].confirmedQuantity,
					})
				)
			)
		}

		const changes = this.getChanges(oldPurchase, updatedPurchase)
		await this.changeHistoryService.createChangeHistory({
			user: currentUser._id,
			changeType: 'purchase-updated',
			description: `Закупка ${updatedPurchase.purchaseNumber} обновлена. Изменения: ${changes}`,
			changeDate: Date.now(),
		})
		return updatedPurchase
	}

	private async updateProducts(item: {
		product: Ref<Product>
		quantity: number
	}): Promise<void> {
		const product = await this.productModel.findById(item.product).exec()
		await product.updateOne(
			{ quantity: product.quantity + item.quantity },
			{ new: true }
		)
	}

	async remove(id: string, currentUser: UserModel): Promise<Purchase> {
		const purchaseToRemove = await this.purchaseModel.findById(id).exec()

		if (purchaseToRemove.isCompleted) {
			throw new BadRequestException('Закупка уже завершена, нельзя удалить')
		}

		if (purchaseToRemove.isPaid) {
			throw new BadRequestException('Закупка уже оплачена, нельзя удалить')
		}

		const removedPurchase = await this.purchaseModel
			.findByIdAndDelete(id)
			.exec()

		await this.changeHistoryService.createChangeHistory({
			user: currentUser._id,
			changeType: 'purchase-deleted',
			description: `Закупка ${removedPurchase.purchaseNumber} удалена.`,
			changeDate: Date.now(),
		})
		return removedPurchase
	}

	private getChanges(oldPurchase: Purchase, newPurchase: Purchase): string {
		const changes = []
		if (!oldPurchase.isPaid && newPurchase.isPaid) {
			changes.push('Закупка оплачена')
		}
		if (!oldPurchase.isCompleted && newPurchase.isCompleted) {
			changes.push('Закупка завершена')
		}
		if (newPurchase.partialCompleted && !newPurchase.isCompleted) {
			changes.push('Закупка частично получена')
		}

		if (oldPurchase.comment !== newPurchase.comment) {
			changes.push(
				`Комментарий изменен с ${oldPurchase.comment} на ${newPurchase.comment}`
			)
		}
		return changes.join(', ')
	}
}
