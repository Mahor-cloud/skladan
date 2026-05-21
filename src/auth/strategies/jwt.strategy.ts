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
import { UserModel } from '../user.model'

interface JwtPayload {
	_id: string
	company?: string | null
	isSuperAdmin?: boolean
	login?: string
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
	constructor(
		private readonly configService: ConfigService,
		@InjectModel(UserModel) private readonly UserModel: ModelType<UserModel>
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


		;(user as any).isSuperAdmin = !!user.isSuperAdmin
		;(user as any).company = user.company ?? null
		return user
	}
}
