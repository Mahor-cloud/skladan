
import { Schema, Types } from 'mongoose'
import { getTenantContext } from '../tenant-context/tenant-context.storage'

const FIND_HOOKS = [
	'count',
	'countDocuments',
	'estimatedDocumentCount',
	'find',
	'findOne',
	'findOneAndDelete',
	'findOneAndRemove',
	'findOneAndReplace',
	'findOneAndUpdate',
	'deleteOne',
	'deleteMany',
	'replaceOne',
	'updateOne',
	'updateMany',
] as const

export function tenantPlugin(schema: Schema) {
	FIND_HOOKS.forEach((hook) => {
		schema.pre(hook as any, function (this: any) {
			if (this.getOptions && this.getOptions().skipTenantScope) return
			const ctx = getTenantContext()
			if (!ctx) return
			if (ctx.bypass) return
			if (!ctx.company) return
			const filter = this.getFilter ? this.getFilter() : (this._conditions || {})
			if (filter.company === undefined) {
				this.where({ company: new Types.ObjectId(ctx.company) })
			}
		})
	})

	schema.pre('aggregate' as any, function (this: any) {
		const opts = this.options || {}
		if (opts.skipTenantScope) return
		const ctx = getTenantContext()
		if (!ctx) return
		if (ctx.bypass) return
		if (!ctx.company) return
		const pipeline = this.pipeline()
		pipeline.unshift({ $match: { company: new Types.ObjectId(ctx.company) } })
	})

	schema.pre('save', function (this: any, next: (err?: Error) => void) {
		if (!this.isNew) return next()
		if (this.$locals?.skipTenantScope) return next()
		const ctx = getTenantContext()
		if (!ctx) return next()
		if (ctx.bypass) return next()
		if (!ctx.company) return next()
		if (!this.company) {
			this.company = new Types.ObjectId(ctx.company)
		}
		next()
	})

	schema.pre('insertMany' as any, function (
		this: any,
		next: (err?: Error) => void,
		docs: any[],
		options?: any
	) {
		try {
			if (options?.skipTenantScope) return next()
			const ctx = getTenantContext()
			if (!ctx) return next()
			if (ctx.bypass) return next()
			if (!ctx.company) return next()
			if (!Array.isArray(docs)) return next()
			const tenantOid = new Types.ObjectId(ctx.company)
			for (const d of docs) {
				if (!d) continue
				if (!d.company) d.company = tenantOid
			}
			next()
		} catch (e) {
			next(e as Error)
		}
	})
}
