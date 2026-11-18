/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { Controller, Get } from '@nestjs/common'
import mongoose from 'mongoose'

@Controller('health')
export class HealthController {
	@Get()
	async check() {
		const state = mongoose.connections.some((c) => c.readyState === 1)
			? 1
			: mongoose.connection.readyState
		const dbReady = state === 1
		const lag = await this.measureEventLoopLag()
		// Без входа — только «жив ли»: память, версия Node и число подключений видны супер-админу в «Метриках»
		return {
			status: dbReady && lag < 500 ? 'ok' : 'degraded',
			db: dbReady ? 'connected' : 'down',
			db_state: state,
			uptime_s: Math.round(process.uptime()),
			ts: Date.now(),
		}
	}

	private measureEventLoopLag(): Promise<number> {
		return new Promise((resolve) => {
			const start = process.hrtime.bigint()
			setImmediate(() => {
				const ns = Number(process.hrtime.bigint() - start)
				resolve(ns / 1_000_000)
			})
		})
	}
}
