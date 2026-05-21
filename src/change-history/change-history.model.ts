import { modelOptions, mongoose, plugin, prop, Ref } from '@typegoose/typegoose'
import { Base } from '@typegoose/typegoose/lib/defaultClasses'
import { UserModel } from '../auth/user.model'
import { tenantPlugin } from '../common/plugins/tenant.plugin'
import { Company } from '../company/company.model'

export interface ChangeHistory extends Base {}

@plugin(tenantPlugin)
@modelOptions({
	options: {
		allowMixed: 0,
	},
})
export class ChangeHistory {
	@prop({ ref: Company, type: mongoose.Types.ObjectId, required: true })
	company: Ref<Company>

	@prop({ ref: UserModel, type: mongoose.Types.ObjectId })
	user: Ref<UserModel>


	@prop({ ref: UserModel, type: mongoose.Types.ObjectId })
	relatedUser?: Ref<UserModel>

	@prop()
	changeType: string

	@prop()
	description: string

	@prop({ default: () => Date.now() })
	changeDate: number
}
