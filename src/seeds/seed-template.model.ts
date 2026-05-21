/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { modelOptions, prop } from '@typegoose/typegoose'
import { Base } from '@typegoose/typegoose/lib/defaultClasses'

export interface SeedTemplate extends Base {}

export class SeedRoleTemplate {
	@prop({ required: true })
	name: string

	@prop({ type: () => [String], default: [] })
	permissions: string[]
}

export class SeedProductTemplate {
	@prop({ required: true })
	name: string

	@prop({ default: '' })
	category: string

	@prop({ default: 0 })
	price: number

	@prop({ default: 0 })
	targetQty: number
}

@modelOptions({
	options: { allowMixed: 0 },
	schemaOptions: { collection: 'SeedTemplate' },
})
export class SeedTemplate {

	@prop({ required: true, unique: true, default: 'default' })
	key: string

	@prop({ type: () => [SeedRoleTemplate], default: [] })
	roles: SeedRoleTemplate[]

	@prop({ type: () => [SeedProductTemplate], default: [] })
	products: SeedProductTemplate[]

	@prop({ default: () => Date.now() })
	updatedAt?: number
}
