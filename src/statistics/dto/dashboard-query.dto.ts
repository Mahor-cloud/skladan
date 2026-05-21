/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { IsInt, IsOptional, IsString } from 'class-validator'
import { Type, Transform } from 'class-transformer'

function toStringValue({ value }: { value: any }): string | undefined {
	if (Array.isArray(value)) return value.join(',')
	if (value === undefined || value === null) return undefined
	return String(value)
}

export class DashboardQueryDto {
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	from?: number

	@IsOptional()
	@Type(() => Number)
	@IsInt()
	to?: number

	@IsOptional()
	@Transform(toStringValue)
	@IsString()
	users?: string

	@IsOptional()
	@Transform(toStringValue)
	@IsString()
	products?: string

	@IsOptional()
	@Transform(toStringValue)
	@IsString()
	categories?: string

	@IsOptional()
	@Type(() => Number)
	@IsInt()
	topLimit?: number
}

export class TimelineQueryDto {
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	from?: number

	@IsOptional()
	@Type(() => Number)
	@IsInt()
	to?: number

	@IsOptional()
	@Type(() => Number)
	@IsInt()
	page?: number

	@IsOptional()
	@Type(() => Number)
	@IsInt()
	limit?: number
}
