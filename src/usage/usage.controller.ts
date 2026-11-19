/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import { Auth } from '../auth/decorators/auth.decorator'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { SuperAdminAuth } from '../auth/decorators/super-admin-auth.decorator'
import { UsageBatchDto, UsageQueryDto } from './dto/usage.dto'
import { UsageService } from './usage.service'

@Controller('usage')
export class UsageController {
	constructor(private readonly usage: UsageService) {}

	/** Счётчики нажатий и времени на экранах от клиента: только прибавляет числа, ничего не возвращает. */
	// Клиент шлёт пачку раз в полминуты; предел — на адрес, с запасом на много пользователей за одним адресом
	@Throttle({ default: { limit: 600, ttl: 60_000 } })
	@Auth()
	@Post()
	@HttpCode(204)
	async record(
		@CurrentUser() user: any,
		@Body() dto: UsageBatchDto
	): Promise<void> {
		await this.usage.record(user, dto)
	}

	@SuperAdminAuth()
	@Get()
	summary(@Query() query: UsageQueryDto) {
		return this.usage.summary(query)
	}
}
