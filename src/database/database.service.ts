import { Injectable } from '@nestjs/common'
import { ModelType } from '@typegoose/typegoose/lib/types'
import { InjectModel } from 'nestjs-typegoose'
import { UserModel } from 'src/auth/user.model'
import { ChangeHistory } from 'src/change-history/change-history.model'
import { SubscriptionModel } from 'src/change-history/subscription.model'
import { Inventory } from 'src/inventory/inventory.model'
import { Order } from 'src/orders/order.model'
import { Product } from 'src/products/product.model'
import { Purchase } from 'src/purchases/purchase.model'
import { Role } from 'src/roles/role.model'
import { MessagesDto } from './messages.dto'
import { Message } from './messages.model'

@Injectable()
export class DatabaseService {
	constructor(
		@InjectModel(Inventory)
		private readonly inventoryModel: ModelType<Inventory>,
		@InjectModel(Message) private readonly messageModel: ModelType<Message>,
		@InjectModel(Role) private readonly roleModel: ModelType<Role>,
		@InjectModel(Purchase) private readonly purchaseModel: ModelType<Purchase>,
		@InjectModel(Product) private readonly productModel: ModelType<Product>,
		@InjectModel(Order) private readonly orderModel: ModelType<Order>,
		@InjectModel(UserModel) private readonly userModel: ModelType<UserModel>,
		@InjectModel(SubscriptionModel)
		private readonly subscriptionModel: ModelType<SubscriptionModel>,
		@InjectModel(ChangeHistory)
		private readonly changeHistoryModel: ModelType<ChangeHistory>
	) {}

	async getMsgs(): Promise<Message> {
		return await this.messageModel.findOne().exec()
	}

	async updateMsgs(updatedMsgs: MessagesDto): Promise<Message> {
		return await this.messageModel
			.findOneAndUpdate({}, updatedMsgs, { new: true, upsert: true })
			.exec()
	}

	async exportData(): Promise<any> {
		const data = {
			inventories: await this.inventoryModel.find().exec(),
			roles: await this.roleModel.find().exec(),
			messages: await this.messageModel.find().exec(),
			purchases: await this.purchaseModel.find().exec(),
			products: await this.productModel.find().exec(),
			orders: await this.orderModel.find().exec(),
			users: await this.userModel.find().exec(),
			changeHistories: await this.changeHistoryModel.find().exec(),
			subscriptions: await this.subscriptionModel.find().exec(),
		}
		return data
	}

	async importData(data: any): Promise<void> {
		await this.inventoryModel.deleteMany({})
		await this.roleModel.deleteMany({})
		await this.purchaseModel.deleteMany({})
		await this.productModel.deleteMany({})
		await this.orderModel.deleteMany({})
		await this.userModel.deleteMany({})
		await this.changeHistoryModel.deleteMany({})
		await this.messageModel.deleteMany({})
		await this.subscriptionModel.deleteMany({})

		await this.inventoryModel.insertMany(data.inventories)
		await this.roleModel.insertMany(data.roles)
		await this.purchaseModel.insertMany(data.purchases)
		await this.productModel.insertMany(data.products)
		await this.orderModel.insertMany(data.orders)
		await this.userModel.insertMany(data.users)
		await this.changeHistoryModel.insertMany(data.changeHistories)
		await this.messageModel.insertMany(data.messages)
		await this.subscriptionModel.insertMany(data.subscriptions)
	}
}
