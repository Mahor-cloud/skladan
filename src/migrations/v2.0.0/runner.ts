import { Logger } from '@nestjs/common'
import { Connection } from 'mongoose'
import { MIGRATIONS_V2_0_0, MIGRATION_VERSION } from './registry'
import { MigrationContext, MigrationResult, MigrationStep } from './types'

const STATE_COLLECTION = 'MigrationState'

export interface RunOptions {
	dryRun?: boolean
	only?: string
}

export async function runMigrationsUp(db: Connection, options: RunOptions = {}): Promise<MigrationResult[]> {
	const logger = new Logger('Migrations')
	const stateColl = db.collection(STATE_COLLECTION)
	const ctx: MigrationContext = { db, logger, dryRun: !!options.dryRun }
	const results: MigrationResult[] = []

	logger.log(`Running migrations${options.dryRun ? ' (DRY-RUN)' : ''}…`)

	for (const step of MIGRATIONS_V2_0_0) {
		if (options.only && step.name !== options.only) continue

		const applied = await stateColl.findOne({ name: step.name })
		if (applied && !options.dryRun) {
			logger.log(`[SKIP] ${step.name} — already applied at ${new Date(applied.appliedAt as number).toISOString()}`)
			continue
		}

		logger.log(`[RUN ] ${step.name} — ${step.description}`)
		try {
			const result = await step.up(ctx)
			results.push(result)
			logger.log(`[DONE] ${step.name} → changed=${result.changed}${result.wouldChange !== undefined ? ` would=${result.wouldChange}` : ''} (${result.durationMs} ms)`)
			if (!options.dryRun) {
				await stateColl.insertOne({
					name: step.name,
					appliedAt: Date.now(),
					version: MIGRATION_VERSION,
					durationMs: result.durationMs,
					notes: result.notes,
				})
			}
		} catch (err: any) {
			if (options.dryRun) {
				logger.warn(`[SKIP] ${step.name} (dry-run): ${err.message}`)
				results.push({ name: step.name, changed: 0, wouldChange: 0, durationMs: 0, notes: `dry-run skip: ${err.message}` })
				continue
			}
			logger.error(`[FAIL] ${step.name}: ${err.message}`)
			logger.error(err.stack)
			throw err
		}
	}

	logger.log(`Migrations done. ${results.length} steps executed.`)
	return results
}

export async function listMigrationStatus(db: Connection): Promise<Array<{ name: string; description: string; applied: boolean; appliedAt?: number }>> {
	const stateColl = db.collection(STATE_COLLECTION)
	const applied = await stateColl.find({}).toArray()
	const appliedMap = new Map<string, any>(applied.map((m: any) => [m.name, m]))
	return MIGRATIONS_V2_0_0.map((step: MigrationStep) => ({
		name: step.name,
		description: step.description,
		applied: appliedMap.has(step.name),
		appliedAt: appliedMap.get(step.name)?.appliedAt,
	}))
}

export async function rollbackMigration(db: Connection, name: string): Promise<MigrationResult | null> {
	const logger = new Logger('Migrations')
	const step = MIGRATIONS_V2_0_0.find((s) => s.name === name)
	if (!step) throw new Error(`Unknown migration: ${name}`)
	if (!step.down) {
		logger.warn(`Migration ${name} has no down() — manual rollback required`)
		return null
	}
	const ctx: MigrationContext = { db, logger, dryRun: false }
	const result = await step.down(ctx)
	await db.collection(STATE_COLLECTION).deleteOne({ name })
	logger.log(`[ROLLBACK] ${name} → ${result.changed} reverted`)
	return result
}
