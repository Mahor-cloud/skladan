import {
	Body,
	Controller,
	Delete,
	Get,
	Param,
	Post,
	Put,
	UsePipes,
} from '@nestjs/common'
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
			dto?.prefillFromStock === true
		)
	}

	@Get()
	@Auth('user', ['view_inventory'])
	findAll() {
		return this.inventoryService.findAll()
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
