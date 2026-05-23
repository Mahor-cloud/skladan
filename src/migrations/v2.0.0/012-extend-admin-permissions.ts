/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { ALL_PERMISSIONS } from '../../roles/role.model'
import { MigrationResult, MigrationStep } from './types'

const ROLES = 'Roles'

export const m012ExtendAdminPermissions: MigrationStep = {
	name: '012-extend-admin-permissions',
	description: 'Установить полный список ALL_PERMISSIONS на ролях isSystem:true (Admin)',

	async up(ctx): Promise<MigrationResult> {
		const t0 = Date.now()
		const { db, logger, dryRun } = ctx
		const roles = db.collection(ROLES)
		const fullList = [...ALL_PERMISSIONS]

		const candidates = await roles.find({ isSystem: true }).toArray()
		const needUpdate = candidates.filter((r: any) => {
			const cur: string[] = Array.isArray(r.permissions) ? r.permissions : []
			if (cur.length !== fullList.length) return true
			return fullList.some((p) => !cur.includes(p))
		})

		if (dryRun) {
			logger.log(`[DRY] Admin roles to extend → ${needUpdate.length}`)
			return {
				name: '012-extend-admin-permissions',
				wouldChange: needUpdate.length,
				changed: 0,
				durationMs: Date.now() - t0,
			}
		}

		if (needUpdate.length === 0) {
			logger.log('All Admin roles already have full ALL_PERMISSIONS list')
			return {
				name: '012-extend-admin-permissions',
				changed: 0,
				durationMs: Date.now() - t0,
			}
		}

		const r = await roles.updateMany(
			{ isSystem: true },
			{ $set: { permissions: fullList } }
		)
		logger.log(`Admin roles updated → ${r.modifiedCount}`)
		return {
			name: '012-extend-admin-permissions',
			changed: r.modifiedCount,
			durationMs: Date.now() - t0,
		}
	},
}
