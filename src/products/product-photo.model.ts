/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { modelOptions, mongoose, plugin, prop, Ref } from '@typegoose/typegoose'
import { Base } from '@typegoose/typegoose/lib/defaultClasses'
import { tenantPlugin } from 'src/common/plugins/tenant.plugin'
import { Company } from 'src/company/company.model'

export interface ProductPhoto extends Base {}

// Байты отдельно от Products, чтобы список товаров не тяжелел; в Product.photo только ключ.
@plugin(tenantPlugin)
@modelOptions({
	options: {
		allowMixed: 0,
	},
})
export class ProductPhoto {
	@prop({ ref: Company, type: mongoose.Types.ObjectId, required: true })
	company: Ref<Company>

	@prop({ required: true, unique: true })
	token: string

	@prop({ required: true })
	contentType: string

	@prop({ required: true })
	data: Buffer
}
