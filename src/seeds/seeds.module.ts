import { forwardRef, Module } from '@nestjs/common'
import { TypegooseModule } from 'nestjs-typegoose'
import { AuthModule } from '../auth/auth.module'
import { Product } from '../products/product.model'
import { Role } from '../roles/role.model'
import { SeedTemplate } from './seed-template.model'
import { SeedsController } from './seeds.controller'
import { SeedsService } from './seeds.service'

@Module({
	imports: [
		TypegooseModule.forFeature([
			{ typegooseClass: SeedTemplate, schemaOptions: { collection: 'SeedTemplate' } },
			{ typegooseClass: Role, schemaOptions: { collection: 'Roles' } },
			{ typegooseClass: Product, schemaOptions: { collection: 'Products' } },
		]),
		forwardRef(() => AuthModule),
	],
	controllers: [SeedsController],
	providers: [SeedsService],
	exports: [SeedsService, TypegooseModule],
})
export class SeedsModule {}
