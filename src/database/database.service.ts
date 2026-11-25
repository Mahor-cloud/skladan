/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common'
import { ModelType } from '@typegoose/typegoose/lib/types'
import { InjectModel } from 'nestjs-typegoose'
import { UserModel } from 'src/auth/user.model'
import { ChangeHistory } from 'src/change-history/change-history.model'
import { SubscriptionModel } from 'src/change-history/subscription.model'
import { Company } from 'src/company/company.model'
import { Counter } from 'src/common/counters/counter.model'
import { Inventory } from 'src/inventory/inventory.model'
import { Order } from 'src/orders/order.model'
import { CabinetItem } from 'src/cabinet/cabinet-item.model'
import { ProductPhoto } from 'src/products/product-photo.model'
import { imageType, PHOTO_TOKEN } from 'src/products/products.service'
import { Product } from 'src/products/product.model'
import { Purchase } from 'src/purchases/purchase.model'
import { Role } from 'src/roles/role.model'
import { RealtimeService } from 'src/change-history/realtime.service'
import { getTenantContext } from 'src/common/tenant-context/tenant-context.storage'
import { PaymentMessageDto } from './messages.dto'
import { Message } from './messages.model'

const EXPORT_VERSION = 'v2.0.0'

// Байты картинок в JSON — base64: Buffer.toJSON дал бы массив чисел вчетверо длиннее
const photosToJson = (photos: ProductPhoto[]) =>
	photos.map((p) => ({ company: p.company, token: p.token, contentType: p.contentType, data: p.data.toString('base64') }))
// Фото своих позиций «Моего склада» (с user) в дамп не идут и импортом не трогаются: самих позиций в дампе нет
const SHARED_PHOTOS = { user: null }
// Из дампа — только ключ по шаблону и байты картинки, тип по байтам: иначе импорт выложил бы на домен приложения любой файл
const photosFromJson = (photos: any[]) =>
	photos.flatMap((p) => {
		if (p.user) return []
		const data = Buffer.from(String(p.data), 'base64')
		const contentType = imageType(data)
		return typeof p.token === 'string' && PHOTO_TOKEN.test(p.token) && contentType ? [{ ...p, data, contentType }] : []
	})
// Ключ без принятой картинки сбрасывается: иначе у товара битая обложка
const withKnownPhotos = (products: any[], photos: any[]) => {
	const tokens = new Set(photos.map((p) => p.token))
	return products.map((p) => (p.photo && !tokens.has(p.photo) ? { ...p, photo: null } : p))
}

const COMPANY_DUMP_KEYS = ['users', 'products', 'orders', 'purchases', 'inventories', 'roles', 'messages', 'subscriptions', 'changeHistories', 'productPhotos']

// До любого удаления: иначе кривой дамп роняет импорт, когда данные уже стёрты
function assertDumpShape(data: any, keys: string[]) {
	for (const key of keys) {
		const value = data[key]
		if (value == null) continue
		if (!Array.isArray(value) || value.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) {
			throw new BadRequestException(`Повреждённый дамп: «${key}» должно быть списком записей`)
		}
	}
}

// Список импорта: ключ дампа, модель, записи к вставке
type ImportList = [string, any, any[]]

@Injectable()
export class DatabaseService {
	constructor(
		@InjectModel(Inventory) private readonly inventoryModel: ModelType<Inventory>,
		@InjectModel(Message) private readonly messageModel: ModelType<Message>,
		@InjectModel(Role) private readonly roleModel: ModelType<Role>,
		@InjectModel(Purchase) private readonly purchaseModel: ModelType<Purchase>,
		@InjectModel(Product) private readonly productModel: ModelType<Product>,
		@InjectModel(Order) private readonly orderModel: ModelType<Order>,
		@InjectModel(UserModel) private readonly userModel: ModelType<UserModel>,
		@InjectModel(SubscriptionModel) private readonly subscriptionModel: ModelType<SubscriptionModel>,
		@InjectModel(ChangeHistory) private readonly changeHistoryModel: ModelType<ChangeHistory>,
		@InjectModel(Company) private readonly companyModel: ModelType<Company>,
		@InjectModel(Counter) private readonly counterModel: ModelType<Counter>,
		@InjectModel(ProductPhoto) private readonly photoModel: ModelType<ProductPhoto>,
		private readonly realtime: RealtimeService,
		@InjectModel(CabinetItem) private readonly cabinetModel: ModelType<CabinetItem>
	) {}

