/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { IsString, MinLength, MaxLength } from 'class-validator'

export class ChangeAdminPasswordDto {
	@IsString()
	@MinLength(4)
	@MaxLength(120)
	password!: string
}
