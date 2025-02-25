import { forwardRef, Module } from '@nestjs/common'
import { TypegooseModule } from 'nestjs-typegoose'
import { AuthModule } from 'src/auth/auth.module'
import { ChangeHistoryModule } from 'src/change-history/change-history.module'
import { ProductsModule } from 'src/products/products.module'
import { Order } from './order.model'
import { OrdersController } from './orders.controller'
import { OrdersService } from './orders.service'

@Module({
	imports: [
		TypegooseModule.forFeature([
			{
				typegooseClass: Order,
				schemaOptions: {
					collection: 'Orders',
				},
			},
		]),
		forwardRef(() => AuthModule),
		forwardRef(() => ChangeHistoryModule),
		forwardRef(() => ProductsModule),
	],
	controllers: [OrdersController],
	providers: [OrdersService],
	exports: [OrdersService, TypegooseModule],
})
export class OrdersModule {}
