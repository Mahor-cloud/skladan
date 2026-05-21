import { Injectable } from '@nestjs/common'
import { tenantContextStorage, TenantContext, getTenantContext } from './tenant-context.storage'

export { TenantContext } from './tenant-context.storage'

@Injectable()
export class TenantContextService {
	run<T>(ctx: TenantContext, fn: () => T): T {
		return tenantContextStorage.run(ctx, fn)
	}

	runAsSuperAdmin<T>(fn: () => T): T {
		return tenantContextStorage.run({ company: null, isSuperAdmin: true, userId: null, bypass: true }, fn)
	}

	get(): TenantContext | null {
		return getTenantContext()
	}

	requireCompany(): string {
		const ctx = this.get()
		if (!ctx || !ctx.company) {
			throw new Error('Tenant context is missing — company scope cannot be determined')
		}
		return ctx.company
	}

	isBypass(): boolean {
		return this.get()?.bypass === true
	}
}
