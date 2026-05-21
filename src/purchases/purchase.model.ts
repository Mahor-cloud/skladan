/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { modelOptions, mongoose, plugin, prop, Ref } from '@typegoose/typegoose'
import { Base } from '@typegoose/typegoose/lib/defaultClasses'
import { UserModel } from '../auth/user.model'
import { tenantPlugin } from '../common/plugins/tenant.plugin'
import { Company } from '../company/company.model'
import { Product } from '../products/product.model'

export interface Purchase extends Base {}

@plugin(tenantPlugin)
@modelOptions({
	options: {
		allowMixed: 0,
	},
})
export class Purchase {
	@prop({ ref: Company, type: mongoose.Types.ObjectId, required: true })
	company: Ref<Company>

	@prop()
	purchaseNumber: number

	@prop({ ref: UserModel, type: mongoose.Types.ObjectId })
	user: Ref<UserModel>

	@prop({ default: false })
	isCompleted: boolean

	@prop({ default: false })
	partialCompleted: boolean

	@prop({ default: false })
	isPaid: boolean

	@prop({ default: false })
	isCreated: boolean

	@prop()
	items: {
		product: Ref<Product>
		quantity: number
		confirmedQuantity: number
	}[]

	@prop({ default: () => Date.now() })
	purchaseDate: number

	@prop({ default: 0 })
	totalAmount: number

	@prop({ default: 0 })
	totalConfirmedAmount: number

	@prop()
	comment?: string
}
