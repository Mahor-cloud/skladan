/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator'

export class CreateCompanyWithAdminDto {
	@IsOptional()
	@IsString()
	@MaxLength(120)
	name?: string

	@IsOptional()
	@IsString()
	@MaxLength(60)
	slug?: string

	@IsOptional()
	@IsBoolean()
	isActive?: boolean

	@IsString()
	@MinLength(3)
	@MaxLength(60)
	adminLogin!: string

	@IsString()
	@MinLength(4)
	@MaxLength(120)
	adminPassword!: string

	@IsOptional()
	@IsString()
	@MaxLength(120)
	adminName?: string

	@IsOptional()
	@IsBoolean()
	seedRoles?: boolean

	@IsOptional()
	@IsBoolean()
	seedProducts?: boolean

	/** Откуда товары: seeds — шаблон «Семян» (как было), litna — весь каталог lit-na.ru с нулевым остатком (засевает товары и без seedProducts) */
	@IsOptional()
	@IsIn(['seeds', 'litna'])
	products?: 'seeds' | 'litna'
}
