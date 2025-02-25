import { modelOptions, mongoose, prop, Ref } from '@typegoose/typegoose'
import { Base } from '@typegoose/typegoose/lib/defaultClasses'
import { UserModel } from '../auth/user.model'
import { Product } from '../products/product.model'
export interface Inventory extends Base {}

@modelOptions({
	options: {
		allowMixed: 0,
	},
})
export class Inventory {
	@prop({ default: false })
	isCompleted: boolean

	@prop({ default: () => Date.now() })
	startDate: number

	@prop({ ref: UserModel, type: mongoose.Types.ObjectId })
	createdBy: Ref<UserModel>

	@prop()
	items: { product: Ref<Product>; newQuantity: number; quantity: number }[]

	@prop({ default: '' })
	comment: string
}
