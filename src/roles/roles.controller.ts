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
import { CreateRoleDto } from './dto/create-role.dto'
import { UpdateRoleDto } from './dto/update-role.dto'
import { RolesService } from './roles.service'

@Controller('roles')
export class RolesController {
	constructor(private readonly rolesService: RolesService) {}

	@Post()
	@Auth('admin', ['create_role'])
	create(
		@Body() createRoleDto: CreateRoleDto,
		@CurrentUser() currentUser: UserModel
	) {
		return this.rolesService.createRole(createRoleDto, currentUser)
	}

	@Get()
	@Auth('user', ['view_roles'])
	findAll() {
		return this.rolesService.findAll()
	}

	@Get(':id')
	@Auth('user', ['view_roles'])
	@UsePipes(IdValidationPipe)
	findOne(@Param('id') id: string) {
		return this.rolesService.findOne(id)
	}

	@Put(':id')
	@Auth('admin', ['edit_roles'])
	@UsePipes(IdValidationPipe)
	update(
		@Param('id') id: string,
		@Body() updateRoleDto: UpdateRoleDto,
		@CurrentUser() currentUser: UserModel
	) {
		return this.rolesService.update(id, updateRoleDto, currentUser)
	}

	@Delete(':id')
	@Auth('admin', ['delete_roles'])
	@UsePipes(IdValidationPipe)
	remove(@Param('id') id: string, @CurrentUser() currentUser: UserModel) {
		return this.rolesService.remove(id, currentUser)
	}
}
