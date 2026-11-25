/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { Module } from '@nestjs/common'
import { TypegooseModule } from 'nestjs-typegoose'
import { AuthModule } from '../auth/auth.module'
import { ChangeHistoryModule } from '../change-history/change-history.module'
import { ProductsModule } from '../products/products.module'
import { PurchasesModule } from '../purchases/purchases.module'
import { SeedTemplate } from '../seeds/seed-template.model'
import { LitnaController } from './litna.controller'
import { LitnaAccount, LitnaOrder } from './litna.model'
import { LitnaService } from './litna.service'

@Module({
	// AuthModule — проверка входа и пользователи (кто платил); PurchasesModule — закупки и их штатные переходы
	// SeedTemplate — подсказка пар для товаров «Семян»
	imports: [
		TypegooseModule.forFeature([LitnaAccount, LitnaOrder, { typegooseClass: SeedTemplate, schemaOptions: { collection: 'SeedTemplate' } }]),
		AuthModule,
		PurchasesModule,
		ProductsModule,
		ChangeHistoryModule,
	],
	controllers: [LitnaController],
	providers: [LitnaService],
	// засев новой местности с сайта (src/company)
	exports: [LitnaService],
})
export class LitnaModule {}
