import { forwardRef, Module } from '@nestjs/common'
import { TypegooseModule } from 'nestjs-typegoose'
import { AuthModule } from 'src/auth/auth.module'
import { ChangeHistoryModule } from 'src/change-history/change-history.module'
import { Role } from './role.model'
import { RolesController } from './roles.controller'
import { RolesService } from './roles.service'

@Module({
	imports: [
		TypegooseModule.forFeature([
			{
				typegooseClass: Role,
				schemaOptions: {
					collection: 'Roles',
				},
			},
		]),
		forwardRef(() => AuthModule),
		forwardRef(() => ChangeHistoryModule),
	],
	controllers: [RolesController],
	providers: [RolesService],
	exports: [RolesService, TypegooseModule],
})
export class RolesModule {}
