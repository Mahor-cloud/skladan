import { ConfigService } from '@nestjs/config'
import { getModelForClass } from '@typegoose/typegoose'
import { genSalt, hash } from 'bcryptjs'
import mongoose from 'mongoose'
import { UserModel } from './auth/user.model'
import { Role } from './roles/role.model'

export async function initializeDatabase(configService: ConfigService) {
	try {
		const mongoUri = configService.get('MONGO_URI')
		if (!mongoUri) {
			throw new Error('MONGODB_URI is not defined in env')
		}

		await mongoose.connect(mongoUri)

		const UserModelClass = getModelForClass(UserModel)
		const RoleModelClass = getModelForClass(Role)

		const requiredPermissions = [
			'view_users',
			'create_users',
			'edit_users',
			'delete_users',
			'create_change_history',
			'view_change_history',
			'create_inventory',
			'view_inventory',
			'edit_inventory',
			'delete_inventory',
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
		]

		let adminRole = await RoleModelClass.findOne({ name: 'Admin' })

		if (!adminRole) {
			adminRole = new RoleModelClass({
				name: 'Admin',
				permissions: requiredPermissions,
			})
			await adminRole.save()
		}

		const hasAllPermissions = requiredPermissions.every((permission) =>
			adminRole.permissions.includes(permission)
		)

		if (!hasAllPermissions) {
			const missingPermissions = requiredPermissions.filter(
				(permission) => !adminRole.permissions.includes(permission)
			)
			adminRole.permissions = [...adminRole.permissions, ...missingPermissions]
			await adminRole.save()
			console.log('Admin role updated with missing permissions.')
		}

		const adminUser = await UserModelClass.findOne({
			role: adminRole._id,
			isAdmin: true,
		})

		if (!adminUser) {
			const salt = await genSalt(6)
			const newAdminUser = new UserModelClass({
				login: 'admin',
				password: await hash('skladansaratov', salt),
				name: 'Председатель',
				role: adminRole._id,
				isAdmin: true,
			})
			await newAdminUser.save()
			console.log('Admin user created successfully.')
		} else {
			console.log('Admin user already exists.')
		}

		mongoose.connection.close()
	} catch (error) {
		console.error('Error initializing database:', error)
	}
}
