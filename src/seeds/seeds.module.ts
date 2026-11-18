/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { forwardRef, Module } from '@nestjs/common'
import { TypegooseModule } from 'nestjs-typegoose'
import { AuthModule } from '../auth/auth.module'
import { Message } from '../database/messages.model'
import { ProductPhoto } from '../products/product-photo.model'
import { Product } from '../products/product.model'
import { Role } from '../roles/role.model'
import { SeedPhoto, SeedTemplate } from './seed-template.model'
import { SeedsController } from './seeds.controller'
import { SeedsService } from './seeds.service'

@Module({
	imports: [
		TypegooseModule.forFeature([
			{ typegooseClass: SeedTemplate, schemaOptions: { collection: 'SeedTemplate' } },
			{ typegooseClass: Role, schemaOptions: { collection: 'Roles' } },
			{ typegooseClass: Product, schemaOptions: { collection: 'Products' } },
			{ typegooseClass: SeedPhoto, schemaOptions: { collection: 'SeedPhotos' } },
			{ typegooseClass: ProductPhoto, schemaOptions: { collection: 'ProductPhotos' } },
			{ typegooseClass: Message, schemaOptions: { collection: 'Message' } },
		]),
		forwardRef(() => AuthModule),
	],
	controllers: [SeedsController],
	providers: [SeedsService],
	exports: [SeedsService, TypegooseModule],
})
export class SeedsModule {}
