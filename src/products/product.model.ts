import { modelOptions, mongoose, plugin, prop, Ref } from '@typegoose/typegoose'
import { Base } from '@typegoose/typegoose/lib/defaultClasses'
import { tenantPlugin } from 'src/common/plugins/tenant.plugin'
import { Company } from 'src/company/company.model'

export interface Product extends Base {}

@plugin(tenantPlugin)
@modelOptions({
	options: {
		allowMixed: 0,
	},
})
export class Product {
	@prop({ ref: Company, type: mongoose.Types.ObjectId, required: true })
	company: Ref<Company>

	@prop()
	name: string

	@prop()
	price: number

	@prop()
	quantity: number

	@prop({ default: 0 })
	targetQty: number

	@prop()
	category: string

	@prop({ default: () => Date.now() })
	createdAt?: number

	@prop({ default: null })
	deletedAt?: Date
}
