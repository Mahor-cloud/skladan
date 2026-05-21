/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import {
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	Param,
	Post,
	Put,
	UsePipes,
} from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import { IdValidationPipe } from 'src/pipes/id.validation.pipe'
import { AuthService } from './auth.service'
import { Auth } from './decorators/auth.decorator'
import { CurrentUser } from './decorators/current-user.decorator'
import { authDto } from './dto/auth.dto'
import { ChangeOwnPasswordDto } from './dto/change-own-password.dto'
import { CreateUserDto } from './dto/create-user.dto'
import { RefreshTokenDto } from './dto/refreshToken.dto'
import { UpdateUserDto } from './dto/update-user.dto'
import { UserModel } from './user.model'

@Controller('auth')
export class AuthController {
	constructor(private readonly authService: AuthService) {}

	@HttpCode(200)
	@Throttle({ default: { limit: 300, ttl: 60_000 } })
	@Post('login')
	async login(@Body() body: authDto) {
		return this.authService.login(body)
	}

	@HttpCode(200)

	@Throttle({ default: { limit: 10, ttl: 60_000 } })
	@Post('login/access-token')
	async getNewTokens(@Body() dto: RefreshTokenDto) {
		return this.authService.getNewTokens(dto)
	}

	@HttpCode(200)
	@Auth('user', ['view_users'])
	@Get('users')
	async findAll() {
		return this.authService.findAll()
	}

	@HttpCode(200)
	@Auth('user', [])
	@Put('me/password')
	async changeOwnPassword(
		@Body() body: ChangeOwnPasswordDto,
		@CurrentUser() currentUser: UserModel
	) {
		return this.authService.changeOwnPassword(currentUser, body.currentPassword, body.newPassword)
	}

	@HttpCode(200)
	@Auth('user', [])
	@Get('me')
	async me(@CurrentUser() currentUser: UserModel) {
		return this.authService.findOne(String(currentUser._id))
	}

	@HttpCode(200)
	@Auth('user', ['view_users'])
	@Get('user/:id')
	@UsePipes(IdValidationPipe)
	async findOne(@Param('id') id: string) {
		return this.authService.findOne(id)
	}

	@Auth('admin', ['create_users'])
	@HttpCode(201)
	@Post('create')
	async create(
		@Body() user: CreateUserDto,
		@CurrentUser() currentUser: UserModel
	) {
		return this.authService.createUser(user, currentUser)
	}

	@HttpCode(201)
	@Auth('admin', ['edit_users'])
	@Put(':id')
	@UsePipes(IdValidationPipe)
	async update(
		@Param('id') id: string,
		@Body() updateUserDto: UpdateUserDto,
		@CurrentUser() currentUser: UserModel
	) {
		return this.authService.update(id, updateUserDto, currentUser)
	}

	@HttpCode(201)
	@Auth('admin', ['delete_users'])
	@Delete(':id')
	@UsePipes(IdValidationPipe)
	async remove(@Param('id') id: string, @CurrentUser() currentUser: UserModel) {
		return this.authService.remove(id, currentUser)
	}
}
