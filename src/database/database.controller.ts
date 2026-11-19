/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import {
	BadRequestException,
	Body,
	Controller,
	Get,
	Post,
	Put,
	Query,
	StreamableFile,
	UploadedFile,
	UseInterceptors,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { Throttle } from '@nestjs/throttler'
import { createReadStream } from 'fs'
import { Auth } from 'src/auth/decorators/auth.decorator'
import { CurrentUser } from 'src/auth/decorators/current-user.decorator'
import { SuperAdminAuth } from 'src/auth/decorators/super-admin-auth.decorator'
import { UserModel } from 'src/auth/user.model'
import { BackupService } from './backup.service'
import { DatabaseService } from './database.service'
import { InventoryOpenDocsDto, PaymentMessageDto, ReceivedMessageDto, TargetWarehouseValueDto } from './messages.dto'

@Controller('database')
export class DatabaseController {
	constructor(
		private readonly databaseService: DatabaseService,
		private readonly backupService: BackupService
	) {}

	@Auth('user', ['view-messages'])
	@Get('msg')
	async getMessages() {
		return this.databaseService.getMsgs()
	}

	@Auth('user', ['edit-payment-message'])
	@Put('msg/payment')
	async updatePaymentMessage(@Body() dto: PaymentMessageDto) {
		return this.databaseService.updatePaymentMessage(dto)
	}

	@Auth('user', ['edit-received-message'])
	@Put('msg/received')
	async updateReceivedMessage(@Body() dto: ReceivedMessageDto) {
		return this.databaseService.updateReceivedMessage(dto.receivedMessage)
	}

	@Auth('admin', ['edit-payment-message'])
	@Put('msg/target-warehouse-value')
	async updateTargetWarehouseValue(@Body() dto: TargetWarehouseValueDto) {
		return this.databaseService.updateTargetWarehouseValue(dto.targetWarehouseValue)
	}

	@Auth('admin')
	@Put('msg/inventory-open-docs')
	async updateInventoryOpenDocs(@Body() dto: InventoryOpenDocsDto, @CurrentUser() currentUser: UserModel) {
		return this.databaseService.updateInventoryOpenDocs(dto.allowInventoryWithOpenDocs, currentUser)
	}

	@Auth('admin', ['export-database'])
	@Get('export/company')
	async exportCompanyData() {
		return this.databaseService.exportCompanyData()
	}

	@Auth('admin', ['import-database'])
	@Post('import/company')
	@UseInterceptors(
		FileInterceptor('file', { limits: { fileSize: 50 * 1024 * 1024 } })
	)
	async importCompanyData(
		@UploadedFile() file: Express.Multer.File,
		@CurrentUser() currentUser: UserModel
	) {
		let data: any
		try {
			data = JSON.parse(file.buffer.toString())
		} catch {
			throw new BadRequestException('Загруженный файл не является валидным JSON')
		}
		const companyId = String((currentUser as any).company || currentUser.company)
		await this.databaseService.importCompanyData(companyId, data, currentUser)
		return { message: 'Данные компании успешно импортированы' }
	}

	@SuperAdminAuth()
	@Get('export')
	async exportFullData() {
		return this.databaseService.exportFullData()
	}

	@SuperAdminAuth()
	@Post('import')
	@UseInterceptors(
		FileInterceptor('file', { limits: { fileSize: 200 * 1024 * 1024 } })
	)
	async importFullData(
		@UploadedFile() file: Express.Multer.File,
		@Query('confirm') confirm: string,
		@CurrentUser() currentUser: UserModel
	) {
		let data: any
		try {
			data = JSON.parse(file.buffer.toString())
		} catch {
			throw new BadRequestException('Загруженный файл не является валидным JSON')
		}
		await this.databaseService.importFullData(data, confirm, currentUser)
		return { message: 'Полный дамп успешно импортирован' }
	}

	/** Последний полный бэкап, сделанный кнопкой: { name, size, at } или null. */
	@SuperAdminAuth()
	@Get('backup')
	async lastBackup() {
		return this.backupService.last()
	}

	/** Снять новый полный бэкап базы (прежние, сделанные этой кнопкой, удаляются) и отдать его файлом. */
	// Бэкап — тяжёлая операция: не чаще шести запросов в минуту с адреса; одновременно — только один (остальным 409)
	@Throttle({ default: { limit: 6, ttl: 60_000 } })
	@SuperAdminAuth()
	@Post('backup')
	async createBackup(): Promise<StreamableFile> {
		const { name, size, path } = await this.backupService.create()
		return new StreamableFile(createReadStream(path), { type: 'application/x-tar', disposition: `attachment; filename="${name}"`, length: size })
	}
}
