/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { forwardRef, Module } from '@nestjs/common'
import { TypegooseModule } from 'nestjs-typegoose'
import { AuthModule } from '../auth/auth.module'
import { ChangeHistoryModule } from '../change-history/change-history.module'
import { OrdersModule } from '../orders/orders.module'
import { ProductsModule } from '../products/products.module'
import { CabinetItem } from './cabinet-item.model'
import { CabinetController } from './cabinet.controller'
import { CabinetService } from './cabinet.service'

@Module({
	imports: [
		TypegooseModule.forFeature([
			{ typegooseClass: CabinetItem, schemaOptions: { collection: 'CabinetItems' } },
		]),
		forwardRef(() => AuthModule),
		forwardRef(() => OrdersModule),
		forwardRef(() => ProductsModule),
		forwardRef(() => ChangeHistoryModule),
	],
	controllers: [CabinetController],
	providers: [CabinetService],
	exports: [CabinetService],
})
export class CabinetModule {}
