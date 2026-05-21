import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common'
import { AdminGuard } from '../guards/admin.guard'
import { JwtGuard } from '../guards/jwt.guard'
import { PermissionsGuard } from '../guards/permissions.guard'

export const Auth = (role: string = 'user', permissions: string[] = []) =>
	applyDecorators(
		role === 'admin'
			? UseGuards(JwtGuard, AdminGuard, PermissionsGuard)
			: UseGuards(JwtGuard, PermissionsGuard),
		SetMetadata('permissions', permissions),
		SetMetadata('role', role)
	)
