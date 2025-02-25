import { Body, Controller, Get, Param, Post, UsePipes } from '@nestjs/common'
import { Auth } from 'src/auth/decorators/auth.decorator'
import { CurrentUser } from 'src/auth/decorators/current-user.decorator'
import { UserModel } from 'src/auth/user.model'
import { IdValidationPipe } from 'src/pipes/id.validation.pipe'
import { ChangeHistoryService } from './change-history.service'
import { CreateChangeHistoryDto } from './dto/create-change-history.dto'
import { SubscriptionDto } from './dto/subscription.dto'

@Controller('change-history')
export class ChangeHistoryController {
	constructor(private readonly changeHistoryService: ChangeHistoryService) {}

	@Auth('user', ['view_change_history'])
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

	@Auth('admin', ['create_change_history'])
	@Post()
	create(@Body() createChangeHistoryDto: CreateChangeHistoryDto) {
		return this.changeHistoryService.createChangeHistory(createChangeHistoryDto)
	}

	@Auth('user', ['view_change_history'])
	@Get()
	findAll() {
		return this.changeHistoryService.findAll()
	}

	@Auth('user', ['view_change_history'])
	@Get(':id')
	@UsePipes(IdValidationPipe)
	findOne(@Param('id') id: string) {
		return this.changeHistoryService.findOne(id)
	}
}
