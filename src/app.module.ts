import { Module, OnModuleInit } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { TypegooseModule } from 'nestjs-typegoose'
import { AuthModule } from './auth/auth.module'
import { ChangeHistoryModule } from './change-history/change-history.module'
import { getMongoDbConfig } from './configs/mongo.config'
import { DatabaseModule } from './database/database.module'
import { initializeDatabase } from './initialize'
import { InventoryModule } from './inventory/inventory.module'
import { OrdersModule } from './orders/orders.module'
import { ProductsModule } from './products/products.module'
import { PurchasesModule } from './purchases/purchases.module'
import { RolesModule } from './roles/roles.module'

@Module({
	imports: [
		ConfigModule.forRoot(),
		TypegooseModule.forRootAsync({
			imports: [ConfigModule],
			inject: [ConfigService],
			useFactory: getMongoDbConfig,
		}),
		AuthModule,
		ProductsModule,
		OrdersModule,
		PurchasesModule,
		InventoryModule,
		ChangeHistoryModule,
		RolesModule,
		DatabaseModule,
	],
})
export class AppModule implements OnModuleInit {
	constructor(private readonly configService: ConfigService) {}

	async onModuleInit() {
		await initializeDatabase(this.configService)
	}
}
