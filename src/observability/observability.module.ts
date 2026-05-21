/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { Module } from '@nestjs/common'
import { APP_INTERCEPTOR } from '@nestjs/core'
import { TypegooseModule } from 'nestjs-typegoose'
import { ChangeHistoryModule } from '../change-history/change-history.module'
import { ActiveUsersService } from './active-users.service'
import { HttpMetricsInterceptor } from './http-metrics.interceptor'
import { MetricsRegistryService } from './metrics-registry.service'
import { ObservabilityController } from './observability.controller'
import { MetricSnapshot } from './snapshot.model'
import { SnapshotService } from './snapshot.service'

@Module({
	imports: [
		TypegooseModule.forFeature([MetricSnapshot]),


		ChangeHistoryModule,
	],
	controllers: [ObservabilityController],
	providers: [
		MetricsRegistryService,
		SnapshotService,
		ActiveUsersService,
		{
			provide: APP_INTERCEPTOR,
			useClass: HttpMetricsInterceptor,
		},
	],
	exports: [MetricsRegistryService, ActiveUsersService],
})
export class ObservabilityModule {}
