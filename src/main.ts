/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { ValidationPipe } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import * as cors from 'cors'
import { AppModule } from './app.module'

async function bootstrap() {
	const app = await NestFactory.create(AppModule)
	app.setGlobalPrefix('api')

	app.useGlobalPipes(
		new ValidationPipe({
			whitelist: true,
			forbidNonWhitelisted: true,
			transform: true,
			transformOptions: { enableImplicitConversion: false },
		})
	)

	const isProd = process.env.NODE_ENV === 'production'
	const envOrigins = (process.env.CORS_ORIGINS || '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)

	const defaultDevOrigins = [
		'http://localhost:5173',
		'http://localhost:5300',
		'http://127.0.0.1:5173',
		'http://127.0.0.1:5300',
	]

	let allowList: string[]
	if (isProd) {
		if (!envOrigins.length) {
			throw new Error('CORS_ORIGINS must be set in production')
		}
		allowList = envOrigins
	} else {
		allowList = envOrigins.length ? envOrigins : defaultDevOrigins
	}

	app.use(
		cors({
			origin: (origin, callback) => {

				if (!origin) return callback(null, true)
				if (allowList.includes(origin)) return callback(null, true)
				return callback(new Error(`CORS: origin ${origin} not allowed`))
			},
			methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
			allowedHeaders: ['Content-Type', 'Authorization'],
			credentials: true,
		})
	)
	await app.listen(4300)
}
bootstrap()
