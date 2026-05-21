

import { BadRequestException } from '@nestjs/common'

type UpdateOneFn = (filter: any, update: any) => Promise<void>

async function applyCompletion(
	items: { product: any; newQuantity: number; quantity: number }[],
	updateOne: UpdateOneFn
): Promise<void> {
	for (const item of items) {
		await updateOne({ _id: item.product }, { $set: { quantity: item.newQuantity } })
	}
}

async function applyDeltas(
	newItems: { product: any; newQuantity: number; quantity: number }[],
	oldMap: Map<string, { newQuantity: number; quantity: number }>,
	updateOne: UpdateOneFn
): Promise<void> {
	for (const item of newItems) {
		const pid = String(item.product?._id || item.product)
		const oldNew = oldMap.get(pid)?.newQuantity ?? 0
		const delta = (item.newQuantity || 0) - oldNew
		if (delta === 0) continue
		await updateOne({ _id: pid }, { $inc: { quantity: delta } })
	}
}

async function reverseCompletion(
	items: { product: any; newQuantity: number; quantity: number }[],
	updateOne: UpdateOneFn
): Promise<void> {
	for (const item of items) {
		const pid = String(item.product?._id || item.product)
		const effect = (item.newQuantity || 0) - (item.quantity || 0)
		if (effect === 0) continue
		await updateOne({ _id: pid }, { $inc: { quantity: -effect } })
	}
}

async function assertNoSubsequentInventory(
	current: { _id: any; startDate: number },
	findOne: (filter: any) => Promise<any>
): Promise<void> {
	const subsequent = await findOne({
		startDate: { $gt: current.startDate },
		_id: { $ne: current._id },
	})
	if (subsequent) {
		throw new BadRequestException(
			'Нельзя изменить/удалить инвентаризацию: есть более поздняя инвентаризация.'
		)
	}
}

describe('applyCompletion', () => {
	it('calls updateOne with $set quantity = newQuantity for each item', async () => {
		const calls: any[] = []
		const updateOne: UpdateOneFn = async (filter, update) => {
			calls.push({ filter, update })
		}

		const items = [
			{ product: 'p1', newQuantity: 15, quantity: 10 },
			{ product: 'p2', newQuantity: 0, quantity: 5 },
		]

		await applyCompletion(items, updateOne)

		expect(calls).toHaveLength(2)
		expect(calls[0]).toEqual({
			filter: { _id: 'p1' },
			update: { $set: { quantity: 15 } },
		})
		expect(calls[1]).toEqual({
			filter: { _id: 'p2' },
			update: { $set: { quantity: 0 } },
		})
	})

	it('sets quantity to newQuantity even when newQuantity is zero', async () => {
		const calls: any[] = []
		const updateOne: UpdateOneFn = async (f, u) => { calls.push(u) }

		await applyCompletion([{ product: 'p1', newQuantity: 0, quantity: 100 }], updateOne)

		expect(calls[0]).toEqual({ $set: { quantity: 0 } })
	})

	it('does not call updateOne when items array is empty', async () => {
		const calls: any[] = []
		const updateOne: UpdateOneFn = async (f, u) => { calls.push(u) }

		await applyCompletion([], updateOne)

		expect(calls).toHaveLength(0)
	})
})

