/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import {
	BadRequestException,
	ForbiddenException,
	Injectable,
	NotFoundException,
} from '@nestjs/common'
import { ModelType, Ref } from '@typegoose/typegoose/lib/types'
import { InjectModel } from 'nestjs-typegoose'
import { UserModel } from 'src/auth/user.model'
import { ChangeHistoryService } from 'src/change-history/change-history.service'
import { CounterService } from 'src/common/counters/counter.service'
import { Product } from 'src/products/product.model'
import { ProductsService } from 'src/products/products.service'
import { Role } from 'src/roles/role.model'
import { UpdatePurchaseDto } from './dto/update-purchase.dto'
import { Purchase } from './purchase.model'

@Injectable()
export class PurchasesService {
	constructor(
		@InjectModel(Purchase) private readonly purchaseModel: ModelType<Purchase>,
		private readonly changeHistoryService: ChangeHistoryService,
		@InjectModel(Product) private readonly productModel: ModelType<Product>,
		@InjectModel(Role) private readonly roleModel: ModelType<Role>,
		private readonly productsService: ProductsService,
		private readonly counterService: CounterService
	) {}

	private purchaseItemsEqual(a: any[] = [], b: any[] = []): boolean {
		const norm = (arr: any[]) =>
			(arr || [])
				.map((i) => ({
					p: String(i.product?._id || i.product),
					q: Number(i.quantity) || 0,
					c: Number(i.confirmedQuantity) || 0,
				}))
				.sort((x, y) => x.p.localeCompare(y.p))
		const an = norm(a)
		const bn = norm(b)
		if (an.length !== bn.length) return false
		for (let i = 0; i < an.length; i++) {
			if (an[i].p !== bn[i].p || an[i].q !== bn[i].q || an[i].c !== bn[i].c)
				return false
		}
		return true
	}

	async createPurchase(currentUser: UserModel): Promise<Purchase> {
		const companyId = String((currentUser as any).company || currentUser.company)
		if (!companyId || companyId === 'null') {
			throw new BadRequestException('Закупку можно создать только в контексте компании')
		}
		const purchaseNumber = await this.counterService.getNext(companyId, 'purchase')

		const products = await this.productsService.findAll()

		const createdPurchase = new this.purchaseModel({
			user: currentUser._id,
			purchaseNumber: purchaseNumber,
			company: companyId,
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
		const purchase = await this.purchaseModel
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
		if (!purchase) throw new NotFoundException('Закупка не найдена')
		return purchase
	}

	async update(
		id: string,
		updatePurchaseDto: UpdatePurchaseDto,
		currentUser: UserModel
	): Promise<Purchase> {
		const oldPurchase = await this.purchaseModel.findById(id).exec()
		if (!oldPurchase) throw new NotFoundException('Закупка не найдена')

		if (oldPurchase.isCompleted) {
			throw new BadRequestException('Закупка уже завершена')
		}

		const userRole = currentUser.role
			? await this.roleModel.findById(currentUser.role).exec()
			: null
		const userPerms = userRole?.permissions || []
		const isAdmin = !!currentUser.isAdmin
		const canExceedTarget = isAdmin || userPerms.includes('approve_target_exceed')

		const canApprovePayment =
			isAdmin || userPerms.includes('approve-payment')
		if (
			updatePurchaseDto.isPaid === true &&
			!oldPurchase.isPaid &&
			!canApprovePayment
		) {
			throw new ForbiddenException(
				'Оплату закупки подтверждает казначей — у вас нет такого права'
			)
		}
		{
			const finalPartial =
				updatePurchaseDto.partialCompleted !== undefined
					? !!updatePurchaseDto.partialCompleted
					: !!oldPurchase.partialCompleted
			const finalCompleted =
				updatePurchaseDto.isCompleted !== undefined
					? !!updatePurchaseDto.isCompleted
					: !!oldPurchase.isCompleted
			if ((finalPartial || finalCompleted) && !oldPurchase.isPaid) {
				throw new BadRequestException(
					'Закупка не оплачена: частичное/полное получение и завершение недоступны'
				)
			}
		}

		if (Array.isArray(updatePurchaseDto.items)) {
			const itemsChanged = !this.purchaseItemsEqual(
				oldPurchase.items as any[],
				updatePurchaseDto.items as any[]
			)
			if (itemsChanged) {
				const canEditPurchases =
					isAdmin || userPerms.includes('edit_purchases')
				if (!canEditPurchases) {
					throw new ForbiddenException(
						'Изменение позиций закупки доступно только с правом редактирования закупок'
					)
				}
			}
		}

		const patch: any = { ...updatePurchaseDto }
		if (updatePurchaseDto.items) {
			const productIds = updatePurchaseDto.items
				.map((i) => i.product)
				.filter(Boolean)
			const products = productIds.length
				? await this.productModel.find({ _id: { $in: productIds } }).exec()
				: []
			const productById = new Map(products.map((p) => [String(p._id), p]))
			let total = 0
			let totalConfirmed = 0
			for (const item of updatePurchaseDto.items) {
				const product = productById.get(String(item.product))
				if (product) {
					total += (item.quantity || 0) * (product.price || 0)
					totalConfirmed += (item.confirmedQuantity || 0) * (product.price || 0)
				}
			}
			patch.totalAmount = total
			patch.totalConfirmedAmount = totalConfirmed

			if (!canExceedTarget) {
				const oldQtyByProduct = new Map(
					(oldPurchase.items || []).map((i: any) => [
						String(i.product),
						Number(i.quantity) || 0,
					])
				)
				for (const item of updatePurchaseDto.items) {
					const product = productById.get(String(item.product))
					const targetQty = Number((product as any)?.targetQty) || 0
					if (!product || targetQty <= 0) continue
					const oldPlanned = oldQtyByProduct.get(String(item.product)) || 0
					const cap = Math.max(targetQty, oldPlanned)
					const plannedQty = Number(item.quantity) || 0
					if (plannedQty > cap) {
						throw new BadRequestException('TARGET_EXCEEDED')
					}
				}
			}
		}
		const updatedPurchase = await this.purchaseModel
			.findByIdAndUpdate(id, patch, { new: true })
			.exec()
		if (!updatedPurchase) throw new NotFoundException('Закупка не найдена')

		if (updatedPurchase.partialCompleted || updatedPurchase.isCompleted) {

			const oldByProduct = new Map(
				oldPurchase.items.map((item) => [String(item.product), item])
			)
			await Promise.all(
				updatedPurchase.items.map((item) => {
					const oldItem = oldByProduct.get(String(item.product))
					const delta =
						(item.confirmedQuantity || 0) -
						(oldItem?.confirmedQuantity || 0)
					if (delta === 0) return Promise.resolve()
					return this.updateProducts({ product: item.product, quantity: delta })
				})
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
		await this.productModel
			.updateOne(
				{ _id: item.product },
				{ $inc: { quantity: item.quantity || 0 } }
			)
			.exec()
	}

	async remove(id: string, currentUser: UserModel): Promise<Purchase> {
		const purchaseToRemove = await this.purchaseModel.findById(id).exec()
		if (!purchaseToRemove) throw new NotFoundException('Закупка не найдена')

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
