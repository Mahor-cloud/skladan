import { IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator'

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
}
