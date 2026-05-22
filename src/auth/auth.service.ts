/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import {
	BadRequestException,
	ForbiddenException,
	Injectable,
	NotFoundException,
	UnauthorizedException,
} from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { ModelType } from '@typegoose/typegoose/lib/types'
import { compare, genSalt, hash } from 'bcryptjs'
import { createHash } from 'crypto'
import { InjectModel } from 'nestjs-typegoose'
import { ChangeHistoryService } from 'src/change-history/change-history.service'
import { Company } from 'src/company/company.model'
import { authDto } from './dto/auth.dto'
import { CreateUserDto } from './dto/create-user.dto'
import { RefreshTokenDto } from './dto/refreshToken.dto'
import { UpdateUserDto } from './dto/update-user.dto'
import { UserModel } from './user.model'

@Injectable()
export class AuthService {
	constructor(
		@InjectModel(UserModel) private readonly UserModel: ModelType<UserModel>,
		@InjectModel(Company) private readonly companyModel: ModelType<Company>,
		private readonly jwtService: JwtService,
		private readonly changeHistoryService: ChangeHistoryService
	) {}

	async login(data: authDto) {
		const user = await this.validateUser(data)
		if (!user) {

			throw new UnauthorizedException('Неверный логин или пароль')
		}
		if (!user.isSuperAdmin) {
			user.tokenVersion = (user.tokenVersion || 0) + 1
			await this.UserModel.updateOne(
				{ _id: user._id },
				{ $set: { tokenVersion: user.tokenVersion } }
			).setOptions({ skipTenantScope: true } as any)
		}
		const tokens = await this.issueTokenPair(user)
		return {
			user: this.returnUserFields(user),
			...tokens,
		}
	}

	async validateUser(data: authDto): Promise<UserModel> {
		const user = await this.UserModel.findOne({ login: data.login })
			.setOptions({ skipTenantScope: true } as any)
			.populate({ path: 'role' })
		if (!user) throw new UnauthorizedException('Неверный логин или пароль')

		const isValidPassword = await compare(data.password, user.password)
		if (!isValidPassword) throw new UnauthorizedException('Неверный логин или пароль')

		if (user.company && !user.isSuperAdmin) {
			const company = await this.companyModel
				.findById(user.company)
				.setOptions({ skipTenantScope: true } as any)
				.exec()
			if (!company || company.deletedAt) {
				throw new UnauthorizedException(
					'Компания удалена. Свяжитесь с супер-админом.'
				)
			}
			if (company.isActive === false) {
				throw new UnauthorizedException(
					'Компания деактивирована. Свяжитесь с супер-админом.'
				)
			}
		}

		return user
	}

