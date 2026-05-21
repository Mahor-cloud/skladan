import { IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator'

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
