/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common'
import { Auth } from '../auth/decorators/auth.decorator'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { SuperAdminAuth } from '../auth/decorators/super-admin-auth.decorator'
import { IdValidationPipe } from '../pipes/id.validation.pipe'
import { FeedbackDeleteDto, FeedbackDto, FeedbackListDto, FeedbackReadDto, FeedbackSettingsDto } from './dto/feedback.dto'
import { FeedbackService } from './feedback.service'

@Controller('feedback')
export class FeedbackController {
	constructor(private readonly feedback: FeedbackService) {}

	/** Баги, пожелания, предложения: сохраняется в приложении, в Telegram — фоном, если он настроен. Пределы — в сервисе */
	@Auth()
	@Post()
	submit(@CurrentUser() user: any, @Body() dto: FeedbackDto) {
		return this.feedback.submit(user, dto.text)
	}

	@SuperAdminAuth()
	@Get()
	list(@Query() q: FeedbackListDto) {
		return this.feedback.list(q)
	}

	/** Лёгкий запрос для значка в меню */
	@SuperAdminAuth()
	@Get('unread')
	unread() {
		return this.feedback.unreadCount()
	}

	@SuperAdminAuth()
	@Post('read')
	read(@Body() dto: FeedbackReadDto) {
		return this.feedback.markRead(dto.ids)
	}

	@SuperAdminAuth()
	@Delete()
	removeAll(@Query() q: FeedbackDeleteDto) {
		return this.feedback.removeAll(q.read === '1')
	}

	@SuperAdminAuth()
	@Delete(':id')
	remove(@Param('id', IdValidationPipe) id: string) {
		return this.feedback.remove(id)
	}

	@SuperAdminAuth()
	@Get('settings')
	settings() {
		return this.feedback.settings()
	}

	@SuperAdminAuth()
	@Put('settings')
	saveSettings(@Body() dto: FeedbackSettingsDto) {
		return this.feedback.saveSettings(dto)
	}

	@SuperAdminAuth()
	@Post('settings/test')
	test() {
		return this.feedback.test()
	}
}
