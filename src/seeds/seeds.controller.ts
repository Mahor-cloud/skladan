/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { Body, Controller, Get, Param, Put, Res, UploadedFile, UseInterceptors } from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import type { Response } from 'express'
import { SuperAdminAuth } from '../auth/decorators/super-admin-auth.decorator'
import { SeedsService } from './seeds.service'

@Controller('seeds')
export class SeedsController {
	constructor(private readonly seedsService: SeedsService) {}

	@Get()
	@SuperAdminAuth()
	getSeeds() {
		return this.seedsService.getSeeds()
	}

	@Put('roles')
	@SuperAdminAuth()
	updateRolesSeeds(@Body() body: { roles: any[] }) {
		return this.seedsService.updateRolesSeeds(body?.roles || [])
	}

	@Put('products')
	@SuperAdminAuth()
	updateProductsSeeds(@Body() body: { products: any[]; kindCovers?: any[] }) {
		return this.seedsService.updateProductsSeeds(body?.products || [], body?.kindCovers)
	}

	// Те же пределы и заголовки, что у фото товара (products.controller)
	@Put('photo')
	@SuperAdminAuth()
	@UseInterceptors(FileInterceptor('file', { limits: { fileSize: 512 * 1024 + 1, files: 1, fields: 0, parts: 2 } }))
	setPhoto(@UploadedFile() file: Express.Multer.File) {
		return this.seedsService.setPhoto(file?.buffer)
	}

	// Без авторизации: <img> не шлёт Authorization, ключ неугадываем
	@Get('photo/:token')
	async getPhoto(@Param('token') token: string, @Res() res: Response) {
		const photo = await this.seedsService.getPhoto(token)
		res.set({
			'Content-Type': photo.contentType,
			'Cache-Control': 'public, max-age=31536000, immutable',
			'X-Content-Type-Options': 'nosniff',
			'Content-Security-Policy': "default-src 'none'; sandbox",
		})
		res.send(photo.data)
	}
}
