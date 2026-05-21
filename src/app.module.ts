import { Module, OnModuleInit } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core'
import { ScheduleModule } from '@nestjs/schedule'
import { ThrottlerModule } from '@nestjs/throttler'
import { IpThrottlerGuard } from './common/throttler/ip-throttler.guard'
import { TypegooseModule } from 'nestjs-typegoose'
import { AuthModule } from './auth/auth.module'
import { CabinetModule } from './cabinet/cabinet.module'
import { ChangeHistoryModule } from './change-history/change-history.module'
import { CompanyModule } from './company/company.module'
import { getMongoDbConfig } from './configs/mongo.config'
import { CounterModule } from './common/counters/counter.module'
import { TenantContextInterceptor } from './common/tenant-context/tenant-context.interceptor'
import { TenantContextModule } from './common/tenant-context/tenant-context.module'
import { DatabaseModule } from './database/database.module'
import { HealthModule } from './health/health.module'
import { initializeDatabase } from './initialize'
import { InventoryModule } from './inventory/inventory.module'
import { ObservabilityModule } from './observability/observability.module'
import { OrdersModule } from './orders/orders.module'
import { ProductsModule } from './products/products.module'
import { PurchasesModule } from './purchases/purchases.module'
import { RolesModule } from './roles/roles.module'
import { SeedsModule } from './seeds/seeds.module'
import { StatisticsModule } from './statistics/statistics.module'

@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true }),
		TypegooseModule.forRootAsync({
			imports: [ConfigModule],
			inject: [ConfigService],
			useFactory: getMongoDbConfig,
		}),
		ThrottlerModule.forRoot([
			{ name: 'default', ttl: 60_000, limit: 18000 },
		]),
		ScheduleModule.forRoot(),
		TenantContextModule,
		CounterModule,
		AuthModule,
		CompanyModule,
		ProductsModule,
		OrdersModule,
		PurchasesModule,
		InventoryModule,
		ChangeHistoryModule,
		RolesModule,
		DatabaseModule,
		CabinetModule,
		StatisticsModule,
		SeedsModule,
		HealthModule,
		ObservabilityModule,
	],
	providers: [
		{
			provide: APP_INTERCEPTOR,
			useClass: TenantContextInterceptor,
		},
		{
			provide: APP_GUARD,
			useClass: IpThrottlerGuard,
		},
	],
})
export class AppModule implements OnModuleInit {
	constructor(private readonly configService: ConfigService) {}

	async onModuleInit() {
		await initializeDatabase(this.configService)
	}
}