	// импорт заменил фото: у позиции «Моего склада» с ключом пропавшей картинки — без фото, а не битая обложка
	private async dropLostCabinetPhotos(options: any = {}) {
		const tokens = await this.photoModel.distinct('token').setOptions(options).exec()
		await this.cabinetModel.updateMany({ photo: { $ne: null, $nin: tokens } }, { photo: null }).setOptions(options).exec()
	}

	private emitMsgChanged() {
		const ctx = getTenantContext()
		this.realtime.emit(ctx?.company ? String(ctx.company) : null, 'message-updated')
	}

	async getMsgs(): Promise<Message> {
		return await this.messageModel.findOne().exec()
	}

	// Только присланные поля: старый клиент шлёт один paymentMessage и не должен затирать реквизиты
	async updatePaymentMessage(dto: PaymentMessageDto): Promise<Message> {
		const fields = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined))
		const res = await this.messageModel
			.findOneAndUpdate({}, { $set: fields }, { new: true, upsert: true })
			.exec()
		this.emitMsgChanged()
		return res
	}

	async updateReceivedMessage(receivedMessage: string): Promise<Message> {
		const res = await this.messageModel
			.findOneAndUpdate({}, { receivedMessage }, { new: true, upsert: true })
			.exec()
		this.emitMsgChanged()
		return res
	}

	async updateInventoryOpenDocs(allow: boolean, currentUser: UserModel): Promise<Message> {
		if ((currentUser.role as any)?.isSystem !== true) {
			throw new ForbiddenException('Эту настройку меняет только председатель')
		}
		const res = await this.messageModel
			.findOneAndUpdate({}, { allowInventoryWithOpenDocs: allow === true }, { new: true, upsert: true })
			.exec()
		this.emitMsgChanged()
		return res
	}

	async updateTargetWarehouseValue(targetWarehouseValue: number): Promise<Message> {
		const value = Math.max(0, Number(targetWarehouseValue) || 0)
		const res = await this.messageModel
			.findOneAndUpdate({}, { targetWarehouseValue: value }, { new: true, upsert: true })
			.exec()
		this.emitMsgChanged()
		return res
	}

	async exportCompanyData(): Promise<any> {
		return {
			_meta: { type: 'company', version: EXPORT_VERSION, exportedAt: Date.now() },
			users: await this.userModel
				.find()
				.select('-password -refreshToken')
				.exec(),
			products: await this.productModel.find().exec(),
			orders: await this.orderModel.find().exec(),
			purchases: await this.purchaseModel.find().exec(),
			inventories: await this.inventoryModel.find().exec(),
			roles: await this.roleModel.find().exec(),
			messages: await this.messageModel.find().exec(),
			subscriptions: await this.subscriptionModel.find().exec(),
			changeHistories: await this.changeHistoryModel.find().exec(),
			productPhotos: photosToJson(await this.photoModel.find(SHARED_PHOTOS).exec()),
		}
	}

	async importCompanyData(currentCompany: string, data: any, importer?: UserModel): Promise<void> {
		if (!data || data._meta?.type !== 'company') {
			throw new BadRequestException('Ожидается per-company дамп (_meta.type === "company")')
		}
		assertDumpShape(data, COMPANY_DUMP_KEYS)

		for (const key of COMPANY_DUMP_KEYS) {
			for (const r of data[key] || []) {
				if (r.company && String(r.company) !== String(currentCompany)) {
					throw new ForbiddenException('В дампе обнаружены записи другой компании')
				}
			}
		}

		// _id остаются: на них держатся связи (пользователь → роль, заказ → пользователь и товар, «Мой склад»)
		const sanitize = (arr?: any[]) =>
			(arr || []).map(({ __v, company, ...rest }) => ({
				...rest,
				company: currentCompany,
			}))

		const users = await this.withCurrentAccess(
			sanitize(data.users).map((u: any) => ({
				...u,
				isSuperAdmin: false,
				isAdmin: !!u.isAdmin,
				refreshToken: null,
			}))
		)
		const productPhotos = photosFromJson(sanitize(data.productPhotos))
		// Роли и пользователи — первыми: если вставка дальше упадёт, в местность можно войти и повторить импорт
		const lists: ImportList[] = [
			['roles', this.roleModel, sanitize(data.roles)],
			['users', this.userModel, users],
			['products', this.productModel, withKnownPhotos(sanitize(data.products), productPhotos)],
			['orders', this.orderModel, sanitize(data.orders)],
			['purchases', this.purchaseModel, sanitize(data.purchases)],
			['inventories', this.inventoryModel, sanitize(data.inventories)],
			['messages', this.messageModel, sanitize(data.messages)],
			['subscriptions', this.subscriptionModel, sanitize(data.subscriptions)],
			['changeHistories', this.changeHistoryModel, sanitize(data.changeHistories)],
			['productPhotos', this.photoModel, productPhotos],
		]
		await this.assertImportable(lists, users, importer, { company: { $ne: currentCompany } })

		await Promise.all(lists.map(([, model]) => model.deleteMany(model === this.photoModel ? SHARED_PHOTOS : {})))
		for (const [, model, records] of lists) {
			if (records.length) await model.insertMany(records)
		}
		await this.dropLostCabinetPhotos()
	}

	// Пароли в дамп не попадают: пользователю, который сейчас есть в базе (по _id, иначе по логину в своей местности),
	// остаются нынешние пароль и номер сессии. Читать до удаления; пароль из самого дампа не принимается.
	private async withCurrentAccess(users: any[], options: any = {}): Promise<any[]> {
		if (!users.length) return users
		const current: any[] = await this.userModel
			.find()
			.select('_id login company password tokenVersion')
			.setOptions(options)
			.lean()
			.exec()
		const loginKey = (u: any) => `${u.company ?? null}:${u.login}`
		const byId = new Map(current.map((u) => [String(u._id), u]))
		const byLogin = new Map(current.map((u) => [loginKey(u), u]))
		return users.map((u) => {
			const now = byId.get(String(u._id)) ?? byLogin.get(loginKey(u))
			return { ...u, password: now?.password, tokenVersion: now?.tokenVersion ?? u.tokenVersion }
		})
	}

	// До любого удаления: всё, на чём вставка упала бы уже после стирания (кривой, повторный или занятый вне области
	// импорта _id, занятый логин), и импорт, после которого импортирующий сам не войдёт. outside — условие «не эта местность».
	private async assertImportable(lists: ImportList[], users: any[], importer?: UserModel, outside?: Record<string, any>) {
		const skip = { skipTenantScope: true } as any
		for (const [key, model, records] of lists) {
			const ids = records.filter((r) => r._id != null).map((r) => String(r._id).toLowerCase())
			if (ids.some((id) => !/^[0-9a-f]{24}$/.test(id)) || new Set(ids).size !== ids.length) {
				throw new BadRequestException(`Повреждённый дамп: в «${key}» неверный или повторяющийся _id`)
			}
			// та же проверка схемой, что сделает вставка (например, право роли из другой версии)
			for (const r of records) {
				await new model(r).validate().catch((e: Error) => {
					throw new BadRequestException(`Повреждённый дамп: запись в «${key}» не проходит проверку — ${e.message}`)
				})
			}
			if (outside && ids.length && (await model.countDocuments({ _id: { $in: ids }, ...outside }).setOptions(skip))) {
				throw new ForbiddenException('В дампе обнаружены записи другой компании')
			}
		}
		const logins = users.map((u) => u.login)
		const roleNames = (lists.find(([key]) => key === 'roles')?.[2] || []).map((r) => `${r.company}:${r.name}`)
		if (new Set(users.map((u) => `${u.company ?? null}:${u.login}`)).size !== users.length || new Set(roleNames).size !== roleNames.length) {
			throw new BadRequestException('Повреждённый дамп: повторяется логин пользователя или название роли')
		}
		// вход ищет логин по всем местностям сразу — чужой логин из дампа перекрыл бы вход его владельцу
		if (outside && logins.length && (await this.userModel.countDocuments({ login: { $in: logins }, ...outside }).setOptions(skip))) {
			throw new BadRequestException('Повреждённый дамп: логин из дампа занят в другой местности')
		}
		// в полном импорте (outside не задан) импортирующий — супер-админ и должен им остаться
		const stays = (u: any) => u.password && !u.deletedAt && (outside || u.isSuperAdmin === true) && (String(u._id) === String(importer._id) || u.login === importer.login)
		if (importer && !users.some(stays)) {
			throw new BadRequestException('Импорт отменён: в дампе нет вашей учётной записи — после него вы не смогли бы войти')
		}
	}

	async exportFullData(): Promise<any> {
		return {
			_meta: { type: 'full', version: EXPORT_VERSION, exportedAt: Date.now() },
			companies: await this.companyModel.find().setOptions({ skipTenantScope: true } as any).exec(),
			counters: await this.counterModel.find().setOptions({ skipTenantScope: true } as any).exec(),
			users: await this.userModel
				.find()
				.select('-password -refreshToken')
				.setOptions({ skipTenantScope: true } as any)
				.exec(),
			products: await this.productModel.find().setOptions({ skipTenantScope: true } as any).exec(),
			orders: await this.orderModel.find().setOptions({ skipTenantScope: true } as any).exec(),
			purchases: await this.purchaseModel.find().setOptions({ skipTenantScope: true } as any).exec(),
			inventories: await this.inventoryModel.find().setOptions({ skipTenantScope: true } as any).exec(),
			roles: await this.roleModel.find().setOptions({ skipTenantScope: true } as any).exec(),
			messages: await this.messageModel.find().setOptions({ skipTenantScope: true } as any).exec(),
			subscriptions: await this.subscriptionModel.find().setOptions({ skipTenantScope: true } as any).exec(),
			changeHistories: await this.changeHistoryModel.find().setOptions({ skipTenantScope: true } as any).exec(),
			productPhotos: photosToJson(await this.photoModel.find(SHARED_PHOTOS).setOptions({ skipTenantScope: true } as any).exec()),
		}
	}

	async importFullData(data: any, confirm: string, importer?: UserModel): Promise<void> {
		if (!data || data._meta?.type !== 'full') {
			throw new BadRequestException('Ожидается полный дамп (_meta.type === "full")')
		}
		if (confirm !== 'i-know-what-i-am-doing') {
			throw new BadRequestException('Для импорта требуется явное подтверждение confirm="i-know-what-i-am-doing"')
		}
		assertDumpShape(data, ['companies', 'counters', ...COMPANY_DUMP_KEYS])

		const skip = { skipTenantScope: true } as any
		const users = await this.withCurrentAccess(
			(data.users || []).map((u: any) => ({ ...u, refreshToken: null })),
			skip
		)
		const productPhotos = photosFromJson(data.productPhotos || [])
		const lists: ImportList[] = [
			['companies', this.companyModel, data.companies || []],
			['counters', this.counterModel, data.counters || []],
			['roles', this.roleModel, data.roles || []],
			['users', this.userModel, users],
			['products', this.productModel, withKnownPhotos(data.products || [], productPhotos)],
			['orders', this.orderModel, data.orders || []],
			['purchases', this.purchaseModel, data.purchases || []],
			['inventories', this.inventoryModel, data.inventories || []],
			['messages', this.messageModel, data.messages || []],
			['subscriptions', this.subscriptionModel, data.subscriptions || []],
			['changeHistories', this.changeHistoryModel, data.changeHistories || []],
			['productPhotos', this.photoModel, productPhotos],
		]
		await this.assertImportable(lists, users, importer)

		await Promise.all(lists.map(([, model]) => model.deleteMany(model === this.photoModel ? SHARED_PHOTOS : {}).setOptions(skip)))
		for (const [, model, records] of lists) {
			if (records.length) await model.insertMany(records)
		}
		await this.dropLostCabinetPhotos(skip)
	}
}
