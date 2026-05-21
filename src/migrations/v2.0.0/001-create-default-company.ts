/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { Types } from 'mongoose'
import { MigrationStep, MigrationResult } from './types'

const COMPANIES = 'Company'

export const m001CreateDefaultCompany: MigrationStep = {
	name: '001-create-default-company',
	description: 'Создать Default Company (Местность Саратов) для существующих данных',

	async up(ctx): Promise<MigrationResult> {
		const t0 = Date.now()
		const { db, logger, dryRun } = ctx
		const coll = db.collection(COMPANIES)
		const defaultName = process.env.DEFAULT_COMPANY_NAME || 'Местность Саратов'
		const defaultSlug = process.env.DEFAULT_COMPANY_SLUG || 'saratov'

		const existing = await coll.findOne({ slug: defaultSlug })
		if (existing) {
			logger.log(`Default Company already exists (id=${existing._id})`)
			return { name: '001-create-default-company', changed: 0, idempotent: true, durationMs: Date.now() - t0 }
		}

		if (dryRun) {
			logger.log(`[DRY] Would create Default Company { name: "${defaultName}", slug: "${defaultSlug}" }`)
			return { name: '001-create-default-company', wouldChange: 1, changed: 0, durationMs: Date.now() - t0 }
		}

		const result = await coll.insertOne({
			_id: new Types.ObjectId(),
			name: defaultName,
			slug: defaultSlug,
			isActive: true,
			createdBy: null,
			createdAt: Date.now(),
			deletedAt: null,
			settings: {},
		})
		logger.log(`Created Default Company id=${result.insertedId}`)
		return { name: '001-create-default-company', changed: 1, durationMs: Date.now() - t0 }
	},

	async down(ctx) {
		const t0 = Date.now()
		const slug = process.env.DEFAULT_COMPANY_SLUG || 'saratov'
		const res = await ctx.db.collection(COMPANIES).deleteOne({ slug })
		return { name: '001-create-default-company', changed: res.deletedCount || 0, durationMs: Date.now() - t0 }
	},
}
