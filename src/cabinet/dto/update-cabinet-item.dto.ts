/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { IsInt, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator'

export class UpdateCabinetItemDto {
	@IsOptional()
	@IsInt()
	@Min(0)
	baseQty?: number

	@IsOptional()
	@IsInt()
	@Min(0)
	currentQty?: number

	@IsOptional()
	@IsNumber()
	@Min(0)
	customPrice?: number

	@IsOptional()
	@IsString()
	@MaxLength(200)
	note?: string

	@IsOptional()
	@IsString()
	@MaxLength(120)
	customName?: string
}
