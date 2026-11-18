/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { IsBoolean, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator'

export class MessagesDto {
	@IsOptional()
	@IsString()
	@MaxLength(2000)
	paymentMessage?: string

	@IsOptional()
	@IsString()
	@MaxLength(2000)
	receivedMessage?: string
}

export class PaymentMessageDto {
	@IsString()
	@MaxLength(2000)
	paymentMessage: string

	@IsOptional()
	@IsString()
	@MaxLength(100)
	paymentCard?: string

	@IsOptional()
	@IsString()
	@MaxLength(100)
	paymentPhone?: string

	@IsOptional()
	@IsString()
	@MaxLength(100)
	paymentHolder?: string
}

export class ReceivedMessageDto {
	@IsString()
	@MaxLength(2000)
	receivedMessage: string
}

export class TargetWarehouseValueDto {
	@IsNumber()
	@Min(0)
	targetWarehouseValue: number
}

export class InventoryOpenDocsDto {
	@IsBoolean()
	allowInventoryWithOpenDocs: boolean
}
