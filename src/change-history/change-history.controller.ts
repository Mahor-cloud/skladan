/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import {
	Body,
	Controller,
	Get,
	MessageEvent,
	Param,
	Post,
	Put,
	Query,
	Sse,
	UnauthorizedException,
	UsePipes,
} from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { Observable, of } from 'rxjs'
import { Auth } from 'src/auth/decorators/auth.decorator'
import { CurrentUser } from 'src/auth/decorators/current-user.decorator'
import { UserModel } from 'src/auth/user.model'
import { IdValidationPipe } from 'src/pipes/id.validation.pipe'
import { ChangeHistoryService } from './change-history.service'
import { CreateChangeHistoryDto } from './dto/create-change-history.dto'
import { RealtimeService } from './realtime.service'
import { SubscriptionDto, SubscriptionPreferencesDto } from './dto/subscription.dto'

@Controller('change-history')
export class ChangeHistoryController {
	constructor(
		private readonly changeHistoryService: ChangeHistoryService,
		private readonly realtime: RealtimeService,
		private readonly jwtService: JwtService
	) {}

	@Sse('stream')
	async stream(@Query('t') token: string): Promise<Observable<MessageEvent>> {
		let payload: any
		try {
			payload = await this.jwtService.verifyAsync(token)
		} catch {
			throw new UnauthorizedException('Невалидный токен SSE')
		}
		const company = payload?.company
		if (!company) {

			return of({ data: { type: 'noop' } } as MessageEvent)
		}
		return this.realtime.streamForCompany(String(company)) as Observable<MessageEvent>
	}

	@Auth('user')
	@Post('subscribe')
	async subscribeNotification(
		@Body() subscription: SubscriptionDto,
		@CurrentUser() currentUser: UserModel
	) {
		await this.changeHistoryService.subscribeNotification(
			subscription,
			currentUser
		)
		return { message: 'Notification register' }
	}


	@Auth('user')
	@Get('subscription/me')
	getMySubscription(@CurrentUser() currentUser: UserModel) {
		return this.changeHistoryService.getMySubscription(currentUser)
	}


	@Auth('user')
	@Put('subscription/preferences')
	updateMyPreferences(
		@CurrentUser() currentUser: UserModel,
		@Body() preferences: SubscriptionPreferencesDto
	) {
		return this.changeHistoryService.updateMyPreferences(currentUser, preferences)
	}

	@Auth('admin', ['create_change_history'])
	@Post()
	create(@Body() createChangeHistoryDto: CreateChangeHistoryDto) {
		return this.changeHistoryService.createChangeHistory(createChangeHistoryDto)
	}

	@Auth('user', ['view_change_history'])
	@Get()
	findAll(
		@Query('from') from?: string,
		@Query('to') to?: string,
		@Query('page') page?: string,
		@Query('limit') limit?: string
	) {
		return this.changeHistoryService.findAll({
			from: from ? Number(from) : undefined,
			to: to ? Number(to) : undefined,
			page: page ? Number(page) : 1,
			limit: limit ? Number(limit) : 50,
		})
	}

	@Auth('user', ['view_change_history'])
	@Get(':id')
	@UsePipes(IdValidationPipe)
	findOne(@Param('id') id: string) {
		return this.changeHistoryService.findOne(id)
	}
}
