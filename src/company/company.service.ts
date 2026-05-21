/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { BadRequestException, forwardRef, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { ModelType } from '@typegoose/typegoose/lib/types'
import { genSalt, hash } from 'bcryptjs'
import { InjectModel } from 'nestjs-typegoose'
import { UserModel } from '../auth/user.model'
import { ALL_PERMISSIONS, Role } from '../roles/role.model'
import { SeedsService } from '../seeds/seeds.service'
import { Company } from './company.model'
import { ChangeAdminPasswordDto } from './dto/change-admin-password.dto'
import { CreateCompanyWithAdminDto } from './dto/create-company-with-admin.dto'
import { CreateCompanyDto } from './dto/create-company.dto'
import { UpdateCompanyDto } from './dto/update-company.dto'

@Injectable()
export class CompanyService {
	private readonly logger = new Logger(CompanyService.name)

	constructor(
		@InjectModel(Company) private readonly companyModel: ModelType<Company>,
		@InjectModel(UserModel) private readonly userModel: ModelType<UserModel>,
		@InjectModel(Role) private readonly roleModel: ModelType<Role>,
		private readonly jwtService: JwtService,
		@Inject(forwardRef(() => SeedsService))
		private readonly seedsService: SeedsService
	) {}

	async create(dto: CreateCompanyDto, currentUser: UserModel): Promise<Company> {
		const name = dto.name?.trim() || this.generateName()
		const slug = (dto.slug?.trim() || this.slugify(name) || this.randomSlug()).slice(0, 60)

		await this.assertUniqueName(name)
		await this.assertUniqueSlug(slug)

		const created = new this.companyModel({
			name,
			slug,
			isActive: dto.isActive ?? true,
			createdBy: currentUser?._id,
			createdAt: Date.now(),
		})
		await created.save()
		return created
	}


	async createWithAdmin(dto: CreateCompanyWithAdminDto, currentUser: UserModel) {
		const adminLogin = dto.adminLogin.trim()
		if (!adminLogin) throw new BadRequestException('adminLogin обязателен')
		await this.assertLoginAvailable(adminLogin)

		const name = dto.name?.trim() || this.generateName()
		const slug = (dto.slug?.trim() || this.slugify(name) || this.randomSlug()).slice(0, 60)
		await this.assertUniqueName(name)
		await this.assertUniqueSlug(slug)

		const company = new this.companyModel({
			name,
			slug,
			isActive: dto.isActive ?? true,
			createdBy: currentUser?._id,
			createdAt: Date.now(),
		})
		await company.save()

		const adminRole = await this.roleModel.create({
			company: company._id,
			name: 'Admin',
			isSystem: true,
			permissions: [...ALL_PERMISSIONS],
		} as any)

		const salt = await genSalt(12)
		const passwordHash = await hash(dto.adminPassword, salt)
		const adminUser = await this.userModel.create({
			login: adminLogin,
			password: passwordHash,
			name: dto.adminName?.trim() || `Админ ${name}`,
			role: adminRole._id,
			isAdmin: true,
			isSuperAdmin: false,
			company: company._id,
		} as any)


		let seedReport: any = null
		if (dto.seedRoles || dto.seedProducts) {
			try {
				seedReport = await this.seedsService.applySeedsToCompany(String(company._id), {
					seedRoles: !!dto.seedRoles,
					seedProducts: !!dto.seedProducts,
				})
			} catch (e) {
				this.logger.error('Seed application failed', e as any)
				seedReport = { error: (e as any)?.message || 'seeds failed' }
			}
		}

		return {
			company,
			admin: {
				_id: adminUser._id,
				login: adminUser.login,
				name: adminUser.name,
				role: adminRole.name,
			},
			seedReport,
		}
	}

	async listAdmins(companyId: string) {
		return this.userModel
			.find({ company: companyId, isAdmin: true, deletedAt: null })
			.setOptions({ skipTenantScope: true } as any)
			.select('_id login name role isSuperAdmin')
			.populate('role')
			.exec()
	}


	async listUsers(companyId: string) {
		return this.userModel
			.find({ company: companyId, deletedAt: null })
			.setOptions({ skipTenantScope: true } as any)
			.select('_id login name role isAdmin isSuperAdmin')
			.populate('role')
			.sort({ isAdmin: -1, name: 1 })
			.exec()
	}

	async changeAdminPassword(adminId: string, dto: ChangeAdminPasswordDto) {
		const admin = await this.userModel
			.findById(adminId)
			.setOptions({ skipTenantScope: true } as any)
			.exec()
		if (!admin) throw new NotFoundException('Админ не найден')
		if (admin.isSuperAdmin) {
			throw new BadRequestException('Нельзя менять пароль супер-админа через этот endpoint')
		}
		const salt = await genSalt(12)
		admin.password = await hash(dto.password, salt)
		await admin.save()
		return { ok: true, login: admin.login }
	}

	async impersonate(adminId: string) {
		const admin = await this.userModel
			.findById(adminId)
			.setOptions({ skipTenantScope: true } as any)
			.populate('role')
			.exec()
		if (!admin) throw new NotFoundException('Админ не найден')
		if (admin.isSuperAdmin) {
			throw new BadRequestException('Нельзя залогиниться под супер-админом через impersonate')
		}
		if (!admin.company) {
			throw new BadRequestException('У этого пользователя нет company')
		}
		const payload = {
			_id: String(admin._id),
			company: String(admin.company),
			isSuperAdmin: false,
			login: admin.login,
		}
		const refreshToken = await this.jwtService.signAsync(payload, { expiresIn: '30d' })
		const accessToken = await this.jwtService.signAsync(payload, { expiresIn: '1h' })

		admin.refreshToken = await hash(refreshToken, await genSalt(10))
		await admin.save()
		return {
			user: {
				_id: admin._id,
				login: admin.login,
				name: admin.name,
				role: admin.role,
				isAdmin: admin.isAdmin,
				isSuperAdmin: false,
				company: admin.company,
			},
			refreshToken,
			accessToken,
		}
	}

	async findAll(): Promise<Company[]> {
		return this.companyModel
			.find({ deletedAt: null })
			.setOptions({ skipTenantScope: true } as any)
			.sort({ createdAt: -1 })
			.exec()
	}

	async findOne(id: string): Promise<Company> {
		const company = await this.companyModel
			.findById(id)
			.setOptions({ skipTenantScope: true } as any)
			.exec()
		if (!company) throw new NotFoundException('Компания не найдена')
		return company
	}

	async update(id: string, dto: UpdateCompanyDto): Promise<Company> {
		const updated = await this.companyModel
			.findByIdAndUpdate(id, dto, { new: true })
			.setOptions({ skipTenantScope: true } as any)
			.exec()
		if (!updated) throw new NotFoundException('Компания не найдена')
		return updated
	}

	async deactivate(id: string): Promise<Company> {
		const updated = await this.companyModel
			.findByIdAndUpdate(id, { isActive: false }, { new: true })
			.setOptions({ skipTenantScope: true } as any)
			.exec()
		if (!updated) throw new NotFoundException('Компания не найдена')
		return updated
	}

	async activate(id: string): Promise<Company> {
		const updated = await this.companyModel
			.findByIdAndUpdate(id, { isActive: true }, { new: true })
			.setOptions({ skipTenantScope: true } as any)
			.exec()
		if (!updated) throw new NotFoundException('Компания не найдена')
		return updated
	}

	async hardDelete(id: string, confirm?: string): Promise<{ deletedCompany: string; deletedCounts: any }> {
		if (confirm !== 'i-know-what-i-am-doing') {
			throw new BadRequestException(
				'Для полного удаления компании передайте { confirm: "i-know-what-i-am-doing" }'
			)
		}
		const company = await this.companyModel
			.findById(id)
			.setOptions({ skipTenantScope: true } as any)
			.exec()
		if (!company) throw new NotFoundException('Компания не найдена')

		const skip = { skipTenantScope: true } as any
		const companyFilter = { company: company._id }
		const conn = (this.companyModel as any).db
		const collections = [
			'Users', 'Products', 'Orders', 'Purchases', 'Inventory',
			'Roles', 'Message', 'Subscriptions', 'ChangeHistory',
			'CabinetItems', 'Counter',
		]
		const deletedCounts: any = {}
		const failed: string[] = []
		for (const collName of collections) {
			try {
				const res = await conn.collection(collName).deleteMany(companyFilter)
				deletedCounts[collName] = res.deletedCount || 0
			} catch (e) {
				deletedCounts[collName] = `error: ${e.message}`
				failed.push(`${collName}: ${e.message}`)
			}
		}
		if (failed.length > 0) {
			throw new BadRequestException(
				`Не удалось полностью удалить данные компании (${failed.join('; ')}). ` +
					`Компания НЕ удалена. Повторите операцию.`
			)
		}
		await this.companyModel
			.findByIdAndDelete(id)
			.setOptions(skip)
			.exec()
		return { deletedCompany: company.name, deletedCounts }
	}

	private async assertUniqueName(name: string) {
		const exists = await this.companyModel
			.findOne({ name })
			.setOptions({ skipTenantScope: true } as any)
		if (exists) throw new BadRequestException(`Компания с названием "${name}" уже существует`)
	}

	private async assertUniqueSlug(slug: string) {
		if (!slug) return
		const exists = await this.companyModel
			.findOne({ slug })
			.setOptions({ skipTenantScope: true } as any)
		if (exists) throw new BadRequestException(`Компания с slug "${slug}" уже существует`)
	}

	private async assertLoginAvailable(login: string) {
		const exists = await this.userModel
			.findOne({ login })
			.setOptions({ skipTenantScope: true } as any)
		if (exists) throw new BadRequestException(`Пользователь с логином "${login}" уже существует`)
	}

	private generateName(): string {
		return `Админ(${Math.floor(100 + Math.random() * 900)})`
	}

	private randomSlug(): string {
		return 'company-' + Math.random().toString(36).slice(2, 8)
	}

	private slugify(name: string): string {
		const map: Record<string, string> = {
			а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',
			к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',
			х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya',
		}
		return name
			.toLowerCase()
			.split('')
			.map((ch) => (map[ch] !== undefined ? map[ch] : ch))
			.join('')
			.replace(/[^a-z0-9-]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.replace(/-{2,}/g, '-')
			.slice(0, 60)
	}
}
