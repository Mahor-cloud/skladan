import { BadRequestException, Injectable } from '@nestjs/common'
import { ModelType } from '@typegoose/typegoose/lib/types'
import { InjectModel } from 'nestjs-typegoose'
import { UserModel } from 'src/auth/user.model'
import { ChangeHistoryService } from 'src/change-history/change-history.service'
import { CreateRoleDto } from './dto/create-role.dto'
import { UpdateRoleDto } from './dto/update-role.dto'
import { Role } from './role.model'

@Injectable()
export class RolesService {
	constructor(
		@InjectModel(Role) private readonly roleModel: ModelType<Role>,
		@InjectModel(UserModel) private readonly userModel: ModelType<UserModel>,
		private readonly changeHistoryService: ChangeHistoryService
	) {}

	async createRole(
		createRoleDto: CreateRoleDto,
		currentUser: UserModel
	): Promise<Role> {
		const createdRole = new this.roleModel(createRoleDto)
		await createdRole.save()
		await this.changeHistoryService.createChangeHistory({
			user: currentUser._id,
			changeType: 'role-created',
			description: `Роль ${createdRole.name} создана.`,
			changeDate: Date.now(),
		})
		return createdRole
	}

	async findAll(): Promise<Role[]> {
		return this.roleModel.find().exec()
	}

	async findOne(id: string): Promise<Role> {
		return this.roleModel.findById(id).exec()
	}

	async update(
		id: string,
		updateRoleDto: UpdateRoleDto,
		currentUser: UserModel
	): Promise<Role> {
		const oldRole = await this.roleModel.findById(id).exec()
		const updatedRole = await this.roleModel
			.findByIdAndUpdate(id, updateRoleDto, { new: true })
			.exec()
		const changes = this.getChanges(oldRole, updatedRole)
		await this.changeHistoryService.createChangeHistory({
			user: currentUser._id,
			changeType: 'role-updated',
			description: `Роль ${updatedRole.name} обновлена. Изменения: ${changes}`,
			changeDate: Date.now(),
		})
		return updatedRole
	}

	async remove(id: string, currentUser: UserModel): Promise<Role> {
		const usersWithRole = await this.userModel.find({ role: id }).exec()
		if (usersWithRole.length > 0) {
			throw new BadRequestException(
				'Нельзя удалить роль, так как она используется.'
			)
		}

		const removedRole = await this.roleModel.findByIdAndDelete(id).exec()
		await this.changeHistoryService.createChangeHistory({
			user: currentUser._id,
			changeType: 'role-deleted',
			description: `Роль ${removedRole._id} удалена.`,
			changeDate: Date.now(),
		})
		return removedRole
	}

	private getChanges(oldRole: Role, newRole: Role): string {
		const changes = []
		if (oldRole.name !== newRole.name) {
			changes.push(`Название изменено с ${oldRole.name} на ${newRole.name}`)
		}
		if (
			JSON.stringify(oldRole.permissions) !==
			JSON.stringify(newRole.permissions)
		) {
			changes.push(`Права изменены на ${newRole.permissions.join(', ')}`)
		}
		return changes.join(', ')
	}
}
