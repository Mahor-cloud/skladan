/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { Global, Module } from '@nestjs/common'
import { TenantContextService } from './tenant-context.service'

@Global()
@Module({
	providers: [TenantContextService],
	exports: [TenantContextService],
})
export class TenantContextModule {}
