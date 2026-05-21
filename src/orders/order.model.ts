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

export interface Order extends Base {}

export type PaymentEventType =
	| 'paid'
	| 'payment-confirmed'
	| 'surcharge-pending'
	| 'refund-pending'
	| 'surcharge-confirmed'
	| 'refund-confirmed'
	| 'items-changed'

export class PaymentEvent {
	@prop({ required: true })
	type: PaymentEventType

	@prop({ default: 0 })
	amount: number

	@prop({ ref: UserModel, type: mongoose.Types.ObjectId })
	by: Ref<UserModel>

	@prop({ default: () => Date.now() })
	at: number

	@prop()
	reason?: string

	@prop()
	note?: string
}

@plugin(tenantPlugin)
@modelOptions({
	options: {
		allowMixed: 0,
	},
})
export class Order {
	@prop({ ref: Company, type: mongoose.Types.ObjectId, required: true })
	company: Ref<Company>

	@prop()
	orderNumber: number

	@prop({ ref: UserModel, type: mongoose.Types.ObjectId })
	user: Ref<UserModel>

	@prop({ default: false })
	isCompleted: boolean

	@prop()
	items: { product: Ref<Product>; quantity: number }[]

	@prop({ default: false })
	isPaid: boolean

	@prop({ default: false })
	confirmedPaid: boolean

	@prop({ default: () => Date.now() })
	orderDate: number

	@prop({ default: 0 })
	totalAmount: number


	@prop({ default: 0 })
	paidAmount: number

	@prop({ type: () => [PaymentEvent], default: [] })
	paymentEvents: PaymentEvent[]

	@prop()
	comment?: string
}
