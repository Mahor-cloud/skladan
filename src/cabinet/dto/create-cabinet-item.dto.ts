import { IsInt, IsMongoId, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator'

export class CreateCabinetItemDto {
	@IsOptional()
	@IsMongoId()
	product?: string

	@IsOptional()
	@IsString()
	@MaxLength(120)
	customName?: string

	@IsInt()
	@Min(0)
	baseQty: number

	@IsInt()
	@Min(0)
	currentQty: number

	@IsOptional()
	@IsNumber()
	@Min(0)
	customPrice?: number

	@IsOptional()
	@IsString()
	@MaxLength(200)
	note?: string
}
