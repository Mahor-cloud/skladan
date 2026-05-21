/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { Global, Module } from '@nestjs/common'
import { TypegooseModule } from 'nestjs-typegoose'
import { Counter } from './counter.model'
import { CounterService } from './counter.service'

@Global()
@Module({
	imports: [TypegooseModule.forFeature([Counter])],
	providers: [CounterService],
	exports: [CounterService, TypegooseModule],
})
export class CounterModule {}
