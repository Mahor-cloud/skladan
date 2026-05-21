/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { Types } from 'mongoose'

let mockContext: { company?: string; bypass?: boolean } | null = null

jest.mock('../tenant-context/tenant-context.storage', () => ({
	getTenantContext: () => mockContext,
}))

import { tenantPlugin } from './tenant.plugin'

type HookFn = (this: any, next?: (err?: Error) => void, ...args: any[]) => void

interface FakeSchema {
	hooks: Map<string, HookFn[]>
	pre(hook: string, fn: HookFn): void
	triggerPre(hook: string, ctx: any, ...extraArgs: any[]): Promise<void>
}

function makeFakeSchema(): FakeSchema {
	const hooks = new Map<string, HookFn[]>()
	return {
		hooks,
		pre(hook: string, fn: HookFn) {
			if (!hooks.has(hook)) hooks.set(hook, [])
			hooks.get(hook)!.push(fn)
		},
		async triggerPre(hook: string, ctx: any, ...extraArgs: any[]) {
			const fns = hooks.get(hook) || []
			for (const fn of fns) {
				await new Promise<void>((resolve, reject) => {

					if (hook === 'save' || hook === 'insertMany') {
						fn.call(ctx, (err?: Error) => {
							if (err) reject(err)
							else resolve()
						}, ...extraArgs)
					} else {
						fn.call(ctx)
						resolve()
					}
				})
			}
		},
	}
}

function makeQueryCtx(overrides: {
	skipTenantScope?: boolean
	existingCompanyFilter?: boolean
} = {}) {
	const conditions: any = {}
	if (overrides.existingCompanyFilter) {
		conditions.company = 'already-set'
	}

	return {
		_conditions: conditions,
		_where: [] as any[],
		options: overrides.skipTenantScope ? { skipTenantScope: true } : {},
		getOptions() { return this.options },
		getFilter() { return this._conditions },
		where(filter: any) {
			Object.assign(this._conditions, filter)
		},
	}
}

describe('tenantPlugin — find/query hooks', () => {
	const COMPANY_ID = new Types.ObjectId().toString()

	beforeEach(() => {
		mockContext = { company: COMPANY_ID }
	})

	afterEach(() => {
		mockContext = null
	})

	it('adds company filter on find when context has company', async () => {
		const schema = makeFakeSchema()
		tenantPlugin(schema as any)

		const ctx = makeQueryCtx()
		await schema.triggerPre('find', ctx)

		expect(ctx._conditions.company).toEqual(new Types.ObjectId(COMPANY_ID))
	})

	it('adds company filter on findOne when context has company', async () => {
		const schema = makeFakeSchema()
		tenantPlugin(schema as any)

		const ctx = makeQueryCtx()
		await schema.triggerPre('findOne', ctx)

		expect(ctx._conditions.company).toBeDefined()
	})

	it('does NOT add company filter when ctx.bypass is true', async () => {
		mockContext = { company: COMPANY_ID, bypass: true }
		const schema = makeFakeSchema()
		tenantPlugin(schema as any)

		const ctx = makeQueryCtx()
		await schema.triggerPre('find', ctx)

		expect(ctx._conditions.company).toBeUndefined()
	})

	it('does NOT add company filter when context is null (out-of-request)', async () => {
		mockContext = null
		const schema = makeFakeSchema()
		tenantPlugin(schema as any)

		const ctx = makeQueryCtx()
		await schema.triggerPre('find', ctx)

		expect(ctx._conditions.company).toBeUndefined()
	})

	it('does NOT add company filter when skipTenantScope option is set', async () => {
		const schema = makeFakeSchema()
		tenantPlugin(schema as any)

		const ctx = makeQueryCtx({ skipTenantScope: true })
		await schema.triggerPre('find', ctx)

		expect(ctx._conditions.company).toBeUndefined()
	})

	it('does NOT overwrite existing company filter already in query', async () => {
		const schema = makeFakeSchema()
		tenantPlugin(schema as any)

		const ctx = makeQueryCtx({ existingCompanyFilter: true })
		await schema.triggerPre('find', ctx)


		expect(ctx._conditions.company).toBe('already-set')
	})

	it('does NOT add company filter when ctx.company is empty string', async () => {
		mockContext = { company: '' }
		const schema = makeFakeSchema()
		tenantPlugin(schema as any)

		const ctx = makeQueryCtx()
		await schema.triggerPre('find', ctx)

		expect(ctx._conditions.company).toBeUndefined()
	})
})

