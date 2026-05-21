/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { Connection } from 'mongoose'
import { Logger } from '@nestjs/common'

export interface MigrationContext {
	db: Connection
	logger: Logger
	dryRun: boolean
}

export interface MigrationResult {
	name: string
	changed: number
	wouldChange?: number
	idempotent?: boolean
	durationMs: number
	notes?: string
}

export interface MigrationStep {
	name: string
	description: string
	up: (ctx: MigrationContext) => Promise<MigrationResult>
	down?: (ctx: MigrationContext) => Promise<MigrationResult>
}
