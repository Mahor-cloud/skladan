/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { Body, Controller, Delete, Get, Param, Post, Put, UploadedFile, UseInterceptors, UsePipes } from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { Auth } from '../auth/decorators/auth.decorator'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { UserModel } from '../auth/user.model'
import { IdValidationPipe } from '../pipes/id.validation.pipe'
import { PHOTO_UPLOAD } from '../products/products.service'
import { CabinetService } from './cabinet.service'
import { CreateCabinetItemDto } from './dto/create-cabinet-item.dto'
import { UpdateCabinetItemDto } from './dto/update-cabinet-item.dto'

@Controller('cabinet')
export class CabinetController {
	constructor(private readonly cabinetService: CabinetService) {}

	@Get()
	@Auth('user', ['cabinet_access'])
	findAll(@CurrentUser() currentUser: UserModel) {
		return this.cabinetService.findAllForUser(currentUser)
	}

	@Get('merged')
	@Auth('user', ['cabinet_access'])
	listMerged(@CurrentUser() currentUser: UserModel) {
		return this.cabinetService.listMerged(currentUser)
	}

	@Get('all')
	@Auth('user', ['view_all_cabinets'])
	listAll() {
		return this.cabinetService.listAllForCompany()
	}

	@Get('summary')
	@Auth('user', ['view_cabinet_summary'])
	getSummary() {
		return this.cabinetService.getSummary()
	}

	@Get('orders-summary')
	@Auth('user', ['cabinet_access'])
	ordersSummary(@CurrentUser() currentUser: UserModel) {
		return this.cabinetService.getOrdersSummaryForUser(currentUser)
	}

	@Get('status')
	@Auth('user', ['cabinet_access'])
	getStatus(@CurrentUser() currentUser: UserModel) {
		return this.cabinetService.getStatus(currentUser)
	}

	@Post('init')
	@Auth('user', ['cabinet_access'])
	markInitialized(@CurrentUser() currentUser: UserModel) {
		return this.cabinetService.markInitialized(currentUser)
	}

	@Post()
	@Auth('user', ['cabinet_access'])
	create(@Body() dto: CreateCabinetItemDto, @CurrentUser() currentUser: UserModel) {
		return this.cabinetService.createOrUpsert(dto, currentUser)
	}

	@Put(':id')
	@Auth('user', ['cabinet_access'])
	@UsePipes(IdValidationPipe)
	update(@Param('id') id: string, @Body() dto: UpdateCabinetItemDto, @CurrentUser() currentUser: UserModel) {
		return this.cabinetService.update(id, dto, currentUser)
	}

	// Фото своей позиции: те же проверки и хранилище, что у товара; отдаётся тем же GET /products/photo/:token
	@Put(':id/photo')
	@Auth('user', ['cabinet_access'])
	@UsePipes(IdValidationPipe)
	@UseInterceptors(FileInterceptor('file', PHOTO_UPLOAD))
	setPhoto(@Param('id') id: string, @UploadedFile() file: Express.Multer.File, @CurrentUser() currentUser: UserModel) {
		return this.cabinetService.setPhoto(id, file?.buffer, currentUser)
	}

	@Delete(':id/photo')
	@Auth('user', ['cabinet_access'])
	@UsePipes(IdValidationPipe)
	removePhoto(@Param('id') id: string, @CurrentUser() currentUser: UserModel) {
		return this.cabinetService.removePhoto(id, currentUser)
	}

	@Delete(':id')
	@Auth('user', ['cabinet_access'])
	@UsePipes(IdValidationPipe)
	remove(@Param('id') id: string, @CurrentUser() currentUser: UserModel) {
		return this.cabinetService.softDelete(id, currentUser)
	}

	@Post('autofill')
	@Auth('user', ['cabinet_access'])
	autofill(@CurrentUser() currentUser: UserModel) {
		return this.cabinetService.computeAutofill(currentUser)
	}
}
