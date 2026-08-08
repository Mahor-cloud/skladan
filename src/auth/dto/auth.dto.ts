/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { Transform } from 'class-transformer'
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator'

const trim = ({ value }: { value: unknown }) =>
	typeof value === 'string' ? value.trim() : value

export class authDto {
	@Transform(trim)
	@IsString({ message: 'Логин указан неверно' })
	@IsNotEmpty({ message: 'Введите логин' })
	@MaxLength(64, { message: 'Логин длиннее 64 символов' })
	login: string

	@Transform(trim)
	@IsString({ message: 'Пароль указан неверно' })
	@IsNotEmpty({ message: 'Введите пароль' })
	@MinLength(4, { message: 'Пароль короче 4 символов' })
	@MaxLength(128, { message: 'Пароль длиннее 128 символов' })
	password: string
}
