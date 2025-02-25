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
import { IdValidationPipe } from 'src/pipes/id.validation.pipe'
import { AuthService } from './auth.service'
import { Auth } from './decorators/auth.decorator'
import { CurrentUser } from './decorators/current-user.decorator'
import { authDto } from './dto/auth.dto'
import { CreateUserDto } from './dto/create-user.dto'
import { RefreshTokenDto } from './dto/refreshToken.dto'
import { UpdateUserDto } from './dto/update-user.dto'
import { UserModel } from './user.model'

@Controller('auth')
export class AuthController {
	constructor(private readonly authService: AuthService) {}

	@HttpCode(200)
	@Post('login')
	async login(@Body() body: authDto) {
		return this.authService.login(body)
	}

	@HttpCode(200)
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
