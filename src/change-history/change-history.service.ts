/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { ModelType } from '@typegoose/typegoose/lib/types'
import { Types } from 'mongoose'
import { InjectModel } from 'nestjs-typegoose'
import { UserModel } from 'src/auth/user.model'
import * as webpush from 'web-push'
import { getTenantContext } from '../common/tenant-context/tenant-context.storage'
import { ChangeHistory } from './change-history.model'
import { CreateChangeHistoryDto } from './dto/create-change-history.dto'
import { RealtimeService } from './realtime.service'
import { SubscriptionDto } from './dto/subscription.dto'
import {
	SubscriptionCategory,
	SubscriptionModel,
	SubscriptionPreferences,
} from './subscription.model'

export const EVENT_LABELS_RU: Record<string, string> = {
	'order-created': 'Заказ создан',
	'order-updated': 'Заказ обновлён',
	'order-deleted': 'Заказ удалён',
	'order-surcharge-pending': 'Требуется доплата',
	'order-refund-pending': 'Требуется возврат',
	'purchase-created': 'Закупка создана',
	'purchase-updated': 'Закупка обновлена',
	'purchase-deleted': 'Закупка удалена',
	'inventory-created': 'Инвентаризация начата',
	'inventory-updated': 'Инвентаризация обновлена',
	'inventory-edited-after-completion': 'Завершённая инвентаризация переписана',
	'inventory-deleted': 'Инвентаризация удалена',
	'inventory-deleted-after-completion': 'Завершённая инвентаризация удалена',
	'product-created': 'Товар создан',
	'product-updated': 'Товар обновлён',
	'product-deleted': 'Товар удалён',
	'user-created': 'Пользователь создан',
	'user-updated': 'Пользователь обновлён',
	'user-deleted': 'Пользователь удалён',
	'role-created': 'Роль создана',
	'role-updated': 'Роль обновлена',
	'role-deleted': 'Роль удалена',
}

function categoryForChangeType(changeType: string): SubscriptionCategory {
	if (changeType === 'order-surcharge-pending' || changeType === 'order-refund-pending')
		return 'payment'
	if (changeType.startsWith('order-')) return 'orders'
	if (changeType.startsWith('purchase-')) return 'purchases'
	if (changeType.startsWith('inventory-')) return 'inventory'
	if (changeType.startsWith('product-')) return 'products'
	if (changeType.startsWith('user-')) return 'users'
	if (changeType.startsWith('role-')) return 'roles'
	return 'orders'
}

function permissionForCategory(category: SubscriptionCategory): string | null {
	return null
}

@Injectable()
export class ChangeHistoryService {
	private readonly logger = new Logger(ChangeHistoryService.name)
	private vapidKeys = {
		publicKey: this.configService.get<string>('VAPID_PUBLIC_KEY'),
		privateKey: this.configService.get<string>('VAPID_PRIVATE_KEY'),
	}
	constructor(
		@InjectModel(ChangeHistory)
		private readonly changeHistoryModel: ModelType<ChangeHistory>,
		@InjectModel(SubscriptionModel)
		private readonly subscriptionModel: ModelType<SubscriptionModel>,
		private readonly configService: ConfigService,
		private readonly realtime: RealtimeService
	) {
		const contactEmail = this.configService.get<string>('VAPID_CONTACT_EMAIL') || 'mailto:noreply@example.com'
		const mailto = contactEmail.startsWith('mailto:') ? contactEmail : `mailto:${contactEmail}`
		if (this.vapidKeys.publicKey && this.vapidKeys.privateKey) {
			webpush.setVapidDetails(mailto, this.vapidKeys.publicKey, this.vapidKeys.privateKey)
		} else {
			this.logger.warn('VAPID keys are not set — web-push disabled')
		}
	}

	private static readonly DEBOUNCE_MS = 2000
	private pushBuffer = new Map<
		string,
		{
			count: number
			lastBody: string
			company: Types.ObjectId
			changeType: string

			relatedUsers: Set<string>
			timer: NodeJS.Timeout
		}
	>()

