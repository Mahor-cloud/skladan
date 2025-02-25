import {
	BadRequestException,
	ForbiddenException,
	Injectable,
} from '@nestjs/common'
import { ModelType, Ref } from '@typegoose/typegoose/lib/types'
import { InjectModel } from 'nestjs-typegoose'
import { UserModel } from 'src/auth/user.model'
import { ChangeHistoryService } from 'src/change-history/change-history.service'
import { Product } from 'src/products/product.model'
import { Role } from 'src/roles/role.model'
import { CreateOrderDto } from './dto/create-order.dto'
import { UpdateOrderDto } from './dto/update-order.dto'
import { Order } from './order.model'

@Injectable()
export class OrdersService {
	constructor(
		@InjectModel(Order) private readonly orderModel: ModelType<Order>,
		@InjectModel(Role) private readonly roleModel: ModelType<Role>,
		@InjectModel(Product) private readonly productModel: ModelType<Product>,
		private readonly changeHistoryService: ChangeHistoryService
	) {}

	async createOrder(
		createOrderDto: CreateOrderDto[],
		currentUser: UserModel
	): Promise<Order> {
		const maxOrderNumber = await this.orderModel
			.findOne()
			.sort({
				orderNumber: -1,
			})
			.select('orderNumber')
			.exec()

		const orderNumber = maxOrderNumber ? maxOrderNumber.orderNumber + 1 : 1

		const createdOrder = new this.orderModel({
			orderNumber,
			items: createOrderDto,
			user: currentUser._id,
		})
		await createdOrder.save()

		await this.changeHistoryService.createChangeHistory({
			user: currentUser._id,
			changeType: 'order-created',
			description: `${currentUser.name} Заказ ${createdOrder.orderNumber} создан.`,
			changeDate: Date.now(),
		})
		return createdOrder
	}

	async findAll(): Promise<Order[]> {
		return this.orderModel
			.find()
			.populate({
				path: 'user',
				select: '_id name isAdmin',
			})
			.exec()
	}

	async findOne(id: string): Promise<Order> {
		return this.orderModel
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
	}

	async update(
		id: string,
		updateOrderDto: UpdateOrderDto,
		currentUser: UserModel
	): Promise<Order> {
		const oldOrder = await this.orderModel.findById(id).exec()
		const userRole = await this.roleModel.findById(currentUser.role).exec()
		if (
			oldOrder.user.toString() !== currentUser._id.toString() &&
			!currentUser.isAdmin
		) {
			throw new BadRequestException(
				'У вас нет прав для доступа к этому заказу Вот тут'
			)
		}
		if (oldOrder.isCompleted) {
			throw new BadRequestException('Заказ уже завершен')
		}
		if (oldOrder.isPaid && !userRole.permissions.includes('approve-payment')) {
			throw new BadRequestException('Нельзя изменить оплаченный заказ')
		}

		if (
			updateOrderDto.confirmedPaid !== undefined &&
			updateOrderDto.confirmedPaid &&
			!oldOrder.confirmedPaid
		) {
			if (!userRole.permissions.includes('approve-payment')) {
				throw new ForbiddenException('У вас нет прав для подтверждения платежа')
			}
		}

		const updatedOrder = await this.orderModel
			.findByIdAndUpdate(id, updateOrderDto, { new: true })
			.exec()
		const changes = this.getChanges(oldOrder, updatedOrder)

		if (updatedOrder.isCompleted && !oldOrder.isCompleted) {
			await this.updateProducts(updatedOrder.items)
		}

		await this.changeHistoryService.createChangeHistory({
			user: currentUser._id,
			changeType: 'order-updated',
			description: `${currentUser.name}: Заказ ${updatedOrder.orderNumber} обновлен. Изменения: ${changes}`,
			changeDate: Date.now(),
		})
		return updatedOrder
	}

	private async updateProducts(
		items: { product: Ref<Product>; quantity: number }[]
	): Promise<void> {
		for (const item of items) {
			const product = await this.productModel.findById(item.product).exec()
			await product.updateOne(
				{ quantity: product.quantity - item.quantity },
				{ new: true }
			)
		}
	}

	async remove(id: string, currentUser: UserModel): Promise<Order> {
		const order = await this.orderModel.findById(id).exec()

		if (
			order.user.toString() !== currentUser._id.toString() &&
			!currentUser.isAdmin
		) {
			throw new BadRequestException('У вас нет прав для доступа к этому заказу')
		}

		if (!order) {
			throw new BadRequestException('Заказ не найден')
		}

		if (order.isCompleted) {
			throw new BadRequestException('Заказ уже завершен нельзя удалить')
		}

		const removedOrder = await this.orderModel.findByIdAndDelete(id).exec()

		await this.changeHistoryService.createChangeHistory({
			user: currentUser._id,
			changeType: 'order-deleted',
			description: `${currentUser.name}: Заказ ${removedOrder.orderNumber} удален.`,
			changeDate: Date.now(),
		})

		return removedOrder
	}

	private getChanges(oldOrder: Order, newOrder: Order): string {
		const changes = []
		if (JSON.stringify(oldOrder.items) !== JSON.stringify(newOrder.items)) {
			changes.push(`Список товаров изменен`)
		}
		if (oldOrder.confirmedPaid !== newOrder.confirmedPaid) {
			changes.push(
				oldOrder.confirmedPaid
					? 'Оплата не подтверждена'
					: 'Оплата подтверждена'
			)
		}
		if (oldOrder.isPaid !== newOrder.isPaid) {
			changes.push(newOrder.isPaid ? 'Заказ оплачен' : 'Заказ не оплачен')
		}
		if (oldOrder.comment !== newOrder.comment) {
			changes.push(
				`Комментарий изменен с ${oldOrder.comment} на ${newOrder.comment}`
			)
		}
		if (oldOrder.isCompleted !== newOrder.isCompleted) {
			changes.push(
				newOrder.isCompleted ? 'Заказ завершен' : 'Заказ не завершен'
			)
		}
		return changes.join(', ')
	}
}
