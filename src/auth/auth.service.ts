import {
	BadRequestException,
	Injectable,
	UnauthorizedException,
} from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { ModelType } from '@typegoose/typegoose/lib/types'
import { compare, genSalt, hash } from 'bcryptjs'
import { InjectModel } from 'nestjs-typegoose'
import { ChangeHistoryService } from 'src/change-history/change-history.service'
import { authDto } from './dto/auth.dto'
import { CreateUserDto } from './dto/create-user.dto'
import { RefreshTokenDto } from './dto/refreshToken.dto'
import { UpdateUserDto } from './dto/update-user.dto'
import { UserModel } from './user.model'

@Injectable()
export class AuthService {
	constructor(
		@InjectModel(UserModel) private readonly UserModel: ModelType<UserModel>,
		private readonly jwtService: JwtService,
		private readonly changeHistoryService: ChangeHistoryService
	) {}

	async login(data: authDto) {
		const user = await this.validateUser(data)
		if (!user) {
			throw new BadRequestException('Пользователь не найден')
		}
		const tokens = await this.issueTokenPair(String(user._id))
		return {
			user: this.returnUserFields(user),
			...tokens,
		}
	}

	async validateUser(data: authDto): Promise<UserModel> {
		const user = await this.UserModel.findOne({ login: data.login }).populate({
			path: 'role',
		})
		if (!user) throw new UnauthorizedException('Пользователь не найден')

		const isValidPassword = await compare(data.password, user.password)
		if (!isValidPassword) throw new UnauthorizedException('Неверный пароль')

		return user
	}

	async getNewTokens({ refreshToken }: RefreshTokenDto) {
		if (!refreshToken)
			throw new UnauthorizedException('Пожалуйста, войдите в систему!')

		const result = await this.jwtService.verifyAsync(refreshToken)
		const user = await this.UserModel.findById(result._id)

		if (!result || user.refreshToken !== refreshToken)
			throw new UnauthorizedException('Токен не валиден!')
		const tokens = await this.issueTokenPair(String(user._id))

		return {
			user: this.returnUserFields(user),
			...tokens,
		}
	}

	async issueTokenPair(userId: string) {
		const data = { _id: userId }

		const refreshToken = await this.jwtService.signAsync(data, {
			expiresIn: '30d',
		})

		const accessToken = await this.jwtService.signAsync(data, {
			expiresIn: '7d',
		})
		await this.UserModel.updateOne(
			{ _id: userId },
			{ $set: { refreshToken: refreshToken } }
		)

		return { refreshToken, accessToken }
	}
	async createUser(user: CreateUserDto, currentUser: UserModel) {
		if (await this.UserModel.findOne({ login: user.login })) {
			throw new BadRequestException(
				'Пользователь с таким логином уже существует'
			)
		}

		const userData = { ...user }
		const salt = await genSalt(6)
		userData.password = await hash(user.password, salt)
		const createdUser = new this.UserModel(userData)
		await createdUser.save()
		await this.changeHistoryService.createChangeHistory({
			user: currentUser._id,
			changeType: 'user-created',
			description: `Пользователь ${createdUser.login} создан.`,
			changeDate: Date.now(),
		})
		return createdUser
	}

	async findAll() {
		const users = await this.UserModel.find({ deletedAt: null })
			.populate('role')
			.exec()
		const transformedUsers = users.map((user) => this.returnUserFields(user))
		return transformedUsers
	}

	async findOne(id: string): Promise<UserModel> {
		return (await this.UserModel.findById({ _id: id, deletedAt: null }))
			.populate('role')
			.then((user) => user)
	}

	async update(
		id: string,
		updateUserDto: UpdateUserDto,
		currentUser: UserModel
	): Promise<UserModel> {
		if (updateUserDto.password) {
			const salt = await genSalt(6)
			updateUserDto.password = await hash(updateUserDto.password, salt)
		}

		const oldUser = await this.UserModel.findById(id).exec()
		const updatedUser = await this.UserModel.findByIdAndUpdate(
			id,
			updateUserDto,
			{ new: true }
		).exec()
		const changes = this.getChanges(oldUser, updatedUser)
		await this.changeHistoryService.createChangeHistory({
			user: currentUser._id,
			changeType: 'user-updated',
			description: `Пользователь ${updatedUser.login} обновлен. Изменения: ${changes}`,
			changeDate: Date.now(),
		})
		return updatedUser
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
