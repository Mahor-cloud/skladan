/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { applyDecorators, UseGuards } from '@nestjs/common'
import { JwtGuard } from '../guards/jwt.guard'
import { SuperAdminGuard } from '../guards/super-admin.guard'

export const SuperAdminAuth = () =>
	applyDecorators(UseGuards(JwtGuard, SuperAdminGuard))
