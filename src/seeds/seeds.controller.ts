import { Body, Controller, Get, Put } from '@nestjs/common'
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
	updateProductsSeeds(@Body() body: { products: any[] }) {
		return this.seedsService.updateProductsSeeds(body?.products || [])
	}
}
