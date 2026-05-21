/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { MigrationStep, MigrationResult } from './types'

const ROLES = 'Roles'

export const m004AddIsSystemToRoles: MigrationStep = {
	name: '004-add-isSystem-to-roles',
	description: 'Добавить isSystem:false ко всем ролям, isSystem:true для роли "Admin"',

	async up(ctx): Promise<MigrationResult> {
		const t0 = Date.now()
		const { db, logger, dryRun } = ctx
		const roles = db.collection(ROLES)

		const needFalse = await roles.countDocuments({ isSystem: { $exists: false }, name: { $ne: 'Admin' } })
		const needTrue = await roles.countDocuments({ isSystem: { $exists: false }, name: 'Admin' })

		if (dryRun) {
			logger.log(`[DRY] Roles to mark isSystem:false → ${needFalse}, isSystem:true (Admin) → ${needTrue}`)
			return {
				name: '004-add-isSystem-to-roles',
				wouldChange: needFalse + needTrue,
				changed: 0,
				durationMs: Date.now() - t0,
			}
		}

		const r1 = await roles.updateMany(
			{ isSystem: { $exists: false }, name: { $ne: 'Admin' } },
			{ $set: { isSystem: false } }
		)
		const r2 = await roles.updateMany(
			{ name: 'Admin' },
			{ $set: { isSystem: true } }
		)
		const changed = r1.modifiedCount + r2.modifiedCount
		logger.log(`isSystem:false → ${r1.modifiedCount}, isSystem:true (Admin) → ${r2.modifiedCount}`)
		return { name: '004-add-isSystem-to-roles', changed, durationMs: Date.now() - t0 }
	},
}
