import { modelOptions, mongoose, plugin, prop, Ref } from '@typegoose/typegoose'
import { Base } from '@typegoose/typegoose/lib/defaultClasses'
import { UserModel } from '../auth/user.model'
import { tenantPlugin } from '../common/plugins/tenant.plugin'
import { Company } from '../company/company.model'

export interface SubscriptionModel extends Base {}

export const SUBSCRIPTION_CATEGORIES = [
	'orders',
	'purchases',
	'inventory',
	'products',
	'users',
	'roles',
	'payment',
] as const

export type SubscriptionCategory = (typeof SUBSCRIPTION_CATEGORIES)[number]

export class SubscriptionPreferences {
	@prop({ default: true })
	orders?: boolean

	@prop({ default: true })
	purchases?: boolean

	@prop({ default: true })
	inventory?: boolean

	@prop({ default: true })
	products?: boolean

	@prop({ default: true })
	users?: boolean

	@prop({ default: true })
	roles?: boolean

	@prop({ default: true })
	payment?: boolean

	@prop({ default: false })
	ordersOwnOnly?: boolean
}

@plugin(tenantPlugin)
@modelOptions({
	options: {
		allowMixed: 0,
	},
})
export class SubscriptionModel {
	@prop({ ref: Company, type: mongoose.Types.ObjectId, required: true })
	company: Ref<Company>

	@prop({ required: true, ref: UserModel, type: mongoose.Types.ObjectId })
	user: Ref<UserModel>

	@prop({ required: true })
	endpoint: string

	@prop({ required: true })
	keys: {
		p256dh: string
		auth: string
	}

	@prop({ default: () => Date.now() })
	subscribedAt?: number

	@prop()
	userAgent?: string

	@prop({ _id: false, default: () => ({}) })
	preferences?: SubscriptionPreferences
}
