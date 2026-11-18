/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { IsNotEmpty, IsString, Matches, MaxLength, ValidateIf } from 'class-validator'

export class KindCoverDto {
	@IsNotEmpty()
	@IsString()
	@MaxLength(200)
	category: string

	// null обязателен явно: так снятие обложки не спутать с забытым полем
	@ValidateIf((o) => o.cover !== null)
	@IsString()
	@Matches(/^[a-z0-9-]{1,32}$/)
	cover: string | null
}

export class RenameKindDto {
	@IsString()
	@MaxLength(200)
	from: string

	@IsString()
	@MaxLength(200)
	to: string
}
