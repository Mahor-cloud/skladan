import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { Connection } from 'mongoose'
import { getConnectionToken } from 'nestjs-typegoose'
import { AppModule } from '../../app.module'
import { listMigrationStatus, rollbackMigration, runMigrationsUp } from './runner'

async function main() {
	const logger = new Logger('migrate-cli')
	const args = process.argv.slice(2)
	const command = args[0]
	const dryRun = args.includes('--dry-run')
	const onlyIdx = args.indexOf('--only')
	const only = onlyIdx >= 0 ? args[onlyIdx + 1] : undefined

	if (!command || !['up', 'status', 'rollback', 'help'].includes(command)) {
		console.log('Usage:')
		console.log('  node dist/migrations/v2.0.0/cli.js up [--dry-run] [--only <name>]')
		console.log('  node dist/migrations/v2.0.0/cli.js status')
		console.log('  node dist/migrations/v2.0.0/cli.js rollback <name>')
		process.exit(command === 'help' ? 0 : 1)
	}

	const app = await NestFactory.createApplicationContext(AppModule, { logger: ['log', 'error', 'warn'] })
	const connection: Connection = app.get(getConnectionToken())

	try {
		if (command === 'up') {
			const results = await runMigrationsUp(connection, { dryRun, only })
			logger.log(`\n=== Summary ===`)
			for (const r of results) {
				logger.log(` - ${r.name}: changed=${r.changed}${r.wouldChange !== undefined ? ` would=${r.wouldChange}` : ''} (${r.durationMs} ms)`)
			}
		} else if (command === 'status') {
			const status = await listMigrationStatus(connection)
			logger.log(`\n=== Migration status ===`)
			for (const s of status) {
				const mark = s.applied ? '✓' : '·'
				const when = s.appliedAt ? new Date(s.appliedAt).toISOString() : ''
				logger.log(`  ${mark} ${s.name.padEnd(45)} ${when}`)
			}
		} else if (command === 'rollback') {
			const name = args[1]
			if (!name) {
				logger.error('Provide migration name to rollback')
				process.exit(1)
			}
			await rollbackMigration(connection, name)
		}
	} catch (err: any) {
		logger.error(`Migration failed: ${err.message}`)
		console.error(err)
		await app.close()
		process.exit(1)
	}

	await app.close()
	process.exit(0)
}

main()
