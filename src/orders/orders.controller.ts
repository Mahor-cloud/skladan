import {
	Body,
	Controller,
	Delete,
	Get,
	Param,
	Post,
	Put,
	UsePipes,
} from '@nestjs/common'
import { Auth } from 'src/auth/decorators/auth.decorator'
import { CurrentUser } from 'src/auth/decorators/current-user.decorator'
import { UserModel } from 'src/auth/user.model'
import { IdValidationPipe } from 'src/pipes/id.validation.pipe'
import { CreateOrderDto } from './dto/create-order.dto'
import { UpdateOrderDto } from './dto/update-order.dto'
import { OrdersService } from './orders.service'

@Controller('orders')
export class OrdersController {
	constructor(private readonly ordersService: OrdersService) {}

	@Post()
	@Auth('user', ['create_orders'])
	create(
		@Body() createOrderDto: CreateOrderDto[],
		@CurrentUser() currentUser: UserModel
	) {
		return this.ordersService.createOrder(createOrderDto, currentUser)
	}

	@Get()
	@Auth('user', ['view_orders'])
	findAll() {
		return this.ordersService.findAll()
	}

	@Get(':id')
	@Auth('user', ['view_orders'])
	@UsePipes(IdValidationPipe)
	findOne(@Param('id') id: string) {
		return this.ordersService.findOne(id)
	}

	@Put(':id')
	@Auth('user', ['edit_orders'])
	@UsePipes(IdValidationPipe)
	update(
		@Param('id') id: string,
		@Body() updateOrderDto: UpdateOrderDto,
		@CurrentUser() currentUser: UserModel
	) {
		return this.ordersService.update(id, updateOrderDto, currentUser)
	}

	@Delete(':id')
	@Auth('admin', ['delete_orders'])
	@UsePipes(IdValidationPipe)
	remove(@Param('id') id: string, @CurrentUser() currentUser: UserModel) {
		return this.ordersService.remove(id, currentUser)
	}
}
