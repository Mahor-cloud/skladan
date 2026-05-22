/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { forwardRef, Module } from '@nestjs/common'
import { TypegooseModule } from 'nestjs-typegoose'
import { AuthModule } from 'src/auth/auth.module'
import { ChangeHistoryModule } from 'src/change-history/change-history.module'
import { Inventory } from 'src/inventory/inventory.model'
import { OrdersModule } from 'src/orders/orders.module'
import { Role } from 'src/roles/role.model'
import { Product } from './product.model'
import { ProductsController } from './products.controller'
import { ProductsService } from './products.service'

@Module({
	imports: [
		TypegooseModule.forFeature([
			{
				typegooseClass: Product,
				schemaOptions: {
					collection: 'Products',
				},
			},
			{
				typegooseClass: Inventory,
				schemaOptions: {
					collection: 'Inventory',
				},
			},
		]),
		AuthModule,
		forwardRef(() => OrdersModule),
		forwardRef(() => ChangeHistoryModule),
	],
	controllers: [ProductsController],
	providers: [ProductsService, Role],
	exports: [ProductsService, TypegooseModule],
})
export class ProductsModule {}