describe('applyDeltas', () => {
	it('calls updateOne with positive delta when newQuantity increased', async () => {
		const calls: any[] = []
		const updateOne: UpdateOneFn = async (f, u) => { calls.push({ f, u }) }

		const oldMap = new Map([['p1', { newQuantity: 10, quantity: 8 }]])
		const newItems = [{ product: 'p1', newQuantity: 15, quantity: 8 }]

		await applyDeltas(newItems, oldMap, updateOne)

		expect(calls).toHaveLength(1)
		expect(calls[0].u).toEqual({ $inc: { quantity: 5 } })
	})

	it('calls updateOne with negative delta when newQuantity decreased', async () => {
		const calls: any[] = []
		const updateOne: UpdateOneFn = async (f, u) => { calls.push(u) }

		const oldMap = new Map([['p1', { newQuantity: 10, quantity: 8 }]])
		const newItems = [{ product: 'p1', newQuantity: 3, quantity: 8 }]

		await applyDeltas(newItems, oldMap, updateOne)

		expect(calls[0]).toEqual({ $inc: { quantity: -7 } })
	})

	it('skips updateOne when delta is zero (no change)', async () => {
		const calls: any[] = []
		const updateOne: UpdateOneFn = async (f, u) => { calls.push(u) }

		const oldMap = new Map([['p1', { newQuantity: 10, quantity: 8 }]])
		const newItems = [{ product: 'p1', newQuantity: 10, quantity: 8 }]

		await applyDeltas(newItems, oldMap, updateOne)

		expect(calls).toHaveLength(0)
	})

	it('treats missing entry in oldMap as oldNewQuantity=0 (new product in re-edit)', async () => {
		const calls: any[] = []
		const updateOne: UpdateOneFn = async (f, u) => { calls.push(u) }

		const oldMap = new Map<string, { newQuantity: number; quantity: number }>()
		const newItems = [{ product: 'p1', newQuantity: 7, quantity: 5 }]

		await applyDeltas(newItems, oldMap, updateOne)

		expect(calls[0]).toEqual({ $inc: { quantity: 7 } })
	})

	it('handles multiple items with mixed deltas', async () => {
		const calls: any[] = []
		const updateOne: UpdateOneFn = async (f, u) => { calls.push(u) }

		const oldMap = new Map([
			['p1', { newQuantity: 5, quantity: 3 }],
			['p2', { newQuantity: 10, quantity: 10 }],
			['p3', { newQuantity: 8, quantity: 8 }],
		])
		const newItems = [
			{ product: 'p1', newQuantity: 10, quantity: 3 },
			{ product: 'p2', newQuantity: 10, quantity: 10 },
			{ product: 'p3', newQuantity: 2, quantity: 8 },
		]

		await applyDeltas(newItems, oldMap, updateOne)

		expect(calls).toHaveLength(2)
		expect(calls[0]).toEqual({ $inc: { quantity: 5 } })
		expect(calls[1]).toEqual({ $inc: { quantity: -6 } })
	})
})

describe('reverseCompletion', () => {
	it('reverses positive effect (newQty > original): decrements product.quantity', async () => {
		const calls: any[] = []
		const updateOne: UpdateOneFn = async (f, u) => { calls.push(u) }


		const items = [{ product: 'p1', newQuantity: 20, quantity: 10 }]

		await reverseCompletion(items, updateOne)

		expect(calls[0]).toEqual({ $inc: { quantity: -10 } })
	})

	it('reverses negative effect (newQty < original): increments product.quantity', async () => {
		const calls: any[] = []
		const updateOne: UpdateOneFn = async (f, u) => { calls.push(u) }


		const items = [{ product: 'p1', newQuantity: 5, quantity: 10 }]

		await reverseCompletion(items, updateOne)

		expect(calls[0]).toEqual({ $inc: { quantity: 5 } })
	})

	it('skips items where newQuantity equals quantity (zero effect)', async () => {
		const calls: any[] = []
		const updateOne: UpdateOneFn = async (f, u) => { calls.push(u) }

		const items = [{ product: 'p1', newQuantity: 10, quantity: 10 }]

		await reverseCompletion(items, updateOne)

		expect(calls).toHaveLength(0)
	})

	it('handles multiple items correctly', async () => {
		const calls: any[] = []
		const updateOne: UpdateOneFn = async (f, u) => { calls.push(u) }

		const items = [
			{ product: 'p1', newQuantity: 15, quantity: 5 },
			{ product: 'p2', newQuantity: 5, quantity: 5 },
			{ product: 'p3', newQuantity: 3, quantity: 10 },
		]

		await reverseCompletion(items, updateOne)

		expect(calls).toHaveLength(2)
		expect(calls[0]).toEqual({ $inc: { quantity: -10 } })
		expect(calls[1]).toEqual({ $inc: { quantity: 7 } })
	})
})

describe('assertNoSubsequentInventory', () => {
	it('throws when a subsequent inventory exists', async () => {
		const current = { _id: 'inv1', startDate: 1000 }
		const findOne = jest.fn().mockResolvedValue({ _id: 'inv2', startDate: 2000 })

		await expect(assertNoSubsequentInventory(current, findOne)).rejects.toThrow(
			'Нельзя изменить/удалить инвентаризацию: есть более поздняя инвентаризация.'
		)
	})

	it('does not throw when no subsequent inventory exists', async () => {
		const current = { _id: 'inv1', startDate: 1000 }
		const findOne = jest.fn().mockResolvedValue(null)

		await expect(assertNoSubsequentInventory(current, findOne)).resolves.toBeUndefined()
	})

	it('queries with startDate $gt current.startDate and excludes current._id', async () => {
		const current = { _id: 'inv1', startDate: 5000 }
		const findOne = jest.fn().mockResolvedValue(null)

		await assertNoSubsequentInventory(current, findOne)

		expect(findOne).toHaveBeenCalledWith({
			startDate: { $gt: 5000 },
			_id: { $ne: 'inv1' },
		})
	})
})
