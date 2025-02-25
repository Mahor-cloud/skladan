import { modelOptions, prop } from '@typegoose/typegoose'
import { Base } from '@typegoose/typegoose/lib/defaultClasses'

export interface Product extends Base {}

@modelOptions({
	options: {
		allowMixed: 0,
	},
})
export class Product {
	@prop({ unique: true })
	name: string

	@prop()
	price: number

	@prop()
	quantity: number

	@prop()
	category: string

	@prop({ default: () => Date.now() })
	createdAt?: number

	@prop({ default: null })
	deletedAt?: Date
}
