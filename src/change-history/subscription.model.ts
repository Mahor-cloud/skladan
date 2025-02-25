import { modelOptions, mongoose, prop, Ref } from '@typegoose/typegoose'
import { Base } from '@typegoose/typegoose/lib/defaultClasses'
import { UserModel } from '../auth/user.model'

export interface SubscriptionModel extends Base {}

@modelOptions({
	options: {
		allowMixed: 0,
	},
})
export class SubscriptionModel {
	@prop({ required: true, ref: UserModel, type: mongoose.Types.ObjectId })
	user: Ref<UserModel>

	@prop({ required: true, unique: true })
	endpoint: string

	@prop({ required: true })
	keys: {
		p256dh: string
		auth: string
	}
}
