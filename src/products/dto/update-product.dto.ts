/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { IsInt, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator'

export class UpdateProductDto {
	@IsOptional()
	@IsString()
	@MaxLength(200)
	name?: string

	@IsOptional()
	@IsNumber()
	@Min(0)
	price?: number

	@IsOptional()
	@IsInt()
	@Min(0)
	quantity?: number

	@IsOptional()
	@IsString()
	@MaxLength(200)
	category?: string

	@IsOptional()
	@IsInt()
	@Min(0)
	targetQty?: number
}
