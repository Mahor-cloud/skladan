/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { ArrayMinSize, IsArray, IsBoolean, IsInt, IsMongoId, IsNotEmpty, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator'
import { Type } from 'class-transformer'

class OrderItemDto {
	@IsNotEmpty()
	@IsMongoId()
	product: string

	@IsInt()
	@Min(1)
	quantity: number
}

export class UpdateOrderDto {
	@IsOptional()
	@IsBoolean()
	isCompleted?: boolean

	@IsOptional()
	@IsMongoId()
	user?: string

	@IsOptional()
	@IsArray()
	@ArrayMinSize(1, { message: 'Заказ не может быть пустым' })
	@ValidateNested({ each: true })
	@Type(() => OrderItemDto)
	items?: OrderItemDto[]

	@IsOptional()
	@IsString()
	@MaxLength(200)
	status?: string

	@IsOptional()
	@IsBoolean()
	isPaid?: boolean

	@IsOptional()
	@IsBoolean()
	confirmedPaid?: boolean

	@IsOptional()
	@IsInt()
	@Min(0)
	orderDate?: number

	@IsOptional()
	@IsString()
	@MaxLength(1000)
	comment?: string

	@IsOptional()
	@IsString()
	@MaxLength(500)
	editReason?: string
}
