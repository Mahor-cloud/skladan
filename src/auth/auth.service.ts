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
	HttpException,
	HttpStatus,
} from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { ModelType } from '@typegoose/typegoose/lib/types'
import { compare, genSalt, hash } from 'bcryptjs'
import { createHash } from 'crypto'
import { InjectModel } from 'nestjs-typegoose'
import { ChangeHistoryService } from 'src/change-history/change-history.service'
import { Company } from 'src/company/company.model'
import { Role } from 'src/roles/role.model'
import { authDto } from './dto/auth.dto'
import { CreateUserDto } from './dto/create-user.dto'
import { RefreshTokenDto } from './dto/refreshToken.dto'
import { UpdateUserDto } from './dto/update-user.dto'
import { UserModel } from './user.model'

// Подбор пароля. Два счёта неудачных входов, оба в памяти процесса (сервер один):
//  — «логин + адрес»: после пяти неудач подряд пауза минута, с каждой следующей вдвое дольше, до 15 минут;
//  — «логин» с любых адресов: после тридцати неудач пауза 15 минут — на случай подбора с многих адресов.
// Счёт по адресу не даёт постороннему закрыть вход настоящему владельцу логина пятью попытками.
// Удачный вход и сброс пароля счёт обнуляют; через час без неудач он забывается сам.
const LOGIN_FREE_TRIES = 5
const LOGIN_FREE_TRIES_ANY_IP = 30
const LOGIN_FORGET_MS = 60 * 60_000
export const loginLockMs = (fails: number) =>
	fails < LOGIN_FREE_TRIES ? 0 : Math.min(60_000 * 2 ** (fails - LOGIN_FREE_TRIES), 15 * 60_000)
const loginLockAnyIpMs = (fails: number) => (fails < LOGIN_FREE_TRIES_ANY_IP ? 0 : 15 * 60_000)
// Ключи счётов — JSON: логин с любыми знаками не совпадёт с чужой парой «логин + адрес»
const loginKey = (login: string) => JSON.stringify([login.toLowerCase()])
const pairKey = (login: string, ip: string) => JSON.stringify([login.toLowerCase(), ip])

@Injectable()
export class AuthService {
	constructor(
		@InjectModel(UserModel) private readonly UserModel: ModelType<UserModel>,
		@InjectModel(Company) private readonly companyModel: ModelType<Company>,
		private readonly jwtService: JwtService,
		private readonly changeHistoryService: ChangeHistoryService,
		@InjectModel(Role) private readonly roleModel: ModelType<Role>
	) {}

	private async isSystemRole(role: any): Promise<boolean> {
		return role ? !!(await this.roleModel.exists({ _id: role, isSystem: true }).exec()) : false
	}

	// Системную роль и её владельцев меняет только председатель или супер-админ:
	// иначе служащий с правом править пользователей назначил бы председателем себя или сменил председателю пароль
	private async guardSystem(currentUser: UserModel, ...roles: any[]) {
		if ((currentUser as any).isSuperAdmin || (currentUser.role as any)?.isSystem === true) return
		for (const role of roles) {
			if (await this.isSystemRole(role)) throw new ForbiddenException('Пользователя с системной ролью меняет только председатель')
		}
	}

	private readonly loginFails = new Map<string, { n: number; until: number; last: number }>()

	// Попытка учитывается ДО проверки пароля: иначе пачка одновременных запросов прошла бы проверку с одним и тем же счётом.
	// Возвращает откат учёта — для попытки, которая оказалась не подбором.
	private countLoginTry(key: string, lockMs: (fails: number) => number): () => void {
		const now = Date.now()
		let entry = this.loginFails.get(key)
		if (entry && now - entry.last > LOGIN_FORGET_MS) entry = undefined
		if (entry && entry.until > now) {
			const minutes = Math.ceil((entry.until - now) / 60_000)
			throw new HttpException(`Слишком много неудачных попыток входа. Повторите через ${minutes} мин.`, HttpStatus.TOO_MANY_REQUESTS)
		}
		const n = (entry?.n || 0) + 1
		this.loginFails.set(key, { n, until: now + lockMs(n), last: now })
		return () => (entry ? this.loginFails.set(key, entry) : this.loginFails.delete(key))
	}

	forgetLoginFails(login: string) {
		const key = loginKey(login)
		const pairs = key.slice(0, -1) + ','
		for (const k of this.loginFails.keys()) if (k === key || k.startsWith(pairs)) this.loginFails.delete(k)
	}

