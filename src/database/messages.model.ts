/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { modelOptions, mongoose, plugin, prop, Ref } from '@typegoose/typegoose'
import { Base } from '@typegoose/typegoose/lib/defaultClasses'
import { tenantPlugin } from '../common/plugins/tenant.plugin'
import { Company } from '../company/company.model'

export interface Message extends Base {}

@plugin(tenantPlugin)
@modelOptions({
	options: {
		allowMixed: 0,
	},
})
export class Message {
	@prop({ ref: Company, type: mongoose.Types.ObjectId, required: true })
	company: Ref<Company>

	@prop()
	paymentMessage: string

	@prop()
	receivedMessage: string

	@prop({ default: 0, min: 0 })
	targetWarehouseValue: number
}
