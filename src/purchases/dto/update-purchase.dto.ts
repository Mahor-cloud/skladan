/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { IsArray, IsBoolean, IsInt, IsMongoId, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator'
import { Type } from 'class-transformer'

class UpdatePurchaseItemDto {
	@IsMongoId()
	product: string

	@IsInt()
	@Min(0)
	quantity: number

	@IsOptional()
	@IsInt()
	@Min(0)
	confirmedQuantity?: number
}

export class UpdatePurchaseDto {
	@IsOptional()
	@IsMongoId()
	user?: string

	@IsOptional()
	@IsArray()
	@ValidateNested({ each: true })
	@Type(() => UpdatePurchaseItemDto)
	items?: UpdatePurchaseItemDto[]

	@IsOptional()
	@IsString()
	@MaxLength(200)
	status?: string

	@IsOptional()
	@IsBoolean()
	isPaid?: boolean

	@IsOptional()
	@IsBoolean()
	partialCompleted?: boolean

	@IsOptional()
	@IsBoolean()
	isCompleted?: boolean

	@IsOptional()
	@IsBoolean()
	isCreated?: boolean

	@IsOptional()
	@IsInt()
	@Min(0)
	purchaseDate?: number

	@IsOptional()
	@IsString()
	@MaxLength(1000)
	comment?: string
}
