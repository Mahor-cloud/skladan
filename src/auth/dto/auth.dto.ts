/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator'

export class authDto {
	@IsString()
	@IsNotEmpty()
	@MaxLength(64)
	login: string

	@IsString()
	@IsNotEmpty()
	@MinLength(4)
	@MaxLength(128)
	password: string
}
