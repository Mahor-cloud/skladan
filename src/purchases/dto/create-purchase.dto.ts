/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { IsArray, IsBoolean, IsInt, IsMongoId, IsNotEmpty, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator'
import { Type } from 'class-transformer'

class PurchaseItemDto {
	@IsNotEmpty()
	@IsMongoId()
	product: string

	@IsInt()
	@Min(0)
	quantity: number
}

export class CreatePurchaseDto {
	@IsNotEmpty()
	@IsMongoId()
	user: string

	@IsArray()
	@ValidateNested({ each: true })
	@Type(() => PurchaseItemDto)
	items: PurchaseItemDto[]

	@IsNotEmpty()
	@IsString()
	@MaxLength(200)
	status: string

	@IsOptional()
	@IsBoolean()
	isPaid?: boolean

	@IsOptional()
	@IsBoolean()
	isCompleted?: boolean

	@IsOptional()
	@IsInt()
	@Min(0)
	purchaseDate?: number

	@IsOptional()
	@IsString()
	@MaxLength(1000)
	comment?: string
}
