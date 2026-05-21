/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator'

export class CreateCompanyDto {
	@IsString()
	@MinLength(2)
	@MaxLength(120)
	name: string

	@IsOptional()
	@IsString()
	@MaxLength(60)
	slug?: string

	@IsOptional()
	@IsBoolean()
	isActive?: boolean
}
