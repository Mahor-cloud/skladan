/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { forwardRef, Module } from '@nestjs/common'
import { TypegooseModule } from 'nestjs-typegoose'
import { AuthModule } from 'src/auth/auth.module'
import { ChangeHistoryModule } from 'src/change-history/change-history.module'
import { Message } from 'src/database/messages.model'
import { Inventory } from 'src/inventory/inventory.model'
import { LitnaOrder } from 'src/litna/litna.model'
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
			{ typegooseClass: Message, schemaOptions: { collection: 'Message' } },
			// есть ли у закупки заказ на lit-na.ru: такую не удаляют и не оплачивают обычным путём
			LitnaOrder,
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
