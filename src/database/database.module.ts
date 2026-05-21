/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { forwardRef, Module } from '@nestjs/common'
import { TypegooseModule } from 'nestjs-typegoose'
import { AuthModule } from 'src/auth/auth.module'
import { UserModel } from 'src/auth/user.model'
import { ChangeHistory } from 'src/change-history/change-history.model'
import { ChangeHistoryModule } from 'src/change-history/change-history.module'
import { SubscriptionModel } from 'src/change-history/subscription.model'
import { Counter } from 'src/common/counters/counter.model'
import { Company } from 'src/company/company.model'
import { Inventory } from 'src/inventory/inventory.model'
import { Order } from 'src/orders/order.model'
import { Product } from 'src/products/product.model'
import { Purchase } from 'src/purchases/purchase.model'
import { Role } from 'src/roles/role.model'
import { DatabaseController } from './database.controller'
import { DatabaseService } from './database.service'
import { Message } from './messages.model'

@Module({
	imports: [
		TypegooseModule.forFeature([
			{ typegooseClass: Message, schemaOptions: { collection: 'Message' } },
			{ typegooseClass: Inventory, schemaOptions: { collection: 'Inventory' } },
			{ typegooseClass: Role, schemaOptions: { collection: 'Roles' } },
			{ typegooseClass: Purchase, schemaOptions: { collection: 'Purchases' } },
			{ typegooseClass: Product, schemaOptions: { collection: 'Products' } },
			{ typegooseClass: Order, schemaOptions: { collection: 'Orders' } },
			{ typegooseClass: UserModel, schemaOptions: { collection: 'Users' } },
			{
				typegooseClass: SubscriptionModel,
				schemaOptions: { collection: 'Subscriptions' },
			},
			{
				typegooseClass: ChangeHistory,
				schemaOptions: { collection: 'ChangeHistory' },
			},
			{ typegooseClass: Company, schemaOptions: { collection: 'Company' } },
			{ typegooseClass: Counter, schemaOptions: { collection: 'Counter' } },
		]),
		forwardRef(() => AuthModule),
		forwardRef(() => ChangeHistoryModule),
	],
	controllers: [DatabaseController],
	providers: [DatabaseService],
})
export class DatabaseModule {}
