/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { AsyncLocalStorage } from 'async_hooks'

export interface TenantContext {
	company: string | null
	isSuperAdmin: boolean
	userId: string | null
	bypass: boolean
}

export const tenantContextStorage = new AsyncLocalStorage<TenantContext>()

export function getTenantContext(): TenantContext | null {
	return tenantContextStorage.getStore() ?? null
}
