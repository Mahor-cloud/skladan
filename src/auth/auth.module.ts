import { forwardRef, Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { JwtModule } from '@nestjs/jwt'
import { TypegooseModule } from 'nestjs-typegoose'
import { ChangeHistoryModule } from 'src/change-history/change-history.module'
import { getJwtConfig } from 'src/configs/jwt.config'
import { Role } from 'src/roles/role.model'
import { RolesModule } from 'src/roles/roles.module'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'
import { JwtStrategy } from './strategies/jwt.strategy'
import { UserModel } from './user.model'

@Module({
	imports: [
		ConfigModule,
		TypegooseModule.forFeature([
			{
				typegooseClass: UserModel,
				schemaOptions: {
					collection: 'Users',
				},
			},
			{
				typegooseClass: Role,
				schemaOptions: {
					collection: 'Roles',
				},
			},
		]),
		JwtModule.registerAsync({
			imports: [ConfigModule],
			inject: [ConfigService],
			useFactory: getJwtConfig,
		}),
		forwardRef(() => RolesModule),
		forwardRef(() => ChangeHistoryModule),
	],
	controllers: [AuthController],
	providers: [AuthService, JwtStrategy],
	exports: [AuthService, TypegooseModule],
})
export class AuthModule {}
