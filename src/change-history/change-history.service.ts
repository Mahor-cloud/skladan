import { BadRequestException, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { ModelType } from '@typegoose/typegoose/lib/types'
import { InjectModel } from 'nestjs-typegoose'
import { UserModel } from 'src/auth/user.model'
import * as webpush from 'web-push'
import { ChangeHistory } from './change-history.model'
import { CreateChangeHistoryDto } from './dto/create-change-history.dto'
import { SubscriptionDto } from './dto/subscription.dto'
import { SubscriptionModel } from './subscription.model'

@Injectable()
export class ChangeHistoryService {
	private vapidKeys = {
		publicKey: this.configService.get<string>('VAPID_PUBLIC_KEY'),
		privateKey: this.configService.get<string>('VAPID_PRIVATE_KEY'),
	}
	constructor(
		@InjectModel(ChangeHistory)
		private readonly changeHistoryModel: ModelType<ChangeHistory>,
		@InjectModel(SubscriptionModel)
		private readonly subscriptionModel: ModelType<SubscriptionModel>,
		private readonly configService: ConfigService
	) {
		webpush.setVapidDetails(
			'mailto:edvinkarter@gmail.com',
			this.vapidKeys.publicKey,
			this.vapidKeys.privateKey
		)
	}

	async subscribeNotification(
		subscription: SubscriptionDto,
		currentUser: UserModel
	) {
		try {
			await this.subscriptionModel.findOneAndUpdate(
				{ endpoint: subscription.endpoint },
				{ ...subscription, user: currentUser._id },
				{ upsert: true, new: true }
			)
			await webpush.sendNotification(
				subscription,
				JSON.stringify({
					title: 'Подписка на уведомления',
					body: `${currentUser.name} подписался на уведомления`,
				})
			)
		} catch (error) {
			console.error('Error subscribe notification:', error)
			new BadRequestException('Ошибка при подписке на уведомления')
		}
	}

	async createChangeHistory(
		createChangeHistoryDto: CreateChangeHistoryDto
	): Promise<ChangeHistory> {
		const createdChangeHistory = new this.changeHistoryModel(
			createChangeHistoryDto
		)
		const subscriptions = await this.subscriptionModel.find().exec()

		for (const subscription of subscriptions) {
			try {
				await webpush.sendNotification(
					subscription,
					JSON.stringify({
						title: createChangeHistoryDto.changeType,
						body: createChangeHistoryDto.description,
					})
				)
			} catch (error) {
				if (error.statusCode === 410) {
					// Удаляем подписку из базы данных, если она неактивна
					await this.subscriptionModel
						.deleteOne({ _id: subscription._id })
						.exec()
					console.log(
						`Подписка ${subscription._id} удалена, так как она неактивна.`
					)
				} else {
					// Логируем другие ошибки
					console.error('Ошибка отправки уведомления:', {
						endpoint: subscription.endpoint,
						statusCode: error.statusCode,
						message: error.message,
					})
					throw error // Пробрасываем ошибку, если это не 410
				}
			}
		}
		return createdChangeHistory.save()
	}

	async findAll(): Promise<ChangeHistory[]> {
		return this.changeHistoryModel
			.find()
			.sort({
				changeDate: -1,
			})
			.populate({
				path: 'user',
				select: '_id name isAdmin',
			})
			.exec()
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
