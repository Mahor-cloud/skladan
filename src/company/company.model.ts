/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { modelOptions, mongoose, prop, Ref } from '@typegoose/typegoose'
import { Base } from '@typegoose/typegoose/lib/defaultClasses'
import type { UserModel } from '../auth/user.model'

export interface Company extends Base {}

@modelOptions({
	options: {
		allowMixed: 0,
	},
	schemaOptions: {
		collection: 'Company',
	},
})
export class Company {
	@prop({ unique: true, required: true })
	name: string

	@prop({ unique: true, sparse: true })
	slug?: string

	@prop({ default: true })
	isActive: boolean

	@prop({ ref: 'UserModel', type: mongoose.Types.ObjectId })
	createdBy?: Ref<UserModel>

	@prop({ default: () => Date.now() })
	createdAt?: number

	@prop({ default: null })
	deletedAt?: Date

	@prop({ default: () => ({}) })
	settings?: Record<string, unknown>
}
