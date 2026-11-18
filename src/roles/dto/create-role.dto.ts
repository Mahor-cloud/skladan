/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { ArrayMaxSize, ArrayUnique, IsArray, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator'
import { MOBILE_TABS } from '../role.model'

export class CreateRoleDto {
	@IsNotEmpty()
	@IsString()
	@MaxLength(200)
	name: string

	@IsArray()
	@IsString({ each: true })
	permissions: string[]

	@IsOptional()
	@IsArray()
	@ArrayMaxSize(4)
	@ArrayUnique()
	@IsIn(MOBILE_TABS, { each: true })
	mobileTabs?: string[]
}
