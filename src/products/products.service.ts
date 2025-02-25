import { BadRequestException, Injectable } from '@nestjs/common'
import { ModelType } from '@typegoose/typegoose/lib/types'
import { InjectModel } from 'nestjs-typegoose'
import { UserModel } from 'src/auth/user.model'
import { ChangeHistoryService } from 'src/change-history/change-history.service'
import { Order } from 'src/orders/order.model'
import { CreateProductDto } from './dto/create-product.dto'
import { UpdateProductDto } from './dto/update-product.dto'
import { Product } from './product.model'

@Injectable()
export class ProductsService {
	constructor(
		@InjectModel(Product) private readonly productModel: ModelType<Product>,
		@InjectModel(Order) private readonly orderModel: ModelType<Order>,
		private readonly changeHistoryService: ChangeHistoryService
	) {}

	async createProduct(
		createProductDto: CreateProductDto,
		currentUser: UserModel
	): Promise<Product> {
		const createdProduct = new this.productModel(createProductDto)
		await createdProduct.save()
		await this.changeHistoryService.createChangeHistory({
			user: currentUser._id,
			changeType: 'product-created',
			description: `${currentUser.name}: Товар ${createdProduct.name} создан.`,
			changeDate: Date.now(),
		})
		return createdProduct
	}

	async findAll(): Promise<Partial<Product & { totalQuantity?: number }>[]> {
		const products = await this.productModel.find({ deletedAt: null }).exec()
		const availableQuantities = await this.getAvailableProductQuantities()

		return products.map((product) => {
			const productId = product._id.toString()
			const availableQuantity = availableQuantities[productId] || 0
			return {
				...product.toObject(),
				quantity: product.quantity - availableQuantity,
				totalQuantity: product.quantity,
			}
		})
	}

	async findOne(
		id: string
	): Promise<Partial<Product & { totalQuantity?: number }>> {
		const product = await this.productModel
			.findById({ _id: id, deletedAt: null })
			.exec()
		const availableQuantities = await this.getAvailableProductQuantities()

		const productId = product._id.toString()
		const availableQuantity = availableQuantities[productId] || 0
		return {
			...product.toObject(),
			quantity: product.quantity - availableQuantity,
			totalQuantity: product.quantity,
		}
	}

	async update(
		id: string,
		updateProductDto: UpdateProductDto,
		currentUser: UserModel
	): Promise<Product> {
		const oldProduct = await this.productModel.findById(id).exec()
		const updatedProduct = await this.productModel
			.findByIdAndUpdate(id, updateProductDto, { new: true })
			.exec()
		const changes = this.getChanges(oldProduct, updatedProduct)
		await this.changeHistoryService.createChangeHistory({
			user: currentUser._id,
			changeType: 'product-updated',
			description: `${currentUser.name}: Товар ${updatedProduct.name} обновлен. Изменения: ${changes}`,
			changeDate: Date.now(),
		})
		return updatedProduct
	}

	async remove(id: string, currentUser: UserModel): Promise<Product> {
		const product = await this.productModel.findById(id).exec()

		if (!product) {
			throw new BadRequestException('Товар не найден!')
		}

		const removedProduct = await this.productModel
			.findByIdAndUpdate(
				id,
				{
					deletedAt: Date.now(),
					quantity: 0,
					name: `${product.name}_удален_${new Date().toISOString()}`,
				},
				{ new: true }
			)
			.exec()

		await this.changeHistoryService.createChangeHistory({
			user: currentUser._id,
			changeType: 'product-deleted',
			description: `${currentUser.name}: Товар ${product.name} удален.`,
			changeDate: Date.now(),
		})

		return removedProduct
	}

	private getChanges(oldProduct: Product, newProduct: Product): string {
		const changes = []
		if (oldProduct.name !== newProduct.name) {
			changes.push(
				`Название изменено с ${oldProduct.name} на ${newProduct.name}`
			)
		}
		if (oldProduct.price !== newProduct.price) {
			changes.push(`Цена изменена с ${oldProduct.price} на ${newProduct.price}`)
		}
		if (oldProduct.quantity !== newProduct.quantity) {
			changes.push(
				`Количество изменено с ${oldProduct.quantity} на ${newProduct.quantity}`
			)
		}
		if (oldProduct.category !== newProduct.category) {
			changes.push(
				`Категория изменена с ${oldProduct.category} на ${newProduct.category}`
			)
		}
		return changes.join(', ')
	}

	async getAvailableProductQuantities(): Promise<{
		[productId: string]: number
	}> {
		const orders = await this.orderModel
			.find({ isCompleted: false })
			.populate({
				path: 'items.product',
				model: 'Product',
			})
			.exec()
		const productQuantities: { [productId: string]: number } = {}

		orders.forEach((order) => {
			order.items.forEach((item) => {
				const productId = item.product._id.toString()
				if (productQuantities[productId]) {
					productQuantities[productId] += item.quantity
				} else {
					productQuantities[productId] = item.quantity
				}
			})
		})

		return productQuantities
	}
}
