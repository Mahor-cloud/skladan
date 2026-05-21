/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common'

@Injectable()
export class SuperAdminGuard implements CanActivate {
	canActivate(context: ExecutionContext): boolean {
		const request = context.switchToHttp().getRequest<any>()
		const user = request?.user
		if (!user) throw new ForbiddenException('Не авторизован')
		if (!user.isSuperAdmin) {
			throw new ForbiddenException('Доступно только супер-администратору')
		}
		return true
	}
}
