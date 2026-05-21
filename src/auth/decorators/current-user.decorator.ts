/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { createParamDecorator, ExecutionContext } from '@nestjs/common'

export const CurrentUser = createParamDecorator(
	(data: unknown, ctx: ExecutionContext) => {
		const request = ctx.switchToHttp().getRequest()
		return request.user
	}
)
