import { modelOptions, mongoose, prop, Ref } from '@typegoose/typegoose'
import { Base } from '@typegoose/typegoose/lib/defaultClasses'
import { UserModel } from '../auth/user.model'
export interface ChangeHistory extends Base {}
@modelOptions({
	options: {
		allowMixed: 0,
	},
})
export class ChangeHistory {
	@prop({ ref: UserModel, type: mongoose.Types.ObjectId })
	user: Ref<UserModel>

	@prop()
	changeType: string

	@prop()
	description: string

	@prop({ default: () => Date.now() })
	changeDate: number
}
