import { modelOptions, mongoose, prop, Ref } from '@typegoose/typegoose'
import { Base } from '@typegoose/typegoose/lib/defaultClasses'
import { UserModel } from '../auth/user.model'
import { Product } from '../products/product.model'

export interface Purchase extends Base {}

@modelOptions({
	options: {
		allowMixed: 0,
	},
})
export class Purchase {
	@prop({ unique: true, autoIncrement: true })
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

	@prop()
	comment?: string
}
