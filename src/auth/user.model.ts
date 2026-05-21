import { modelOptions, mongoose, plugin, prop, Ref } from '@typegoose/typegoose'
import { Base } from '@typegoose/typegoose/lib/defaultClasses'
import { tenantPlugin } from 'src/common/plugins/tenant.plugin'
import { Company } from 'src/company/company.model'
import { Role } from 'src/roles/role.model'

export interface UserModel extends Base {}

@plugin(tenantPlugin)
@modelOptions({
	options: {
		allowMixed: 0,
	},
})
export class UserModel {
	@prop()
	login: string

	@prop()
	password: string

	@prop()
	name: string

	@prop({ ref: Role, type: mongoose.Types.ObjectId })
	role: Ref<Role>

	@prop({ default: false })
	isAdmin: boolean

	@prop({ default: false })
	isSuperAdmin: boolean

	@prop({ ref: Company, type: mongoose.Types.ObjectId })
	company?: Ref<Company>

	@prop()
	refreshToken?: string

	@prop({ default: null })
	deletedAt?: Date
}
