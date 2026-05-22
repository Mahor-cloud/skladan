/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { Injectable, UnauthorizedException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PassportStrategy } from '@nestjs/passport'
import { ModelType } from '@typegoose/typegoose/lib/types'
import { InjectModel } from 'nestjs-typegoose'
import { ExtractJwt, Strategy } from 'passport-jwt'
import { Company } from '../../company/company.model'
import { UserModel } from '../user.model'

interface JwtPayload {
	_id: string
	company?: string | null
	isSuperAdmin?: boolean
	login?: string
	tokenVersion?: number
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
	constructor(
		private readonly configService: ConfigService,
		@InjectModel(UserModel) private readonly UserModel: ModelType<UserModel>,
		@InjectModel(Company) private readonly companyModel: ModelType<Company>
	) {
		super({
			jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
			ignoreExpiration: false,
			secretOrKey: configService.get('JWT_SECRET'),
		})
	}

	async validate(payload: JwtPayload) {
		const user = await this.UserModel.findById(payload._id)
			.setOptions({ skipTenantScope: true } as any)
			.populate('role')
			.exec()
		if (!user) throw new UnauthorizedException('Пользователь не найден')
		if (user.deletedAt) throw new UnauthorizedException('Пользователь деактивирован')

		if (!user.isSuperAdmin) {
			if ((payload.tokenVersion || 0) !== (user.tokenVersion || 0)) {
				throw new UnauthorizedException('SESSION_SUPERSEDED')
			}
			if (user.company) {
				const company = await this.companyModel
					.findById(user.company)
					.setOptions({ skipTenantScope: true } as any)
					.exec()
				if (!company || company.deletedAt) {
					throw new UnauthorizedException('COMPANY_REMOVED')
				}
				if (company.isActive === false) {
					throw new UnauthorizedException('COMPANY_DISABLED')
				}
			}
		}

		;(user as any).isSuperAdmin = !!user.isSuperAdmin
		;(user as any).company = user.company ?? null
		return user
	}
}
