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
import { Product } from 'src/products/product.model'
import { Purchase } from 'src/purchases/purchase.model'
import { Role } from 'src/roles/role.model'
import { RealtimeService } from 'src/change-history/realtime.service'
import { getTenantContext } from 'src/common/tenant-context/tenant-context.storage'
import { Message } from './messages.model'

const EXPORT_VERSION = 'v2.0.0'

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
		private readonly realtime: RealtimeService
	) {}

	private emitMsgChanged() {
		const ctx = getTenantContext()
		this.realtime.emit(ctx?.company ? String(ctx.company) : null, 'message-updated')
	}



	async getMsgs(): Promise<Message> {
		return await this.messageModel.findOne().exec()
	}

	async updatePaymentMessage(paymentMessage: string): Promise<Message> {
		const res = await this.messageModel
			.findOneAndUpdate({}, { paymentMessage }, { new: true, upsert: true })
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
		}
	}

	async importCompanyData(currentCompany: string, data: any): Promise<void> {
		if (!data || data._meta?.type !== 'company') {
			throw new BadRequestException('Ожидается per-company дамп (_meta.type === "company")')
		}

		const allRecords = [
			...(data.users || []),
			...(data.products || []),
			...(data.orders || []),
			...(data.purchases || []),
			...(data.inventories || []),
			...(data.roles || []),
			...(data.messages || []),
			...(data.subscriptions || []),
			...(data.changeHistories || []),
		]
		for (const r of allRecords) {
			if (r.company && String(r.company) !== String(currentCompany)) {
				throw new ForbiddenException('В дампе обнаружены записи другой компании')
			}
		}



		const sanitize = (arr?: any[]) =>
			(arr || []).map(({ _id, __v, company, ...rest }) => ({
				...rest,
				company: currentCompany,
			}))

		const sanitizeUsers = (arr?: any[]) =>
			sanitize(arr).map((u: any) => ({
				...u,
				isSuperAdmin: false,
				isAdmin: !!u.isAdmin,
				refreshToken: null,
			}))


		await Promise.all([
			this.userModel.deleteMany({}),
			this.productModel.deleteMany({}),
			this.orderModel.deleteMany({}),
			this.purchaseModel.deleteMany({}),
			this.inventoryModel.deleteMany({}),
			this.roleModel.deleteMany({}),
			this.messageModel.deleteMany({}),
			this.subscriptionModel.deleteMany({}),
			this.changeHistoryModel.deleteMany({}),
		])

		const users = sanitizeUsers(data.users)
		const products = sanitize(data.products)
		const orders = sanitize(data.orders)
		const purchases = sanitize(data.purchases)
		const inventories = sanitize(data.inventories)
		const roles = sanitize(data.roles)
		const messages = sanitize(data.messages)
		const subscriptions = sanitize(data.subscriptions)
		const changeHistories = sanitize(data.changeHistories)

		if (users.length) await this.userModel.insertMany(users)
		if (products.length) await this.productModel.insertMany(products)
		if (orders.length) await this.orderModel.insertMany(orders)
		if (purchases.length) await this.purchaseModel.insertMany(purchases)
		if (inventories.length) await this.inventoryModel.insertMany(inventories)
		if (roles.length) await this.roleModel.insertMany(roles)
		if (messages.length) await this.messageModel.insertMany(messages)
		if (subscriptions.length) await this.subscriptionModel.insertMany(subscriptions)
		if (changeHistories.length) await this.changeHistoryModel.insertMany(changeHistories)
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
		}
	}

	async importFullData(data: any, confirm: string): Promise<void> {
		if (!data || data._meta?.type !== 'full') {
			throw new BadRequestException('Ожидается полный дамп (_meta.type === "full")')
		}
		if (confirm !== 'i-know-what-i-am-doing') {
			throw new BadRequestException('Для импорта требуется явное подтверждение confirm="i-know-what-i-am-doing"')
		}

		const skip = { skipTenantScope: true } as any
		await Promise.all([
			this.companyModel.deleteMany({}).setOptions(skip),
			this.counterModel.deleteMany({}).setOptions(skip),
			this.userModel.deleteMany({}).setOptions(skip),
			this.productModel.deleteMany({}).setOptions(skip),
			this.orderModel.deleteMany({}).setOptions(skip),
			this.purchaseModel.deleteMany({}).setOptions(skip),
			this.inventoryModel.deleteMany({}).setOptions(skip),
			this.roleModel.deleteMany({}).setOptions(skip),
			this.messageModel.deleteMany({}).setOptions(skip),
			this.subscriptionModel.deleteMany({}).setOptions(skip),
			this.changeHistoryModel.deleteMany({}).setOptions(skip),
		])

		if (data.companies?.length) await this.companyModel.insertMany(data.companies)
		if (data.counters?.length) await this.counterModel.insertMany(data.counters)
		if (data.users?.length) {
			const sanitizedUsers = (data.users as any[]).map((u) => ({
				...u,
				refreshToken: null,
			}))
			await this.userModel.insertMany(sanitizedUsers)
		}
		if (data.products?.length) await this.productModel.insertMany(data.products)
		if (data.orders?.length) await this.orderModel.insertMany(data.orders)
		if (data.purchases?.length) await this.purchaseModel.insertMany(data.purchases)
		if (data.inventories?.length) await this.inventoryModel.insertMany(data.inventories)
		if (data.roles?.length) await this.roleModel.insertMany(data.roles)
		if (data.messages?.length) await this.messageModel.insertMany(data.messages)
		if (data.subscriptions?.length) await this.subscriptionModel.insertMany(data.subscriptions)
		if (data.changeHistories?.length) await this.changeHistoryModel.insertMany(data.changeHistories)
	}
}
