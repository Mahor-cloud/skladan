import { forwardRef, Module } from '@nestjs/common'
import { TypegooseModule } from 'nestjs-typegoose'
import { AuthModule } from 'src/auth/auth.module'
import { ChangeHistoryModule } from 'src/change-history/change-history.module'
import { ProductsModule } from 'src/products/products.module'
import { Purchase } from './purchase.model'
import { PurchasesController } from './purchases.controller'
import { PurchasesService } from './purchases.service'

@Module({
	imports: [
		TypegooseModule.forFeature([
			{
				typegooseClass: Purchase,
				schemaOptions: {
					collection: 'Purchases',
				},
			},
		]),
		AuthModule,
		forwardRef(() => ChangeHistoryModule),
		forwardRef(() => ProductsModule),
	],
	controllers: [PurchasesController],
	providers: [PurchasesService],
	exports: [PurchasesService, TypegooseModule],
})
export class PurchasesModule {}
