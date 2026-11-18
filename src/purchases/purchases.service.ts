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
import { keptPrices, linesSum, priceLines } from 'src/common/line-prices'
import { Message } from 'src/database/messages.model'
import { assertStockNotFrozen, openDocsAllowed } from 'src/inventory/inventory-lock'
import { Inventory } from 'src/inventory/inventory.model'
import { Product } from 'src/products/product.model'
import { ProductsService } from 'src/products/products.service'
import { Role } from 'src/roles/role.model'
import { UpdatePurchaseDto } from './dto/update-purchase.dto'
import { Purchase } from './purchase.model'

type ReceiptState = { isCompleted?: boolean; partialCompleted?: boolean; items?: { product: any; confirmedQuantity?: number }[] }

// Does this update receive goods, i.e. move Product.quantity ($inc in update)? Frozen while an inventory is open.
export function purchaseReceives(old: ReceiptState, dto: ReceiptState): boolean {
	const finalPartial = dto.partialCompleted !== undefined ? !!dto.partialCompleted : !!old.partialCompleted
	const finalCompleted = dto.isCompleted !== undefined ? !!dto.isCompleted : !!old.isCompleted
	const before = new Map((old.items || []).map((i) => [String(i.product), Number(i.confirmedQuantity) || 0]))
	const confirmedChanged = (dto.items || []).some(
		(i) => (Number(i.confirmedQuantity) || 0) !== (before.get(String(i.product)) || 0)
	)
	return finalCompleted || (finalPartial && (!old.partialCompleted || confirmedChanged))
}

@Injectable()
export class PurchasesService {
	constructor(
		@InjectModel(Purchase) private readonly purchaseModel: ModelType<Purchase>,
		private readonly changeHistoryService: ChangeHistoryService,
		@InjectModel(Product) private readonly productModel: ModelType<Product>,
		@InjectModel(Role) private readonly roleModel: ModelType<Role>,
		@InjectModel(Inventory) private readonly inventoryModel: ModelType<Inventory>,
		@InjectModel(Message) private readonly messageModel: ModelType<Message>,
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

		const activeInventory = await this.inventoryModel
			.findOne({ isCompleted: false })
			.exec()
		if (activeInventory && !(await openDocsAllowed(this.messageModel))) {
			throw new BadRequestException({
				code: 'ACTIVE_INVENTORY',
				message:
					'Идёт инвентаризация — создание закупок невозможно. Сначала завершите инвентаризацию.',
			})
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
		// Создание и оплата запросом не снимаются: экран с устаревшей закупкой прислал бы прежние false,
		// а оплата — ещё и признак того, что цены строк зафиксированы
		if (
			(oldPurchase.isPaid && updatePurchaseDto.isPaid === false) ||
			(oldPurchase.isCreated && updatePurchaseDto.isCreated === false) ||
			// «частично принята» снимается только завершением: иначе принятое можно было бы зачислить на склад второй раз
			(oldPurchase.partialCompleted && updatePurchaseDto.partialCompleted === false && updatePurchaseDto.isCompleted !== true)
		) {
			throw new BadRequestException('Закупка уже изменилась — обновите страницу')
		}

		const userRole = currentUser.role
			? await this.roleModel.findById(currentUser.role).exec()
			: null
		const userPerms = userRole?.permissions || []
		const isMainAdmin = userRole?.isSystem === true
		const canExceedTarget = isMainAdmin || userPerms.includes('approve_target_exceed')

		const canApprovePayment =
			isMainAdmin || userPerms.includes('approve-payment')
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
			if (purchaseReceives(oldPurchase as any, updatePurchaseDto)) {
				await assertStockNotFrozen(
					this.inventoryModel,
					'Идёт инвентаризация — получение по закупкам заморожено до её завершения.'
				)
			}
		}

		if (Array.isArray(updatePurchaseDto.items)) {
			// Строка с уже принятым товаром из закупки не убирается: вернув её потом, принятое зачислили бы на склад второй раз
			// id товара — строчными, как в базе: иначе повтор и убранная строка проходили бы сменой регистра букв
			for (const item of updatePurchaseDto.items) item.product = String(item.product).toLowerCase()
			const sent = new Set(updatePurchaseDto.items.map((i) => String(i.product)))
			// Товар в закупке — одной строкой: при повторе принятое считалось бы от последней строки и зачислялось дважды
			if (sent.size !== updatePurchaseDto.items.length) throw new BadRequestException('Товар в закупке указан дважды')
			if ((oldPurchase.items || []).some((i: any) => (i.confirmedQuantity || 0) > 0 && !sent.has(String(i.product)))) {
				throw new BadRequestException('Закупка уже изменилась — обновите страницу')
			}
			const itemsChanged = !this.purchaseItemsEqual(
				oldPurchase.items as any[],
				updatePurchaseDto.items as any[]
			)
			if (itemsChanged) {
				const canEditPurchases =
					isMainAdmin || userPerms.includes('edit_purchases')
				if (!canEditPurchases) {
					throw new ForbiddenException(
						'Изменение позиций закупки доступно только с правом редактирования закупок'
					)
				}
			}
		}

		// В запись идут только комментарий, позиции (ниже) и флаги. «Создана», «оплачена», «завершена» запросом только
		// ставятся — пустое значение или false их не снимает; «частично принята» — как прислано (см. проверку выше).
		const patch: any = {}
		if (typeof updatePurchaseDto.comment === 'string') patch.comment = updatePurchaseDto.comment
		for (const flag of ['isCreated', 'isPaid', 'isCompleted'] as const) {
			if (updatePurchaseDto[flag] === true) patch[flag] = true
		}
		if (typeof updatePurchaseDto.partialCompleted === 'boolean') patch.partialCompleted = updatePurchaseDto.partialCompleted
		if (updatePurchaseDto.items) {
			const productIds = updatePurchaseDto.items
				.map((i) => i.product)
				.filter(Boolean)
			const products = productIds.length
				? await this.productModel.find({ _id: { $in: productIds } }).exec()
				: []
			const productById = new Map(products.map((p) => [String(p._id), p]))
			// Цены строк записываются вместе с суммами. После оплаты они зафиксированы: товар, который уже был в закупке,
			// остаётся по своей цене (приёмка её не меняет), по текущей идут только добавленные. До оплаты всё по текущим.
			patch.items = priceLines(
				updatePurchaseDto.items.map((item) => ({ product: item.product, quantity: item.quantity, confirmedQuantity: item.confirmedQuantity ?? 0 })),
				oldPurchase.isPaid ? keptPrices(oldPurchase.items) : new Map(),
				(id) => productById.get(id)?.price || 0
			)
			patch.totalAmount = linesSum(patch.items)
			patch.totalConfirmedAmount = linesSum(patch.items, 'confirmedQuantity')

			const isDraftSave =
				!oldPurchase.isCreated && updatePurchaseDto.isCreated !== true
			if (!canExceedTarget && !isDraftSave) {
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
			description: `Закупка ${updatedPurchase.purchaseNumber} обновлена.${changes ? ` Изменения: ${changes}` : ''}`,
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
