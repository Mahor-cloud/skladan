/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { forwardRef, Module } from '@nestjs/common'
import { ChangeHistoryModule } from '../change-history/change-history.module'
import { HealthController } from './health.controller'

@Module({
	imports: [forwardRef(() => ChangeHistoryModule)],
	controllers: [HealthController],
})
export class HealthModule {}
