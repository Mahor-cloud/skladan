/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common'
import { Observable } from 'rxjs'
import { tenantContextStorage } from './tenant-context.storage'

@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
	intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
		const request = context.switchToHttp().getRequest<any>()
		const user = request?.user

		if (!user) {
			return next.handle()
		}

		const isSuperAdmin = !!user.isSuperAdmin
		const company = user.company ? String(user.company) : null
		const userId = user._id ? String(user._id) : null

		return new Observable((subscriber) => {
			tenantContextStorage.run(
				{
					company,
					isSuperAdmin,
					userId,
					bypass: isSuperAdmin && !company,
				},
				() => {
					next.handle().subscribe({
						next: (v) => subscriber.next(v),
						error: (e) => subscriber.error(e),
						complete: () => subscriber.complete(),
					})
				}
			)
		})
	}
}
