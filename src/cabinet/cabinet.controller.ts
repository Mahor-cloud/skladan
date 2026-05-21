import { Body, Controller, Delete, Get, Param, Post, Put, UsePipes } from '@nestjs/common'
import { Auth } from '../auth/decorators/auth.decorator'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { UserModel } from '../auth/user.model'
import { IdValidationPipe } from '../pipes/id.validation.pipe'
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
