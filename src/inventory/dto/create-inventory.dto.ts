import { IsArray, IsBoolean, IsInt, IsMongoId, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator'
import { Type } from 'class-transformer'

class InventoryItemDto {
	@IsMongoId()
	product: string

	@IsInt()
	newQuantity: number


	@IsInt()
	quantity: number
}

export class CreateInventoryDto {
	@IsOptional()
	@IsBoolean()
	isCompleted?: boolean

	@IsOptional()
	@IsInt()
	@Min(0)
	startDate?: number

	@IsOptional()
	@IsMongoId()
	createdBy?: string

	@IsOptional()
	@IsArray()
	@ValidateNested({ each: true })
	@Type(() => InventoryItemDto)
	items?: InventoryItemDto[]

	@IsOptional()
	@IsString()
	@MaxLength(1000)
	comment?: string

	@IsOptional()
	@IsBoolean()
	prefillFromStock?: boolean
}