	async getNewTokens({ refreshToken }: RefreshTokenDto) {
		if (!refreshToken)
			throw new UnauthorizedException('Пожалуйста, войдите в систему!')

		const result = await this.jwtService.verifyAsync(refreshToken)
		const user = await this.UserModel.findById(result._id)
			.setOptions({ skipTenantScope: true } as any)
			.populate('role')

		if (!result || !user || !user.refreshToken) {
			throw new UnauthorizedException('Токен не валиден!')
		}
		const incomingHash = createHash('sha256').update(refreshToken).digest('hex')
		if (incomingHash !== user.refreshToken) {
			throw new UnauthorizedException('SESSION_SUPERSEDED')
		}

		if (user.company && !user.isSuperAdmin) {
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

		const tokens = await this.issueTokenPair(user)

		return {
			user: this.returnUserFields(user),
			...tokens,
		}
	}

	async issueTokenPair(user: UserModel) {
		const data = {
			_id: String(user._id),
			company: user.company ? String(user.company) : null,
			isSuperAdmin: !!user.isSuperAdmin,
			login: user.login,
			tokenVersion: user.tokenVersion || 0,
		}

		const refreshToken = await this.jwtService.signAsync(data, {
			expiresIn: '30d',
		})

		const accessToken = await this.jwtService.signAsync(data, {
			expiresIn: '1h',
		})

		const refreshHash = createHash('sha256').update(refreshToken).digest('hex')
		await this.UserModel.updateOne(
			{ _id: user._id },
			{ $set: { refreshToken: refreshHash } }
		).setOptions({ skipTenantScope: true } as any)

		return { refreshToken, accessToken }
	}
	async createUser(user: CreateUserDto, currentUser: UserModel) {
		const loginTaken = await this.UserModel.findOne({ login: user.login })
			.setOptions({ skipTenantScope: true } as any)
		if (loginTaken) {
			throw new BadRequestException(`Логин «${user.login}» уже занят.`)
		}

		const userData = { ...user }
		const salt = await genSalt(12)
		userData.password = await hash(user.password, salt)
		const createdUser = new this.UserModel(userData)
		await createdUser.save()
		await this.changeHistoryService.createChangeHistory({
			user: currentUser._id,
			changeType: 'user-created',
			description: `Пользователь ${createdUser.login} создан.`,
			changeDate: Date.now(),
		})
		return this.returnUserFields(createdUser)
	}

	async findAll() {
		const users = await this.UserModel.find({ deletedAt: null })
			.select('-password -refreshToken')
			.populate('role')
			.exec()
		const transformedUsers = users.map((user) => this.returnUserFields(user))
		return transformedUsers
	}

	async findOne(id: string): Promise<UserModel> {
		const user = await this.UserModel.findById(id)
			.select('-password -refreshToken')
			.populate('role')
			.exec()
		if (!user || user.deletedAt) throw new NotFoundException('Пользователь не найден')
		return user
	}

	async update(
		id: string,
		updateUserDto: UpdateUserDto,
		currentUser: UserModel
	) {
		if (updateUserDto.password) {
			const salt = await genSalt(12)
			updateUserDto.password = await hash(updateUserDto.password, salt)
		}

		const oldUser = await this.UserModel.findById(id).exec()
		if (!oldUser) throw new NotFoundException('Пользователь не найден')

		if (updateUserDto.login && updateUserDto.login !== oldUser.login) {
			const taken = await this.UserModel.findOne({ login: updateUserDto.login })
				.setOptions({ skipTenantScope: true } as any)
			if (taken && String(taken._id) !== String(oldUser._id)) {
				throw new BadRequestException(`Логин «${updateUserDto.login}» уже занят.`)
			}
		}

		if (
			updateUserDto.isAdmin !== undefined &&
			updateUserDto.isAdmin !== oldUser.isAdmin &&
			!(currentUser as any).isSuperAdmin
		) {
			throw new ForbiddenException(
				'Изменять флаг isAdmin может только супер-админ'
			)
		}
		delete (updateUserDto as any).isSuperAdmin

		const updatedUser = await this.UserModel.findByIdAndUpdate(
			id,
			updateUserDto,
			{ new: true }
		).exec()
		if (!updatedUser) throw new NotFoundException('Пользователь не найден')
		const changes = this.getChanges(oldUser, updatedUser)
		await this.changeHistoryService.createChangeHistory({
			user: currentUser._id,
			changeType: 'user-updated',
			description: `Пользователь ${updatedUser.login} обновлен. Изменения: ${changes}`,
			changeDate: Date.now(),
		})
		return this.returnUserFields(updatedUser)
	}

	async changeOwnPassword(
		currentUser: UserModel,
		currentPassword: string,
		newPassword: string
	) {
		if (!currentPassword || !newPassword) {
			throw new BadRequestException('Укажите текущий и новый пароль')
		}
		if (newPassword.length < 4) {
			throw new BadRequestException('Новый пароль минимум 4 символа')
		}

		const user = await this.UserModel.findById(currentUser._id)
			.setOptions({ skipTenantScope: true } as any)
			.exec()
		if (!user) throw new NotFoundException('Пользователь не найден')
		if (!user.password) {
			throw new BadRequestException('У пользователя отсутствует пароль в БД')
		}
		const ok = await compare(currentPassword, user.password)
		if (!ok) throw new UnauthorizedException('Неверный текущий пароль')
		const salt = await genSalt(12)
		user.password = await hash(newPassword, salt)
		await user.save()

		const tokens = await this.issueTokenPair(user)

		if (user.company) {
			await this.changeHistoryService.createChangeHistory({
				user: user._id,
				changeType: 'user-updated',
				description: `Пользователь ${user.login} сменил собственный пароль.`,
				changeDate: Date.now(),
			})
		}
		return {
			ok: true,
			accessToken: tokens.accessToken,
			refreshToken: tokens.refreshToken,
		}
	}

	async remove(id: string, currentUser: UserModel): Promise<UserModel> {
		const removedUser = await this.UserModel.findByIdAndUpdate(
			id,
			{ deletedAt: Date.now() },
			{ new: true }
		).exec()
		await this.changeHistoryService.createChangeHistory({
			user: currentUser._id,
			changeType: 'user-deleted',
			description: `Пользователь ${removedUser.login} удален.`,
			changeDate: Date.now(),
		})
		return removedUser
	}

	returnUserFields(user: UserModel) {
		return {
			_id: user._id,
			login: user.login,
			role: user.role,
			isAdmin: user.isAdmin,
			isSuperAdmin: !!user.isSuperAdmin,
			company: user.company ?? null,
			name: user.name,
		}
	}

	private getChanges(oldUser: UserModel, newUser: UserModel): string {
		const changes = []
		if (oldUser.login !== newUser.login) {
			changes.push(`Логин изменен с ${oldUser.login} на ${newUser.login}`)
		}
		if (oldUser.role !== newUser.role) {
			changes.push(`Роль изменена`)
		}
		if (oldUser.isAdmin !== newUser.isAdmin) {
			changes.push(
				oldUser.isAdmin
					? 'Пользователь больше не является администратором'
					: 'Пользователь стал администратором'
			)
		}
		return changes.join(', ')
	}
}
