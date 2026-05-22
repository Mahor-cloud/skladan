/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
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
		const companyId = (currentUser as any).company ? String((currentUser as any).company) : null
		if ((currentUser.role as any)?.isSystem !== true) {
			delete (createProductDto as any).targetQty
		}
		const createdProduct = new this.productModel({
			...createProductDto,
			...(companyId ? { company: companyId } : {}),
		})
		await createdProduct.save()
		await this.changeHistoryService.createChangeHistory({
			user: currentUser._id,
			changeType: 'product-created',
			description: `${currentUser.name}: Товар ${createdProduct.name} создан.`,
			changeDate: Date.now(),
		})
		return createdProduct
	}

	async findAll(
		includeDeleted: boolean = false
	): Promise<Partial<Product & { totalQuantity?: number }>[]> {
		const filter = includeDeleted ? {} : { deletedAt: null }
		const products = await this.productModel.find(filter).exec()
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
			.findOne({ _id: id, deletedAt: null })
			.exec()
		if (!product) {
			throw new NotFoundException('Товар не найден')
		}
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
		if ((currentUser.role as any)?.isSystem !== true) {
			delete (updateProductDto as any).targetQty
		}
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

		const now = new Date()
		const dd = String(now.getDate()).padStart(2, '0')
		const mm = String(now.getMonth() + 1).padStart(2, '0')
		const yyyy = now.getFullYear()
		const removedLabel = `${product.name} (удалён ${dd}.${mm}.${yyyy})`

		const removedProduct = await this.productModel
			.findByIdAndUpdate(
				id,
				{
					deletedAt: Date.now(),
					quantity: 0,
					name: removedLabel,

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
		const rows = await this.orderModel
			.aggregate([
				{ $match: { isCompleted: false } },
				{ $unwind: '$items' },
				{
					$group: {
						_id: '$items.product',
						reserved: { $sum: { $ifNull: ['$items.quantity', 0] } },
					},
				},
			])
			.exec()

		const productQuantities: { [productId: string]: number } = {}
		for (const r of rows as any[]) {
			if (!r._id) continue
			productQuantities[String(r._id)] = Number(r.reserved || 0)
		}
		return productQuantities
	}
}