	async login(data: authDto, ip = '') {
		const login = String(data.login).toLowerCase()
		if (this.loginFails.size > 10_000) {
			const now = Date.now()
			for (const [k, v] of this.loginFails) if (v.until < now && now - v.last > LOGIN_FORGET_MS) this.loginFails.delete(k)
		}
		const undo = [this.countLoginTry(pairKey(login, ip), loginLockMs)]
		try {
			undo.push(this.countLoginTry(loginKey(login), loginLockAnyIpMs))
		} catch (e) {
			// логин закрыт для всех адресов — эта попытка в счёт своего адреса не идёт
			undo[0]()
			throw e
		}
		let user: UserModel
		try {
			user = await this.validateUser(data)
		} catch (e) {
			// подбором считается только неверная пара логин-пароль (несуществующий логин — так же, чтобы ответ его не выдавал)
			if (!(e instanceof UnauthorizedException && e.message === 'Неверный логин или пароль')) undo.forEach((back) => back())
			throw e
		}
		this.forgetLoginFails(login)
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
			user: await this.withCompanyName(this.returnUserFields(user), user),
			...tokens,
		}
	}

	// Название местности — только во входе, обновлении токенов и /auth/me, без запроса на каждый защищённый вызов
	private async withCompanyName<T>(fields: T, user: UserModel): Promise<T & { companyName?: string }> {
		if (user.isSuperAdmin || !user.company) return fields
		const company = await this.companyModel
			.findById(user.company)
			.select('name')
			.setOptions({ skipTenantScope: true } as any)
			.lean()
			.exec()
		return company ? { ...fields, companyName: company.name } : fields
	}

	async me(id: string) {
		const user = await this.findOne(id)
		return this.withCompanyName((user as any).toJSON(), user)
	}

	async validateUser(data: authDto): Promise<UserModel> {
		const user = await this.UserModel.findOne({ login: data.login })
			.setOptions({ skipTenantScope: true } as any)
			.populate({ path: 'role' })
		// Без пароля — пользователь из дампа, которого не было в базе: войдёт, когда админ задаст новый пароль
		if (!user?.password) throw new UnauthorizedException('Неверный логин или пароль')

		const isValidPassword = await compare(data.password, user.password)
		if (!isValidPassword) throw new UnauthorizedException('Неверный логин или пароль')
		// После проверки пароля: без него не раскрываем, что такой логин был; текст — как у JwtStrategy
		if (user.deletedAt) throw new UnauthorizedException('Пользователь деактивирован')

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

		// негодный или просроченный ключ — это 401 (клиент по нему выходит), а не ошибка сервера
		const result = await this.jwtService.verifyAsync(refreshToken).catch(() => {
			throw new UnauthorizedException('Токен не валиден!')
		})
		const user = await this.UserModel.findById(result._id)
			.setOptions({ skipTenantScope: true } as any)
			.populate('role')

		if (!result || !user || !user.refreshToken) {
			throw new UnauthorizedException('Токен не валиден!')
		}
		// Удалённому — как отозванной сессии: клиент по этому ответу показывает «Сессия завершена»
		if (user.deletedAt) throw new UnauthorizedException('SESSION_SUPERSEDED')
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
			user: await this.withCompanyName(this.returnUserFields(user), user),
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

		// typ отличает ключ обновления от ключа доступа: 30-дневный ключ не должен работать как ключ доступа (JwtStrategy)
		const refreshToken = await this.jwtService.signAsync({ ...data, typ: 'refresh' }, {
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
		await this.guardSystem(currentUser, user.role)
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
		await this.guardSystem(currentUser, oldUser.role, updateUserDto.role)
		// Чужой пароль сменили — прежние сессии этого пользователя завершаются (свою правку не трогаем: иначе выбросило бы самого),
		// а счёт неудачных входов по его логину обнуляется
		const update: any = { $set: updateUserDto }
		if (updateUserDto.password && String(oldUser._id) !== String(currentUser._id)) {
			;(updateUserDto as any).refreshToken = null
			update.$inc = { tokenVersion: 1 }
		}

		if (updateUserDto.login && updateUserDto.login !== oldUser.login) {
			const taken = await this.UserModel.findOne({ login: updateUserDto.login })
				.setOptions({ skipTenantScope: true } as any)
			if (taken && String(taken._id) !== String(oldUser._id)) {
				throw new BadRequestException(`Логин «${updateUserDto.login}» уже занят.`)
			}
		}

		if (updateUserDto.isAdmin !== undefined && updateUserDto.isAdmin !== oldUser.isAdmin && !(currentUser as any).isSuperAdmin) {
			if ((currentUser.role as any)?.isSystem !== true) {
				throw new ForbiddenException('Менять «Служащий» может председатель')
			}
			// без галочки председатель (и сам, и второй) не попал бы обратно в пользователей (AdminGuard) и не вернул бы её
			if (updateUserDto.isAdmin === false && (await this.isSystemRole(oldUser.role))) {
				throw new BadRequestException('У председателя галочку «Служащий» снять нельзя')
			}
		}
		delete (updateUserDto as any).isSuperAdmin

		const updatedUser = await this.UserModel.findByIdAndUpdate(
			id,
			update,
			{ new: true }
		).exec()
		if (!updatedUser) throw new NotFoundException('Пользователь не найден')
		if (update.$inc) this.forgetLoginFails(oldUser.login)
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
		// Прежние сессии завершаются: новая пара ключей ниже — уже с новым номером, её получает только этот клиент
		user.tokenVersion = (user.tokenVersion || 0) + 1
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

	/**
	 * Выход по ключу обновления: сервер забывает его и гасит выданные ключи доступа. По ключу доступа было бы ненадёжно —
	 * он живёт час, и выход после простоя до сервера бы не доходил. Хэш ключа в условии: вытесненная сессия
	 * (её ключ уже заменён) никого не выбивает.
	 */
	async logout({ refreshToken }: RefreshTokenDto) {
		const payload = await this.jwtService.verifyAsync(refreshToken).catch(() => null)
		if (payload?._id) {
			await this.UserModel.updateOne(
				{ _id: payload._id, refreshToken: createHash('sha256').update(refreshToken).digest('hex') },
				{ $unset: { refreshToken: 1 }, $inc: { tokenVersion: 1 } }
			)
				.setOptions({ skipTenantScope: true } as any)
				.exec()
		}
		return { ok: true }
	}

	async remove(id: string, currentUser: UserModel) {
		await this.guardSystem(currentUser, (await this.UserModel.findById(id).exec())?.role)
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
		// Без хэшей пароля и refresh-токена, как ответ правки пользователя
		return this.returnUserFields(removedUser)
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
		if (String(oldUser.role) !== String(newUser.role)) {
			changes.push(`Роль изменена`)
		}
		if (oldUser.isAdmin !== newUser.isAdmin) {
			changes.push(
				oldUser.isAdmin
					? 'Пользователь больше не служащий'
					: 'Пользователь стал служащим'
			)
		}
		return changes.join(', ')
	}
}
