/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import {
	Body,
	Controller,
	Delete,
	Get,
	Param,
	Post,
	Put,
	Res,
	UsePipes,
} from '@nestjs/common'
import type { Response } from 'express'
import { Auth } from 'src/auth/decorators/auth.decorator'
import { CurrentUser } from 'src/auth/decorators/current-user.decorator'
import { UserModel } from 'src/auth/user.model'
import { IdValidationPipe } from 'src/pipes/id.validation.pipe'
import { CreateInventoryDto } from './dto/create-inventory.dto'
import { UpdateInventoryDto } from './dto/update-inventory.dto'
import { InventoryService } from './inventory.service'

@Controller('inventory')
export class InventoryController {
	constructor(private readonly inventoryService: InventoryService) {}

	@Post()
	@Auth('user', ['create_inventory'])
	create(
		@Body() dto: CreateInventoryDto,
		@CurrentUser() currentUser: UserModel
	) {
		return this.inventoryService.createInventory(
			currentUser,
			dto?.prefillFromStock === true,
			dto?.confirmOpenDocs === true
		)
	}

	@Get()
	@Auth('user', ['view_inventory'])
	findAll() {
		return this.inventoryService.findAll()
	}

	// res.json: без него Nest отдал бы на null пустое тело, а клиенту нужен JSON null
	@Get('active')
	@Auth('user', ['view_inventory'])
	async findActive(@Res() res: Response) {
		res.json(await this.inventoryService.findActive())
	}

	@Get(':id')
	@Auth('user', ['view_inventory'])
	@UsePipes(IdValidationPipe)
	findOne(@Param('id') id: string) {
		return this.inventoryService.findOne(id)
	}

	@Put(':id')
	@Auth('user', ['edit_inventory'])
	@UsePipes(IdValidationPipe)
	update(
		@Param('id') id: string,
		@Body() updateInventoryDto: UpdateInventoryDto,
		@CurrentUser() currentUser: UserModel
	) {
		return this.inventoryService.update(id, updateInventoryDto, currentUser)
	}

	@Delete(':id')
	@Auth('user', ['delete_inventory'])
	@UsePipes(IdValidationPipe)
	delete(
		@Param('id') id: string,
		@CurrentUser() currentUser: UserModel,
		@Body() body?: { editReason?: string }
	) {
		return this.inventoryService.delete(id, currentUser, body?.editReason)
	}
}
