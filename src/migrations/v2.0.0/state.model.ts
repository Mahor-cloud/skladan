/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { modelOptions, prop } from '@typegoose/typegoose'
import { Base } from '@typegoose/typegoose/lib/defaultClasses'

export interface MigrationState extends Base {}

@modelOptions({
	options: { allowMixed: 0 },
	schemaOptions: { collection: 'MigrationState' },
})
export class MigrationState {
	@prop({ unique: true, required: true })
	name: string

	@prop({ default: () => Date.now() })
	appliedAt: number

	@prop()
	version: string

	@prop()
	durationMs?: number

	@prop()
	notes?: string
}