	async subscribeNotification(
		subscription: SubscriptionDto,
		currentUser: UserModel
	) {
		try {
			const ctx = getTenantContext()
			const company = ctx?.company ? new Types.ObjectId(String(ctx.company)) : undefined
			const update: any = { ...subscription, user: currentUser._id }
			if (subscription.preferences) update.preferences = subscription.preferences
			if (company) update.company = company
			await this.subscriptionModel.findOneAndUpdate(
				{ endpoint: subscription.endpoint, user: currentUser._id },
				update,
				{ upsert: true, new: true, setDefaultsOnInsert: true }
			)
			try {
				await webpush.sendNotification(
					subscription,
					JSON.stringify({
						title: 'Подписка на уведомления',
						body: `${currentUser.name}, подписка активна`,
					})
				)
			} catch (pushErr) {
				this.logger.warn(`Welcome push delivery failed (subscription saved anyway): ${(pushErr as any)?.message}`)
			}
			return { ok: true }
		} catch (error) {
			this.logger.error('Error subscribe notification', error as any)
			throw new BadRequestException('Ошибка при подписке на уведомления')
		}
	}

	async getMySubscription(currentUser: UserModel) {
		const ctx = getTenantContext()
		const company = ctx?.company ? new Types.ObjectId(String(ctx.company)) : null
		if (!company) return null
		const sub = await this.subscriptionModel
			.findOne({ company, user: currentUser._id })
			.setOptions({ skipTenantScope: true } as any)
			.sort({ subscribedAt: -1 })
			.exec()
		return sub
	}

	async updateMyPreferences(currentUser: UserModel, preferences: SubscriptionPreferences) {
		const ctx = getTenantContext()
		const company = ctx?.company ? new Types.ObjectId(String(ctx.company)) : null
		if (!company) throw new BadRequestException('Компания не определена')
		const result = await this.subscriptionModel
			.updateMany(
				{ company, user: currentUser._id },
				{ $set: { preferences } }
			)
			.setOptions({ skipTenantScope: true } as any)
			.exec()
		return { matched: result.matchedCount, modified: result.modifiedCount, preferences }
	}

	async createChangeHistory(
		createChangeHistoryDto: CreateChangeHistoryDto
	): Promise<ChangeHistory> {
		const ctx = getTenantContext()
		const companyForHistory = (createChangeHistoryDto as any).company || ctx?.company || null
		const createdChangeHistory = new this.changeHistoryModel({
			...createChangeHistoryDto,
			...(companyForHistory ? { company: new Types.ObjectId(String(companyForHistory)) } : {}),
		})

		const saved = await createdChangeHistory.save()

		const pushCompany = companyForHistory
			? new Types.ObjectId(String(companyForHistory))
			: null
		if (pushCompany) {
			this.schedulePush(
				createChangeHistoryDto.changeType,
				createChangeHistoryDto.description,
				pushCompany,
				(createChangeHistoryDto as any).relatedUser
			)
		}

		this.realtime.emit(
			companyForHistory ? String(companyForHistory) : null,
			createChangeHistoryDto.changeType
		)

		return saved
	}

	private schedulePush(
		changeType: string,
		body: string,
		company: Types.ObjectId,
		relatedUser?: any
	) {
		const key = `${company.toString()}:${changeType}`
		const existing = this.pushBuffer.get(key)
		if (existing) {
			clearTimeout(existing.timer)
			existing.count += 1
			existing.lastBody = body
		}
		const entry =
			existing || {
				count: 1,
				lastBody: body,
				company,
				changeType,
				relatedUsers: new Set<string>(),
				timer: null as any,
			}
		if (relatedUser) entry.relatedUsers.add(String(relatedUser))
		entry.timer = setTimeout(() => {
			this.pushBuffer.delete(key)
			const title = this.formatTitle(entry.changeType, entry.count)
			this.dispatchPushNotifications(
				entry.changeType,
				title,
				entry.lastBody,
				entry.company,
				entry.relatedUsers
			).catch((err) => this.logger.error('Push dispatch failed', err as any))
		}, ChangeHistoryService.DEBOUNCE_MS)
		this.pushBuffer.set(key, entry)
	}

