/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { Module } from '@nestjs/common'
import { TypegooseModule } from 'nestjs-typegoose'
import { AuthModule } from '../auth/auth.module'
import { FeedbackController } from './feedback.controller'
import { FeedbackMessage } from './feedback.model'
import { FeedbackService } from './feedback.service'

@Module({
	// AuthModule — проверка входа и модель местностей (название в сообщении)
	imports: [TypegooseModule.forFeature([FeedbackMessage]), AuthModule],
	controllers: [FeedbackController],
	providers: [FeedbackService],
})
export class FeedbackModule {}
