import { modelOptions, prop } from '@typegoose/typegoose'
import { Base } from '@typegoose/typegoose/lib/defaultClasses'

export interface Role extends Base {}
@modelOptions({
	options: {
		allowMixed: 0,
	},
})
export class Role {
	@prop({ unique: true })
	name: string

	@prop({
		type: () => [String],
		enum: [
			'view_users',
			'create_users',
			'edit_users',
			'delete_users',
			'create_change_history',
			'view_change_history',
			'create_inventory',
			'view_inventory',
			'delete_inventory',
			'edit_inventory',
			'create_orders',
			'view_orders',
			'edit_orders',
			'delete_orders',
			'create_purchases',
			'view_purchases',
			'edit_purchases',
			'delete_purchases',
			'create_product',
			'view_products',
			'edit_products',
			'delete_products',
			'create_role',
			'view_roles',
			'edit_roles',
			'delete_roles',
			'export-database',
			'import-database',
			'approve-payment',
		],
	})
	permissions: string[]
}
