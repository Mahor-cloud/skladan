/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { modelOptions, mongoose, plugin, prop, Ref } from '@typegoose/typegoose'
import { Base } from '@typegoose/typegoose/lib/defaultClasses'
import { tenantPlugin } from '../common/plugins/tenant.plugin'
import { Company } from '../company/company.model'

export interface Message extends Base {}

export class KindCover {
	@prop({ required: true })
	category: string

	@prop({ required: true })
	cover: string
}

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
	paymentCard?: string

	@prop()
	paymentPhone?: string

	@prop()
	paymentHolder?: string

	@prop()
	receivedMessage: string

	@prop({ default: 0, min: 0 })
	targetWarehouseValue: number

	@prop({ default: false })
	allowInventoryWithOpenDocs: boolean

	// Массив пар, а не объект-словарь: вид — свободная строка, в ключе Map нельзя «.» и «$»
	@prop({ type: () => [KindCover], _id: false, default: undefined })
	kindCovers?: KindCover[]
}
