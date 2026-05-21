/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { forwardRef, Module } from '@nestjs/common'
import { TypegooseModule } from 'nestjs-typegoose'
import { AuthModule } from 'src/auth/auth.module'
import { ChangeHistoryModule } from 'src/change-history/change-history.module'
import { Order } from 'src/orders/order.model'
import { ProductsModule } from 'src/products/products.module'
import { Purchase } from 'src/purchases/purchase.model'
import { InventoryController } from './inventory.controller'
import { Inventory } from './inventory.model'
import { InventoryService } from './inventory.service'

@Module({
	imports: [
		TypegooseModule.forFeature([
			{
				typegooseClass: Inventory,
				schemaOptions: {
					collection: 'Inventory',
				},
			},
			{
				typegooseClass: Order,
				schemaOptions: {
					collection: 'Orders',
				},
			},
			{
				typegooseClass: Purchase,
				schemaOptions: {
					collection: 'Purchases',
				},
			},
		]),
		AuthModule,
		ProductsModule,
		forwardRef(() => ChangeHistoryModule),
	],
	controllers: [InventoryController],
	providers: [InventoryService],
	exports: [InventoryService, TypegooseModule],
})
export class InventoryModule {}
