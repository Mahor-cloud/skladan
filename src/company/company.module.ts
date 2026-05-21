import { Module, forwardRef } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { TypegooseModule } from 'nestjs-typegoose'
import { AuthModule } from '../auth/auth.module'
import { UserModel } from '../auth/user.model'
import { getJwtConfig } from '../configs/jwt.config'
import { Role } from '../roles/role.model'
import { SeedsModule } from '../seeds/seeds.module'
import { Company } from './company.model'
import { CompanyController } from './company.controller'
import { CompanyService } from './company.service'

@Module({
	imports: [
		TypegooseModule.forFeature([Company, UserModel, Role]),
		ConfigModule,
		JwtModule.registerAsync({
			imports: [ConfigModule],
			inject: [ConfigService],
			useFactory: getJwtConfig,
		}),
		forwardRef(() => AuthModule),
		forwardRef(() => SeedsModule),
	],
	controllers: [CompanyController],
	providers: [CompanyService],
	exports: [CompanyService, TypegooseModule],
})
export class CompanyModule {}
