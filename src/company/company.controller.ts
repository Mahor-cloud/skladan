/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { Body, Controller, Delete, Get, Param, Post, Put, UsePipes } from '@nestjs/common'
import { SuperAdminAuth } from '../auth/decorators/super-admin-auth.decorator'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { UserModel } from '../auth/user.model'
import { IdValidationPipe } from '../pipes/id.validation.pipe'
import { CompanyService } from './company.service'
import { ChangeAdminPasswordDto } from './dto/change-admin-password.dto'
import { CreateCompanyWithAdminDto } from './dto/create-company-with-admin.dto'
import { CreateCompanyDto } from './dto/create-company.dto'
import { UpdateCompanyDto } from './dto/update-company.dto'

@Controller('companies')
export class CompanyController {
	constructor(private readonly companyService: CompanyService) {}

	@Post()
	@SuperAdminAuth()
	create(@Body() dto: CreateCompanyDto, @CurrentUser() currentUser: UserModel) {
		return this.companyService.create(dto, currentUser)
	}

	@Post('with-admin')
	@SuperAdminAuth()
	createWithAdmin(@Body() dto: CreateCompanyWithAdminDto, @CurrentUser() currentUser: UserModel) {
		return this.companyService.createWithAdmin(dto, currentUser)
	}

	@Get()
	@SuperAdminAuth()
	findAll() {
		return this.companyService.findAll()
	}

	@Get(':id')
	@SuperAdminAuth()
	@UsePipes(IdValidationPipe)
	findOne(@Param('id') id: string) {
		return this.companyService.findOne(id)
	}

	@Get(':id/admins')
	@SuperAdminAuth()
	@UsePipes(IdValidationPipe)
	listAdmins(@Param('id') id: string) {
		return this.companyService.listAdmins(id)
	}

	@Get(':id/users')
	@SuperAdminAuth()
	@UsePipes(IdValidationPipe)
	listUsers(@Param('id') id: string) {
		return this.companyService.listUsers(id)
	}

	@Put(':id')
	@SuperAdminAuth()
	@UsePipes(IdValidationPipe)
	update(@Param('id') id: string, @Body() dto: UpdateCompanyDto) {
		return this.companyService.update(id, dto)
	}

	@Put('admin/:userId/password')
	@SuperAdminAuth()
	changeAdminPassword(@Param('userId') userId: string, @Body() dto: ChangeAdminPasswordDto) {
		return this.companyService.changeAdminPassword(userId, dto)
	}

	@Post('impersonate/:userId')
	@SuperAdminAuth()
	impersonate(@Param('userId') userId: string) {
		return this.companyService.impersonate(userId)
	}

	@Delete(':id')
	@SuperAdminAuth()
	@UsePipes(IdValidationPipe)
	deactivate(@Param('id') id: string) {
		return this.companyService.deactivate(id)
	}

	@Put(':id/activate')
	@SuperAdminAuth()
	@UsePipes(IdValidationPipe)
	activate(@Param('id') id: string) {
		return this.companyService.activate(id)
	}

	@Delete(':id/hard')
	@SuperAdminAuth()
	@UsePipes(IdValidationPipe)
	hardDelete(@Param('id') id: string, @Body() body?: { confirm?: string }) {
		return this.companyService.hardDelete(id, body?.confirm)
	}
}
