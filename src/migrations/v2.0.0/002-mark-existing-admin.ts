import { genSalt, hash } from 'bcryptjs'
import { Types } from 'mongoose'
import { MigrationStep, MigrationResult } from './types'

const USERS = 'Users'
const COMPANIES = 'Company'

export const m002MarkExistingAdmin: MigrationStep = {
	name: '002-mark-existing-admin-and-create-superadmin',
	description: 'Создать SuperAdmin (env-based) + пометить isSuperAdmin/isAdmin на существующих юзерах',

	async up(ctx): Promise<MigrationResult> {
		const t0 = Date.now()
		const { db, logger, dryRun } = ctx
		const users = db.collection(USERS)
		const companies = db.collection(COMPANIES)

		const defaultSlug = process.env.DEFAULT_COMPANY_SLUG || 'saratov'
		const defaultCompany = await companies.findOne({ slug: defaultSlug })
		if (!defaultCompany) {
			throw new Error('Default Company not found — run 001 first')
		}

		const superLogin = process.env.SUPER_ADMIN_LOGIN || 'superadmin'
		const superPassword = process.env.SUPER_ADMIN_PASSWORD
		if (!superPassword) {
			throw new Error('SUPER_ADMIN_PASSWORD env var is required for migration 002')
		}

		let changed = 0
		let wouldChange = 0


		const setFalseFilter = { isSuperAdmin: { $exists: false } }
		if (dryRun) {
			wouldChange += await users.countDocuments(setFalseFilter)
		} else {
			const res = await users.updateMany(setFalseFilter, { $set: { isSuperAdmin: false } })
			changed += res.modifiedCount
		}


		const existingSuper = await users.findOne({ login: superLogin, isSuperAdmin: true })
		if (existingSuper) {
			logger.log(`SuperAdmin "${superLogin}" already exists (id=${existingSuper._id})`)
		} else {
			if (dryRun) {
				logger.log(`[DRY] Would create SuperAdmin login="${superLogin}"`)
				wouldChange += 1
			} else {
				const salt = await genSalt(12)
				const hashed = await hash(superPassword, salt)
				const result = await users.insertOne({
					_id: new Types.ObjectId(),
					login: superLogin,
					password: hashed,
					name: 'Super Admin',
					role: null,
					isAdmin: false,
					isSuperAdmin: true,
					company: null,
					refreshToken: null,
					deletedAt: null,
				})
				logger.log(`Created SuperAdmin id=${result.insertedId}`)
				changed += 1
			}
		}

		return {
			name: '002-mark-existing-admin-and-create-superadmin',
			changed,
			wouldChange: dryRun ? wouldChange : undefined,
			durationMs: Date.now() - t0,
		}
	},
}