	private formatTitle(changeType: string, count: number): string {
		const ruTitle = EVENT_LABELS_RU[changeType] || changeType
		if (count <= 1) return ruTitle

		return `${ruTitle} (${count} событий)`
	}

	private async dispatchPushNotifications(
		changeType: string,
		title: string,
		body: string,
		company: Types.ObjectId,
		relatedUsers: Set<string> = new Set()
	): Promise<void> {
		const category = categoryForChangeType(changeType)
		const requiredPermission = permissionForCategory(category)

		const subscriptions = await this.subscriptionModel
			.find({ company })
			.populate({
				path: 'user',
				select: '_id name isAdmin role',
				populate: { path: 'role', select: 'permissions name' },
			})
			.setOptions({ skipTenantScope: true } as any)
			.exec()

		for (const subscription of subscriptions) {

			const pref = (subscription.preferences as any)?.[category]
			if (pref === false) continue

			if (
				category === 'orders' &&
				(subscription.preferences as any)?.ordersOwnOnly === true
			) {
				const uid = String(
					(subscription.user as any)?._id || subscription.user
				)
				if (!relatedUsers || relatedUsers.size === 0 || !relatedUsers.has(uid))
					continue
			}

			if (requiredPermission) {
				const user: any = subscription.user
				if (!user) continue
				const isAdmin = !!user.isAdmin
				const perms = (user.role as any)?.permissions || []
				if (!isAdmin && !perms.includes(requiredPermission)) continue
			}

			if (!subscription.keys?.p256dh || !subscription.keys?.auth) {
				await this.subscriptionModel
					.deleteOne({ _id: subscription._id })
					.setOptions({ skipTenantScope: true } as any)
					.exec()
				this.logger.warn(`Subscription ${subscription._id} removed (missing keys)`)
				continue
			}

			try {
				await webpush.sendNotification(
					subscription,
					JSON.stringify({ title, body })
				)
			} catch (error) {
				if (error.statusCode === 410) {
					await this.subscriptionModel
						.deleteOne({ _id: subscription._id })
						.setOptions({ skipTenantScope: true } as any)
						.exec()
					this.logger.log(`Subscription ${subscription._id} removed (410 Gone).`)
				} else {
					this.logger.error(
						`Push delivery error endpoint=${subscription.endpoint} statusCode=${error.statusCode} message=${error.message}`
					)
				}
			}
		}
	}

	async findAll(opts: { from?: number; to?: number; page?: number; limit?: number } = {}) {
		const page = Math.max(1, Number(opts.page) || 1)
		const limit = Math.min(500, Math.max(1, Number(opts.limit) || 50))
		const skip = (page - 1) * limit
		const filter: any = {}
		if (opts.from != null && Number.isFinite(opts.from)) {
			filter.changeDate = { ...(filter.changeDate || {}), $gte: opts.from }
		}
		if (opts.to != null && Number.isFinite(opts.to)) {
			filter.changeDate = { ...(filter.changeDate || {}), $lt: opts.to }
		}
		const [items, total] = await Promise.all([
			this.changeHistoryModel
				.find(filter)
				.sort({ changeDate: -1 })
				.skip(skip)
				.limit(limit)
				.populate({ path: 'user', select: '_id name isAdmin' })
				.exec(),
			this.changeHistoryModel.countDocuments(filter).exec(),
		])
		return { items, total, page, limit, pages: Math.ceil(total / limit) }
	}

	async findOne(id: string): Promise<ChangeHistory> {
		return this.changeHistoryModel
			.findById(id)
			.populate({
				path: 'user',
				select: '_id name isAdmin',
			})
			.exec()
	}
}
