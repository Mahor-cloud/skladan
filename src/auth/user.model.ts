import { modelOptions, mongoose, prop, Ref } from '@typegoose/typegoose'
import { Base } from '@typegoose/typegoose/lib/defaultClasses'
import { Role } from 'src/roles/role.model'

export interface UserModel extends Base {}

@modelOptions({
	options: {
		allowMixed: 0,
	},
})
export class UserModel {
	@prop({ unique: true })
	login: string

	@prop()
	password: string

	@prop()
	name: string

	@prop({ ref: Role, type: mongoose.Types.ObjectId })
	role: Ref<Role>

	@prop({ default: false })
	isAdmin: boolean

	@prop()
	refreshToken?: string

	@prop({ default: null })
	deletedAt?: Date
}
