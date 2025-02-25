import { forwardRef, Module } from '@nestjs/common'
import { TypegooseModule } from 'nestjs-typegoose'
import { AuthModule } from 'src/auth/auth.module'
import { ChangeHistoryModule } from 'src/change-history/change-history.module'
import { ProductsModule } from 'src/products/products.module'
import { InventoryController } from './inventory.controller'
import { Inventory } from './inventory.model'
import { InventoryService } from './inventory.service'

@Module({
	imports: [
		TypegooseModule.forFeature([
			{
				typegooseClass: Inventory,
				schemaOptions: {
					collection: 'Inventory',
				},
			},
		]),
		AuthModule,
		ProductsModule,
		forwardRef(() => ChangeHistoryModule),
	],
	controllers: [InventoryController],
	providers: [InventoryService],
	exports: [InventoryService, TypegooseModule],
})
export class InventoryModule {}
