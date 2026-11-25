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
import { LitnaOrder } from 'src/litna/litna.model'
import { Product } from 'src/products/product.model'
import { ProductsService } from 'src/products/products.service'
import { Role } from 'src/roles/role.model'
import { UpdatePurchaseDto } from './dto/update-purchase.dto'
import { Purchase } from './purchase.model'

type ReceiptState = { isCompleted?: boolean; partialCompleted?: boolean; items?: { product: any; confirmedQuantity?: number }[] }

// Does this update receive goods, i.e. move Product.quantity ($inc in update)? Frozen while an inventory is open.
/** Без галочки «Служащий» человек меняет только закупки, которые создал сам, — как в заказах; служащий и председатель — все */
export function assertOwnPurchase(purchase: { user?: any }, user: UserModel) {
	if (user.isAdmin || (user.role as any)?.isSystem === true) return
	if (String(purchase.user?._id ?? purchase.user) !== String(user._id)) throw new ForbiddenException('Чужую закупку меняет только служащий')
}

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
		private readonly counterService: CounterService,
		@InjectModel(LitnaOrder) private readonly litnaOrderModel: ModelType<LitnaOrder>
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

	/** bySite — вызов из src/litna: создание и оплату закупки с заказом на lit-na.ru ставит он, а не человек */
	async update(
		id: string,
		updatePurchaseDto: UpdatePurchaseDto,
		currentUser: UserModel,
		bySite = false
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
		if (!bySite && !isMainAdmin) assertOwnPurchase(oldPurchase, currentUser)
		const canExceedTarget = isMainAdmin || userPerms.includes('approve_target_exceed')

		const canApprovePayment =
			isMainAdmin || userPerms.includes('approve-payment')
		const paying = updatePurchaseDto.isPaid === true && !oldPurchase.isPaid
		if (oldPurchase.litna && !bySite) {
			if (!oldPurchase.isCreated && updatePurchaseDto.isCreated === true) {
				throw new BadRequestException('Заказ на lit-na.ru ещё оформляется')
			}
			// без записи заказа (местность перенесли с другого сервера) проверить оплату на сайте нечем — отмечают вручную
			if (paying && (await this.litnaOrderModel.exists({ purchase: oldPurchase._id, deletedAt: null }).exec())) {
				throw new BadRequestException('Оплата этой закупки отмечается сама после оплаты на lit-na.ru')
			}
		}
		if (paying && !canApprovePayment && !bySite) {
			throw new ForbiddenException('Нет права подтверждать оплату')
		}
		// Право подтверждать оплату ставит только оплату: создание — с правом создавать или править закупки, приёмка и завершение — править
		const canEditPurchases = isMainAdmin || userPerms.includes('edit_purchases')
		if (!bySite) {
			const creating = updatePurchaseDto.isCreated === true && !oldPurchase.isCreated
			if (creating && !canEditPurchases && !userPerms.includes('create_purchases')) {
				throw new ForbiddenException('Нет права создавать закупки')
			}
			const receiving =
				updatePurchaseDto.isCompleted === true ||
				(typeof updatePurchaseDto.partialCompleted === 'boolean' && updatePurchaseDto.partialCompleted !== !!oldPurchase.partialCompleted)
			if (receiving && !canEditPurchases) {
				throw new ForbiddenException('Приёмка и завершение закупки — с правом редактирования закупок')
			}
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
			// Заказ на сайте уже оформлен этим составом: менять можно только принятое
			const ordered = (items: any[]) =>
				(items || []).filter((i) => i.quantity > 0).map((i) => `${String(i.product).toLowerCase()}:${i.quantity}`).sort().join()
			if (oldPurchase.litna && ordered(oldPurchase.items) !== ordered(updatePurchaseDto.items)) {
				throw new BadRequestException('Заказ на lit-na.ru уже оформлен — состав закупки менять нельзя')
			}
			const itemsChanged = !this.purchaseItemsEqual(
				oldPurchase.items as any[],
				updatePurchaseDto.items as any[]
			)
			if (itemsChanged) {
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
			// У закупки с заказом на lit-na.ru цены сайта записаны при заказе — они и остаются.
			patch.items = priceLines(
				updatePurchaseDto.items.map((item) => ({ product: item.product, quantity: item.quantity, confirmedQuantity: item.confirmedQuantity ?? 0 })),
				oldPurchase.isPaid || oldPurchase.litna ? keptPrices(oldPurchase.items) : new Map(),
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
		// Оплату с сайта отмечает тот, кто первым переключил флаг: при двух проверках сразу история и push — один раз
		const updatedPurchase = await this.purchaseModel
			.findOneAndUpdate(bySite && paying ? { _id: id, isPaid: { $ne: true } } : { _id: id }, patch, { new: true })
			.exec()
		if (!updatedPurchase && bySite && paying) return this.purchaseModel.findById(id).exec()
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

	/**
	 * Снова черновик (src/litna: заказ на сайте отменён или его нет): только созданная, неоплаченная и без принятого.
	 * Цены строк — нынешние, как у любого черновика; litna снимается. null — такую не трогаем.
	 */
	async toDraft(id: string, currentUser: UserModel, description: string): Promise<Purchase | null> {
		const purchase = await this.purchaseModel.findById(id).exec()
		const received = (purchase?.items || []).some((i: any) => (i.confirmedQuantity || 0) > 0)
		if (!purchase?.isCreated || purchase.isPaid || purchase.isCompleted || purchase.partialCompleted || received) return null
		const ids = purchase.items.map((i: any) => String(i.product))
		// как в createPurchase: в черновике — все товары местности (недостающие с нулём), чтобы добавить можно было любой
		const catalog = await this.productModel.find({ $or: [{ _id: { $in: ids } }, { deletedAt: null }] }).exec()
		const prices = new Map(catalog.map((p) => [String(p._id), p.price]))
		const lines = purchase.items.map((i: any) => ({ product: String(i.product), quantity: i.quantity, confirmedQuantity: 0 }))
		const missing = catalog.filter((p) => !p.deletedAt && !ids.includes(String(p._id))).map((p) => ({ product: String(p._id), quantity: 0, confirmedQuantity: 0 }))
		const items = priceLines([...lines, ...missing], new Map(), (pid) => prices.get(pid) || 0)
		const draft = await this.purchaseModel
			.findOneAndUpdate(
				{ _id: id, isCreated: true, isPaid: { $ne: true } },
				{ isCreated: false, items, totalAmount: linesSum(items), totalConfirmedAmount: 0, $unset: { litna: 1 } },
				{ new: true }
			)
			.exec()
		if (!draft) return null
		await this.changeHistoryService.createChangeHistory({ user: currentUser._id, changeType: 'purchase-updated', description, changeDate: Date.now() })
		return draft
	}

	/** «В черновик» у созданной вручную закупки: снова выбрать «Вручную» или lit-na.ru */
	async backToDraft(id: string, currentUser: UserModel): Promise<Purchase> {
		const purchase = await this.purchaseModel.findById(id).exec()
		if (!purchase) throw new NotFoundException('Закупка не найдена')
		assertOwnPurchase(purchase, currentUser)
		if (!purchase.isCreated) throw new BadRequestException('Закупка уже черновик')
		if (purchase.isPaid) throw new BadRequestException('Закупка уже оплачена')
		if (purchase.isCompleted || purchase.partialCompleted || purchase.items.some((i: any) => (i.confirmedQuantity || 0) > 0)) {
			throw new BadRequestException('По закупке уже принимали товар')
		}
		// заказ сайта снимается только через src/litna: иначе он остался бы на сайте без закупки
		if (purchase.litna || (await this.litnaOrderModel.exists({ purchase: purchase._id, deletedAt: null }).exec())) {
			throw new BadRequestException('Сначала отвяжите закупку от lit-na.ru')
		}
		const draft = await this.toDraft(id, currentUser, `Закупка №${purchase.purchaseNumber} возвращена в черновик`)
		// между проверкой и записью закупку успели оплатить или вернуть
		if (!draft) throw new BadRequestException('Закупка уже изменилась — обновите страницу')
		return draft
	}

	/** bySite — вызов из src/litna: он сначала отменяет заказ на сайте */
	async remove(id: string, currentUser: UserModel, bySite = false): Promise<Purchase> {
		const purchaseToRemove = await this.purchaseModel.findById(id).exec()
		if (!purchaseToRemove) throw new NotFoundException('Закупка не найдена')
		if (!bySite) assertOwnPurchase(purchaseToRemove, currentUser)

		// иначе заказ на сайте остался бы неотменённым (в том числе черновик, по которому заказ сейчас оформляется)
		if (!bySite && (purchaseToRemove.litna || (await this.litnaOrderModel.exists({ purchase: purchaseToRemove._id, deletedAt: null }).exec()))) {
			throw new BadRequestException('У закупки есть заказ на lit-na.ru — удаление отменяет и его, удалите её из закупки lit-na.ru')
		}

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
