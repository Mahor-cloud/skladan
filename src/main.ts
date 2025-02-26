import { NestFactory } from '@nestjs/core'
import * as cors from 'cors'
import { AppModule } from './app.module'

async function bootstrap() {
	const app = await NestFactory.create(AppModule)
	app.setGlobalPrefix('api')
	app.use(
		cors({
			origin: '*',
			methods: ['GET', 'POST', 'PUT', 'DELETE'],
			allowedHeaders: ['Content-Type', 'Authorization'],
		})
	)
	await app.listen(4300)
}
bootstrap()
