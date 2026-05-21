import { IsInt, IsMongoId, IsNotEmpty, Min } from 'class-validator'

export class CreateOrderDto {
	@IsNotEmpty()
	@IsMongoId()
	product: string

	@IsInt()
	@Min(1)
	quantity: number
}
