/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { Type } from 'class-transformer'
import {
	ArrayMaxSize,
	IsArray,
	IsIn,
	IsInt,
	IsMongoId,
	IsOptional,
	IsString,
	Matches,
	Max,
	MaxLength,
	Min,
	ValidateNested,
} from 'class-validator'
import { USAGE_KINDS } from '../usage.model'

const DAY_MS = 24 * 3600 * 1000

/** Одна строка пачки: k — вид, s — экран, l — элемент, n — сколько раз, ms — активное время, max — самое долгое посещение. */
export class UsageEventDto {
	@IsIn(USAGE_KINDS as unknown as string[])
	k!: string

	@IsString()
	@MaxLength(60)
	s!: string

	@IsString()
	@MaxLength(80)
	l!: string

	@IsInt()
	@Min(0)
	@Max(100_000)
	n!: number

	@IsOptional()
	@IsInt()
	@Min(0)
	@Max(DAY_MS)
	ms?: number

	@IsOptional()
	@IsInt()
	@Min(0)
	@Max(DAY_MS)
	max?: number
}

export class UsageBatchDto {
	@IsIn(['phone', 'desktop'])
	device!: string

	@IsArray()
	@ArrayMaxSize(300)
	@ValidateNested({ each: true })
	@Type(() => UsageEventDto)
	events!: UsageEventDto[]
}

export class UsageQueryDto {
	/** Всё время: период — от первой записи до сегодня, from и to не нужны */
	@IsOptional()
	@IsIn(['1'])
	all?: string

	/** Последние 24 часа по часовым записям: from, to и all не нужны */
	@IsOptional()
	@IsIn(['24'])
	hours?: string

	@IsOptional()
	@Matches(/^\d{4}-\d\d-\d\d$/)
	from?: string

	@IsOptional()
	@Matches(/^\d{4}-\d\d-\d\d$/)
	to?: string

	@IsOptional()
	@IsMongoId()
	company?: string

	@IsOptional()
	@IsMongoId()
	user?: string

	@IsOptional()
	@IsString()
	@MaxLength(80)
	role?: string

	/** Код права: отбор ролей, у которых оно было в выбранный период */
	@IsOptional()
	@IsString()
	@MaxLength(60)
	perm?: string

	@IsOptional()
	@IsIn(['phone', 'desktop'])
	device?: string
}
