/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { forwardRef, Module } from '@nestjs/common'
import { TypegooseModule } from 'nestjs-typegoose'
import { AuthModule } from 'src/auth/auth.module'
import { CabinetModule } from 'src/cabinet/cabinet.module'
import { ChangeHistoryModule } from 'src/change-history/change-history.module'
import { ProductsModule } from 'src/products/products.module'
import { Inventory } from 'src/inventory/inventory.model'
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
			{
				typegooseClass: Inventory,
				schemaOptions: {
					collection: 'Inventory',
				},
			},
		]),
		forwardRef(() => AuthModule),
		forwardRef(() => ChangeHistoryModule),
		forwardRef(() => ProductsModule),
		forwardRef(() => CabinetModule),
	],
	controllers: [OrdersController],
	providers: [OrdersService],
	exports: [OrdersService, TypegooseModule],
})
export class OrdersModule {}
