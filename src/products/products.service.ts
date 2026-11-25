/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { BadRequestException, Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common'
import { ModelType } from '@typegoose/typegoose/lib/types'
import { randomBytes } from 'crypto'
import { InjectModel } from 'nestjs-typegoose'
import { UserModel } from 'src/auth/user.model'
import { ChangeHistoryService } from 'src/change-history/change-history.service'
import { RealtimeService } from 'src/change-history/realtime.service'
import { getTenantContext } from 'src/common/tenant-context/tenant-context.storage'
import { KindCover, Message } from 'src/database/messages.model'
import { Inventory } from 'src/inventory/inventory.model'
import { Order } from 'src/orders/order.model'
import { CreateProductDto } from './dto/create-product.dto'
import { KindCoverDto, RenameKindDto } from './dto/kinds.dto'
import { UpdateProductDto } from './dto/update-product.dto'
import { ProductPhoto } from './product-photo.model'
import { Product } from './product.model'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']
export const PHOTO_TOKEN = /^[0-9a-f]{32}$/
export const PHOTO_QUOTA = 30 * 1024 * 1024
// Загрузка фото (FileInterceptor): +1 у fileSize и parts — busboy срабатывает, когда счёт достиг лимита, а 512 КБ ровно и одна часть допустимы
export const PHOTO_UPLOAD = { limits: { fileSize: 512 * 1024 + 1, files: 1, fields: 0, parts: 2 } }
const MAX_KIND_COVERS = 500

// Тип определяется по первым байтам: заявленному клиентом mimetype верить нельзя
export function imageType(buf?: Buffer): string | null {
	if (!buf || buf.length < 12) return null
	if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
	if (buf.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png'
	if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
	return null
}

export function withKindCover(list: KindCover[], category: string, cover: string | null): KindCover[] {
	const rest = list.filter((k) => k.category !== category)
	return cover ? [...rest, { category, cover }] : rest
}

// При слиянии видов остаётся обложка того вида, в который переименовали
export function renamedKindCovers(list: KindCover[], from: string, to: string): KindCover[] {
	const source = list.find((k) => k.category === from)
	if (!source) return list
	const rest = list.filter((k) => k.category !== from)
	return rest.some((k) => k.category === to) ? rest : [...rest, { category: to, cover: source.cover }]
}

const coversMap = (list: KindCover[] = []) => Object.fromEntries(list.map((k) => [k.category, k.cover]))

@Injectable()
export class ProductsService {
	constructor(
		@InjectModel(Product) private readonly productModel: ModelType<Product>,
		@InjectModel(Order) private readonly orderModel: ModelType<Order>,
		@InjectModel(Inventory) private readonly inventoryModel: ModelType<Inventory>,
		private readonly changeHistoryService: ChangeHistoryService,
		@InjectModel(ProductPhoto) private readonly photoModel: ModelType<ProductPhoto>,
		@InjectModel(Message) private readonly messageModel: ModelType<Message>,
		private readonly realtime: RealtimeService
	) {}

	private emit(type: string) {
		this.realtime.emit(getTenantContext()?.company, type)
	}

	private async assertNoActiveInventory(): Promise<void> {
		const active = await this.inventoryModel
			.findOne({ isCompleted: false })
			.exec()
		if (active) {
			throw new BadRequestException({
				code: 'ACTIVE_INVENTORY',
				message:
					'Идёт инвентаризация — изменение товаров запрещено. Сначала завершите инвентаризацию.',
			})
		}
	}

	async createProduct(
		createProductDto: CreateProductDto,
		currentUser: UserModel
	): Promise<Product> {
		await this.assertNoActiveInventory()
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
		// Цвет обложки и пара на lit-na.ru — косметика: без запрета на время инвентаризации, без истории и push,
		// открытые экраны перечитают по realtime
		const keys = Object.keys(updateProductDto)
		const cosmeticOnly = keys.length > 0 && keys.every((k) => k === 'coverColor' || k === 'litnaId')
		if (!cosmeticOnly) await this.assertNoActiveInventory()
		if ((currentUser.role as any)?.isSystem !== true) {
			delete (updateProductDto as any).targetQty
		}
		const oldProduct = await this.productModel.findById(id).exec()
		const updatedProduct = await this.productModel
			.findByIdAndUpdate(id, updateProductDto, { new: true })
			.exec()
		if (cosmeticOnly) {
			// пара на lit-na.ru — в историю (как и массовая привязка), но без push
			if ('litnaId' in updateProductDto && (oldProduct as any)?.litnaId !== updateProductDto.litnaId) {
				await this.changeHistoryService.createChangeHistory(
					{ user: currentUser._id, changeType: 'litna-links-updated', description: 'Привязка к lit-na.ru изменена: 1 товар', changeDate: Date.now() },
					{ push: false }
				)
			}
			this.emit('product-updated')
			return updatedProduct
		}
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
		await this.assertNoActiveInventory()
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

	async setPhoto(id: string, data?: Buffer): Promise<Product> {
		const contentType = imageType(data)
		if (!contentType) throw new BadRequestException('Нужна картинка WebP, PNG или JPEG')
		const product = await this.productModel.findOne({ _id: id, deletedAt: null }).select('company photo').exec()
		if (!product) throw new NotFoundException('Товар не найден')
		// сначала запись, потом подсчёт вместе с ней: одновременные загрузки видят друг друга и квоту не превысят
		const token = randomBytes(16).toString('hex')
		await this.photoModel.create({ company: product.company, token, contentType, data })
		const [used] = await this.photoModel
			.aggregate([
				// нынешнее фото товара не считается: при замене оно удаляется
				{ $match: { company: product.company, token: { $ne: product.photo ?? null } } },
				{ $group: { _id: null, bytes: { $sum: { $binarySize: '$data' } } } },
			])
			.exec()
		if ((used?.bytes || 0) > PHOTO_QUOTA) {
			await this.photoModel.deleteOne({ token }).exec()
			throw new PayloadTooLargeException('Превышен объём фото местности')
		}
		return this.swapPhoto(id, token)
	}

	removePhoto(id: string): Promise<Product> {
		return this.swapPhoto(id, null)
	}

	// Прежний документ из findByIdAndUpdate: удаляется ровно та картинка, которую заменили, даже при двух загрузках сразу
	private async swapPhoto(id: string, photo: string | null): Promise<Product> {
		const before = await this.productModel.findByIdAndUpdate(id, { photo }).exec()
		if (!before) throw new NotFoundException('Товар не найден')
		if (before.photo) await this.photoModel.deleteOne({ token: before.photo }).exec()
		this.emit('product-updated')
		return { ...before.toObject(), photo }
	}

	async getPhoto(token: string): Promise<ProductPhoto> {
		const photo = await this.photoModel.findOne({ token }).exec()
		// Отдаём только картинки: даже попавший в базу другой тип не выйдет на домен приложения
		if (!photo || !IMAGE_TYPES.includes(photo.contentType)) throw new NotFoundException('Картинка не найдена')
		return photo
	}

	private async loadKindCovers(): Promise<KindCover[]> {
		const msg = await this.messageModel.findOne().select('kindCovers').lean().exec()
		return msg?.kindCovers || []
	}

	// upsert: у местности документа настроек может ещё не быть
	// shortcut: чтение-правка-запись, две одновременные правки обложек видов — побеждает последняя; начнут теряться — атомарный $pull/$push
	private async saveKindCovers(list: KindCover[]): Promise<void> {
		await this.messageModel.updateOne({}, { $set: { kindCovers: list } }, { upsert: true }).exec()
	}

	async getKinds() {
		return { covers: coversMap(await this.loadKindCovers()) }
	}

	async setKindCover(dto: KindCoverDto) {
		const list = withKindCover(await this.loadKindCovers(), dto.category, dto.cover)
		if (list.length > MAX_KIND_COVERS) throw new BadRequestException(`Слишком много обложек видов: не больше ${MAX_KIND_COVERS}`)
		await this.saveKindCovers(list)
		this.emit('product-kinds-updated')
		return { covers: coversMap(list) }
	}

	async renameKind(dto: RenameKindDto, currentUser: UserModel) {
		const from = dto.from
		const to = dto.to.trim()
		if (!from || !to) throw new BadRequestException('Название вида не может быть пустым')
		if (from === to) throw new BadRequestException('Новое название вида совпадает с прежним')
		await this.assertNoActiveInventory()
		const res = await this.productModel.updateMany({ category: from }, { $set: { category: to } }).exec()
		const before = await this.loadKindCovers()
		const list = renamedKindCovers(before, from, to)
		if (list !== before) await this.saveKindCovers(list)
		if (!res.matchedCount && list === before) throw new NotFoundException('Вид не найден')
		await this.changeHistoryService.createChangeHistory({
			user: currentUser._id,
			changeType: 'product-updated',
			description: `${currentUser.name}: Товары вида ${from} обновлены (${res.modifiedCount}). Изменения: Категория изменена с ${from} на ${to}`,
			changeDate: Date.now(),
		})
		return { modified: res.modifiedCount, covers: coversMap(list) }
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
