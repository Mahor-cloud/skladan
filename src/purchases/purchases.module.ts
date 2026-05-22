/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { forwardRef, Module } from '@nestjs/common'
import { TypegooseModule } from 'nestjs-typegoose'
import { AuthModule } from 'src/auth/auth.module'
import { ChangeHistoryModule } from 'src/change-history/change-history.module'
import { Inventory } from 'src/inventory/inventory.model'
import { ProductsModule } from 'src/products/products.module'
import { Role } from 'src/roles/role.model'
import { Purchase } from './purchase.model'
import { PurchasesController } from './purchases.controller'
import { PurchasesService } from './purchases.service'

@Module({
	imports: [
		TypegooseModule.forFeature([
			{
				typegooseClass: Purchase,
				schemaOptions: {
					collection: 'Purchases',
				},
			},
			{
				typegooseClass: Role,
				schemaOptions: {
					collection: 'Roles',
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
		forwardRef(() => ChangeHistoryModule),
		forwardRef(() => ProductsModule),
	],
	controllers: [PurchasesController],
	providers: [PurchasesService],
	exports: [PurchasesService, TypegooseModule],
})
export class PurchasesModule {}
