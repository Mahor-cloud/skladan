import { forwardRef, Module } from '@nestjs/common'
import { ChangeHistoryModule } from '../change-history/change-history.module'
import { HealthController } from './health.controller'

@Module({
	imports: [forwardRef(() => ChangeHistoryModule)],
	controllers: [HealthController],
})
export class HealthModule {}
