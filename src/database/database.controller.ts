import {
	Body,
	Controller,
	Get,
	Post,
	Put,
	UploadedFile,
	UseInterceptors,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { Auth } from 'src/auth/decorators/auth.decorator'
import { DatabaseService } from './database.service'
import { MessagesDto } from './messages.dto'

@Controller('database')
export class DatabaseController {
	constructor(private readonly databaseService: DatabaseService) {}

	@Auth('admin', ['export-database'])
	@Get('export')
	async exportData() {
		return this.databaseService.exportData()
	}

	@Auth('admin', ['import-database'])
	@Post('import')
	@UseInterceptors(FileInterceptor('file'))
	async importData(@UploadedFile() file: Express.Multer.File) {
		const data = JSON.parse(file.buffer.toString())
		await this.databaseService.importData(data)
		return { message: 'Данные успешно импортированы' }
	}

	@Auth('user', [])
	@Get('msg')
	async getMessages() {
		return this.databaseService.getMsgs()
	}

	@Auth('user', [])
	@Put('msg')
	async updateMessages(@Body() messagesDto: MessagesDto) {
		return this.databaseService.updateMsgs(messagesDto)
	}
}
