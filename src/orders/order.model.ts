import { modelOptions, mongoose, prop, Ref } from '@typegoose/typegoose'
import { Base } from '@typegoose/typegoose/lib/defaultClasses'
import { UserModel } from '../auth/user.model'
import { Product } from '../products/product.model'

export interface Order extends Base {}

@modelOptions({
	options: {
		allowMixed: 0,
	},
})
export class Order {
	@prop({ unique: true })
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

	@prop()
	comment?: string
}
