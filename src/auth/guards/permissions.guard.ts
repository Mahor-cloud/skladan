import {
	CanActivate,
	ExecutionContext,
	ForbiddenException,
	Injectable,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { ModelType } from '@typegoose/typegoose/lib/types'
import { InjectModel } from 'nestjs-typegoose'
import { Role } from 'src/roles/role.model'
import { UserModel } from '../user.model'

@Injectable()
export class PermissionsGuard implements CanActivate {
	constructor(
		private reflector: Reflector,
		@InjectModel(Role) private readonly roleModel: ModelType<Role>
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const permissions = this.reflector.get<string[]>(
			'permissions',
			context.getHandler()
		)
		if (!permissions || permissions.length === 0) {
			return true
		}

		const request = context.switchToHttp().getRequest<{ user: UserModel }>()
		const user = request.user

		if (!user) {
			throw new ForbiddenException('Пользователь не найден.')
		}

		const userRole = await this.roleModel.findById(user.role).exec()
		if (!userRole) {
			throw new ForbiddenException('Роль пользователя не найдена.')
		}

		const hasPermission = permissions.some((permission) =>
			userRole.permissions.includes(permission)
		)

		if (!hasPermission) {
			throw new ForbiddenException(
				'У вас нету доступа для выполнения данного действия.'
			)
		}

		return hasPermission
	}
}
