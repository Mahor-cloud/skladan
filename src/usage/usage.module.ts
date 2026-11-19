/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { Module } from '@nestjs/common'
import { TypegooseModule } from 'nestjs-typegoose'
import { AuthModule } from '../auth/auth.module'
import { UsageController } from './usage.controller'
import { UsageMonth, UsageRole, UsageStat } from './usage.model'
import { UsageService } from './usage.service'

@Module({
	// AuthModule — проверка входа (JwtGuard и права) для адреса приёма
	imports: [
		TypegooseModule.forFeature([UsageStat, UsageMonth, UsageRole]),
		AuthModule,
	],
	controllers: [UsageController],
	providers: [UsageService],
})
export class UsageModule {}
