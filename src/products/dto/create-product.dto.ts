/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { Transform } from 'class-transformer'
import { IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator'

export class CreateProductDto {
	@IsNotEmpty()
	@IsString()
	@MaxLength(200)
	name: string

	@IsNumber()
	@Min(0)
	price: number

	@IsInt()
	@Min(0)
	quantity: number

	@IsNotEmpty()
	@IsString()
	@MaxLength(200)
	category: string

	@IsOptional()
	@IsInt()
	@Min(0)
	targetQty?: number

	// '' сводится к null: оба значения сбрасывают цвет
	@IsOptional()
	@Transform(({ value }) => (value === '' ? null : value))
	@IsString()
	@Matches(/^#[0-9a-fA-F]{6}$/)
	coverColor?: string | null
}
