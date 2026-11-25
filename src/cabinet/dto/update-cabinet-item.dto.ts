/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { Transform } from 'class-transformer'
import { IsInt, IsNumber, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator'
import { COVER_TYPE } from '../../products/dto/kinds.dto'

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

	// только у своей позиции; '' сводится к null: оба значения сбрасывают цвет
	@IsOptional()
	@Transform(({ value }) => (value === '' ? null : value))
	@IsString()
	@Matches(/^#[0-9a-fA-F]{6}$/)
	coverColor?: string | null

	// тип рисунка обложки, как у вида; только у своей позиции, '' и null сбрасывают на обложку по умолчанию
	@IsOptional()
	@Transform(({ value }) => (value === '' ? null : value))
	@IsString()
	@Matches(COVER_TYPE)
	cover?: string | null
}
