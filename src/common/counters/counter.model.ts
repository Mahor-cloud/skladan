/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { index, modelOptions, mongoose, prop, Ref } from '@typegoose/typegoose'
import { Base } from '@typegoose/typegoose/lib/defaultClasses'
import { Company } from '../../company/company.model'

export interface Counter extends Base {}

@index({ company: 1, type: 1 }, { unique: true })
@modelOptions({
	options: {
		allowMixed: 0,
	},
	schemaOptions: {
		collection: 'Counter',
	},
})
export class Counter {
	@prop({ ref: Company, type: mongoose.Types.ObjectId, required: true })
	company: Ref<Company>

	@prop({ required: true })
	type: string

	@prop({ default: 0 })
	value: number
}
