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
		// цена штуки, по которой посчитаны суммы закупки (см. common/line-prices); у старых закупок её может не быть
		price?: number
	}[]

	@prop({ default: () => Date.now() })
	purchaseDate: number

	@prop({ default: 0 })
	totalAmount: number

	@prop({ default: 0 })
	totalConfirmedAmount: number

	@prop()
	comment?: string

	// заказ на lit-na.ru — открытые данные; ключ заказа лежит отдельно, в LitnaOrders. shipping в totalAmount не входит.
	@prop()
	litna?: {
		orderId: number | null
		status: string
		shipping: number
		total: number
		delivery: { kind: string; title: string | null; point: string | null }
		createdAt: number
		/** когда проверка отметила оплату (статус сайта — в status) */
		paidAt?: number
		/** когда фоновая проверка увидела заказ отправленным (статус магазина «Доставка») */
		shippedAt?: number
		/** когда фоновая проверка увидела заказ отменённым уже после оплаты */
		cancelledAt?: number
	}
}
