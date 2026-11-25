/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { Transform } from 'class-transformer'
import { ArrayMaxSize, IsArray, IsIn, IsMongoId, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator'

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value)

export const FEEDBACK_MAX = 2000

export class FeedbackDto {
	@Transform(trim)
	@IsString({ message: 'Напишите сообщение' })
	@IsNotEmpty({ message: 'Напишите сообщение' })
	@MaxLength(FEEDBACK_MAX, { message: `Сообщение длиннее ${FEEDBACK_MAX} знаков` })
	text: string
}

/** Страница списка: limit — сколько (1…100, по умолчанию 50), before — номер последнего показанного сообщения */
export class FeedbackListDto {
	@IsOptional()
	@Matches(/^\d{1,3}$/)
	limit?: string

	@IsOptional()
	@IsMongoId()
	before?: string
}

/** read=1 — удалить только прочитанные */
export class FeedbackDeleteDto {
	@IsOptional()
	@IsIn(['1'])
	read?: string
}

/** Без ids — прочитано всё */
export class FeedbackReadDto {
	@IsOptional()
	@IsArray()
	@ArrayMaxSize(500)
	@IsMongoId({ each: true })
	ids?: string[]
}
