import { forwardRef, Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { TypegooseModule } from 'nestjs-typegoose'
import { AuthModule } from 'src/auth/auth.module'
import { ChangeHistoryController } from './change-history.controller'
import { ChangeHistory } from './change-history.model'
import { ChangeHistoryService } from './change-history.service'
import { SubscriptionModel } from './subscription.model'

@Module({
	imports: [
		ConfigModule,
		TypegooseModule.forFeature([
			{
				typegooseClass: ChangeHistory,
				schemaOptions: {
					collection: 'ChangeHistory',
				},
			},
			{
				typegooseClass: SubscriptionModel,
				schemaOptions: {
					collection: 'Subscriptions',
				},
			},
		]),
		forwardRef(() => AuthModule),
	],
	controllers: [ChangeHistoryController],
	providers: [ChangeHistoryService],
	exports: [ChangeHistoryService],
})
export class ChangeHistoryModule {}
