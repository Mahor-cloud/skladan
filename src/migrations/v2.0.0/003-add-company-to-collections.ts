import { MigrationStep, MigrationResult } from './types'

const COMPANIES = 'Company'

const TENANT_COLLECTIONS = [
	'Users',
	'Products',
	'Orders',
	'Purchases',
	'Inventory',
	'Roles',
	'ChangeHistory',
	'Subscriptions',
	'Message',
] as const

export const m003AddCompanyToCollections: MigrationStep = {
	name: '003-add-company-to-collections',
	description: 'Проставить company = DefaultCompany._id во всех per-tenant коллекциях (кроме SuperAdmin)',

	async up(ctx): Promise<MigrationResult> {
		const t0 = Date.now()
		const { db, logger, dryRun } = ctx

		const defaultSlug = process.env.DEFAULT_COMPANY_SLUG || 'saratov'
		const defaultCompany = await db.collection(COMPANIES).findOne({ slug: defaultSlug })
		if (!defaultCompany) {
			throw new Error('Default Company not found — run 001 first')
		}
		const companyId = defaultCompany._id

		let changed = 0
		let wouldChange = 0
		const perColl: Record<string, number> = {}

		for (const collName of TENANT_COLLECTIONS) {
			const coll = db.collection(collName)


			const baseFilter: any = { company: { $exists: false } }
			if (collName === 'Users') baseFilter.isSuperAdmin = { $ne: true }

			const need = await coll.countDocuments(baseFilter)
			if (need === 0) {
				perColl[collName] = 0
				continue
			}
			if (dryRun) {
				wouldChange += need
				perColl[collName] = need
				logger.log(`[DRY] ${collName}: would set company on ${need} docs`)
			} else {
				const res = await coll.updateMany(baseFilter, { $set: { company: companyId } })
				changed += res.modifiedCount
				perColl[collName] = res.modifiedCount
				logger.log(`${collName}: company set on ${res.modifiedCount} docs`)
			}
		}

		return {
			name: '003-add-company-to-collections',
			changed,
			wouldChange: dryRun ? wouldChange : undefined,
			durationMs: Date.now() - t0,
			notes: JSON.stringify(perColl),
		}
	},
}
