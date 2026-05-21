import { forwardRef, Module } from '@nestjs/common'
import { TypegooseModule } from 'nestjs-typegoose'
import { AuthModule } from '../auth/auth.module'
import { UserModel } from '../auth/user.model'
import { ChangeHistory } from '../change-history/change-history.model'
import { Inventory } from '../inventory/inventory.model'
import { Order } from '../orders/order.model'
import { Product } from '../products/product.model'
import { Purchase } from '../purchases/purchase.model'
import { StatisticsController } from './statistics.controller'
import { StatisticsService } from './statistics.service'

@Module({
	imports: [
		TypegooseModule.forFeature([
			{ typegooseClass: Order, schemaOptions: { collection: 'Orders' } },
			{ typegooseClass: Purchase, schemaOptions: { collection: 'Purchases' } },
			{ typegooseClass: Inventory, schemaOptions: { collection: 'Inventory' } },
			{ typegooseClass: Product, schemaOptions: { collection: 'Products' } },
			{ typegooseClass: ChangeHistory, schemaOptions: { collection: 'ChangeHistory' } },
			{ typegooseClass: UserModel, schemaOptions: { collection: 'Users' } },
		]),
		forwardRef(() => AuthModule),
	],
	controllers: [StatisticsController],
	providers: [StatisticsService],
	exports: [StatisticsService],
})
export class StatisticsModule {}
