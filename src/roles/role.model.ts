/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { modelOptions, mongoose, plugin, prop, Ref } from '@typegoose/typegoose'
import { Base } from '@typegoose/typegoose/lib/defaultClasses'
import { tenantPlugin } from 'src/common/plugins/tenant.plugin'
import { Company } from 'src/company/company.model'

export const ALL_PERMISSIONS = [
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

	'cabinet_access',
	'view_statistics',
	'export_statistics',
	'view-messages',
	'edit-payment-message',
	'edit-received-message',
	'view_all_cabinets',
	'view_cabinet_summary',
	'approve_target_exceed',
] as const

export type Permission = typeof ALL_PERMISSIONS[number]

export interface Role extends Base {}
@plugin(tenantPlugin)
@modelOptions({
	options: {
		allowMixed: 0,
	},
})
export class Role {
	@prop({ ref: Company, type: mongoose.Types.ObjectId, required: true })
	company: Ref<Company>

	@prop()
	name: string

	@prop({ default: false })
	isSystem: boolean

	@prop({
		type: () => [String],
		enum: ALL_PERMISSIONS as unknown as string[],
	})
	permissions: string[]
}