describe('tenantPlugin — save hook', () => {
	const COMPANY_ID = new Types.ObjectId().toString()

	beforeEach(() => {
		mockContext = { company: COMPANY_ID }
	})

	afterEach(() => {
		mockContext = null
	})

	it('sets company on new document during save', async () => {
		const schema = makeFakeSchema()
		tenantPlugin(schema as any)

		const doc: any = { isNew: true, company: undefined, $locals: {} }
		await schema.triggerPre('save', doc)

		expect(doc.company).toEqual(new Types.ObjectId(COMPANY_ID))
	})

	it('does NOT set company on existing (non-new) document during save', async () => {
		const schema = makeFakeSchema()
		tenantPlugin(schema as any)

		const doc: any = { isNew: false, company: undefined, $locals: {} }
		await schema.triggerPre('save', doc)

		expect(doc.company).toBeUndefined()
	})

	it('does NOT overwrite existing company on new document', async () => {
		const schema = makeFakeSchema()
		tenantPlugin(schema as any)

		const existingId = new Types.ObjectId()
		const doc: any = { isNew: true, company: existingId, $locals: {} }
		await schema.triggerPre('save', doc)

		expect(doc.company).toBe(existingId)
	})

	it('does NOT set company when context is null', async () => {
		mockContext = null
		const schema = makeFakeSchema()
		tenantPlugin(schema as any)

		const doc: any = { isNew: true, company: undefined, $locals: {} }
		await schema.triggerPre('save', doc)

		expect(doc.company).toBeUndefined()
	})

	it('does NOT set company when ctx.bypass is true', async () => {
		mockContext = { company: COMPANY_ID, bypass: true }
		const schema = makeFakeSchema()
		tenantPlugin(schema as any)

		const doc: any = { isNew: true, company: undefined, $locals: {} }
		await schema.triggerPre('save', doc)

		expect(doc.company).toBeUndefined()
	})
})

describe('tenantPlugin — insertMany hook', () => {
	const COMPANY_ID = new Types.ObjectId().toString()

	beforeEach(() => {
		mockContext = { company: COMPANY_ID }
	})

	afterEach(() => {
		mockContext = null
	})

	it('sets company on each doc in insertMany when context has company', async () => {
		const schema = makeFakeSchema()
		tenantPlugin(schema as any)

		const docs = [{ name: 'A' }, { name: 'B' }]
		await schema.triggerPre('insertMany', {}, docs)

		const expected = new Types.ObjectId(COMPANY_ID)
		for (const doc of docs) {
			expect((doc as any).company).toEqual(expected)
		}
	})

	it('does NOT set company on docs when skipTenantScope=true in options', async () => {
		const schema = makeFakeSchema()
		tenantPlugin(schema as any)

		const docs = [{ name: 'X' }]
		await schema.triggerPre('insertMany', {}, docs, { skipTenantScope: true })

		expect((docs[0] as any).company).toBeUndefined()
	})

	it('does NOT overwrite existing company on docs in insertMany', async () => {
		const schema = makeFakeSchema()
		tenantPlugin(schema as any)

		const existingId = new Types.ObjectId()
		const docs = [{ name: 'Y', company: existingId }]
		await schema.triggerPre('insertMany', {}, docs)

		expect((docs[0] as any).company).toBe(existingId)
	})

	it('does NOT set company when context is null', async () => {
		mockContext = null
		const schema = makeFakeSchema()
		tenantPlugin(schema as any)

		const docs = [{ name: 'Z' }]
		await schema.triggerPre('insertMany', {}, docs)

		expect((docs[0] as any).company).toBeUndefined()
	})

	it('does NOT set company when ctx.bypass is true', async () => {
		mockContext = { company: COMPANY_ID, bypass: true }
		const schema = makeFakeSchema()
		tenantPlugin(schema as any)

		const docs = [{ name: 'W' }]
		await schema.triggerPre('insertMany', {}, docs)

		expect((docs[0] as any).company).toBeUndefined()
	})
})
