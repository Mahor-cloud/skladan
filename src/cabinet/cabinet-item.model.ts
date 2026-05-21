/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { index, modelOptions, mongoose, plugin, prop, Ref } from '@typegoose/typegoose'
import { Base } from '@typegoose/typegoose/lib/defaultClasses'
import { UserModel } from '../auth/user.model'
import { tenantPlugin } from '../common/plugins/tenant.plugin'
import { Company } from '../company/company.model'
import { Product } from '../products/product.model'

export interface CabinetItem extends Base {}

@plugin(tenantPlugin)
@index({ user: 1, product: 1, deletedAt: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } })
@modelOptions({
	options: {
		allowMixed: 0,
	},
})
export class CabinetItem {
	@prop({ ref: Company, type: mongoose.Types.ObjectId, required: true })
	company: Ref<Company>

	@prop({ ref: UserModel, type: mongoose.Types.ObjectId, required: true, index: true })
	user: Ref<UserModel>

	@prop({ ref: Product, type: mongoose.Types.ObjectId, required: false })
	product?: Ref<Product>

	@prop({ default: '' })
	customName?: string

	@prop({ default: 0, min: 0 })
	baseQty: number

	@prop({ default: 0, min: 0 })
	currentQty: number


	@prop({ default: 0, min: 0 })
	customPrice?: number

	@prop({ default: '' })
	note?: string

	@prop({ default: 0 })
	position?: number

	@prop({ default: () => Date.now() })
	createdAt?: number

	@prop({ default: null })
	deletedAt?: Date
}
