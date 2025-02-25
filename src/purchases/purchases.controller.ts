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
import { UpdatePurchaseDto } from './dto/update-purchase.dto'
import { PurchasesService } from './purchases.service'

@Controller('purchases')
export class PurchasesController {
	constructor(private readonly purchasesService: PurchasesService) {}

	@Post()
	@Auth('admin', ['create_purchases'])
	create(@CurrentUser() currentUser: UserModel) {
		return this.purchasesService.createPurchase(currentUser)
	}

	@Get()
	@Auth('user', ['view_purchases'])
	findAll() {
		return this.purchasesService.findAll()
	}

	@Get(':id')
	@Auth('user', ['view_purchases'])
	@UsePipes(IdValidationPipe)
	findOne(@Param('id') id: string) {
		return this.purchasesService.findOne(id)
	}

	@Put(':id')
	@Auth('admin', ['edit_purchases'])
	@UsePipes(IdValidationPipe)
	update(
		@Param('id') id: string,
		@Body() updatePurchaseDto: UpdatePurchaseDto,
		@CurrentUser() currentUser: UserModel
	) {
		return this.purchasesService.update(id, updatePurchaseDto, currentUser)
	}

	@Delete(':id')
	@Auth('admin', ['delete_purchases'])
	@UsePipes(IdValidationPipe)
	remove(@Param('id') id: string, @CurrentUser() currentUser: UserModel) {
		return this.purchasesService.remove(id, currentUser)
	}
}
