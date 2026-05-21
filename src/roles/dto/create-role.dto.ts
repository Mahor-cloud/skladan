/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { IsArray, IsNotEmpty, IsString, MaxLength } from 'class-validator'

export class CreateRoleDto {
	@IsNotEmpty()
	@IsString()
	@MaxLength(200)
	name: string

	@IsArray()
	@IsString({ each: true })
	permissions: string[]
}
