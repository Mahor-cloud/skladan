/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common'
import { Auth } from '../auth/decorators/auth.decorator'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { SuperAdminAuth } from '../auth/decorators/super-admin-auth.decorator'
import { IdValidationPipe } from '../pipes/id.validation.pipe'
import { FeedbackDeleteDto, FeedbackDto, FeedbackListDto, FeedbackReadDto } from './dto/feedback.dto'
import { FeedbackService } from './feedback.service'

@Controller('feedback')
export class FeedbackController {
	constructor(private readonly feedback: FeedbackService) {}

	/** Баги, пожелания, предложения: сохраняется в приложении, читает супер-админ. Пределы — в сервисе */
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
}
