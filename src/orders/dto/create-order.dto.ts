/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { IsInt, IsMongoId, IsNotEmpty, Min } from 'class-validator'

export class CreateOrderDto {
	@IsNotEmpty()
	@IsMongoId()
	product: string

	@IsInt()
	@Min(1)
	quantity: number
}
