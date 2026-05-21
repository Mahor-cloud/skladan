

import { BadRequestException } from '@nestjs/common'

type StockItem = { product: string; quantity: number }
type ProductLike = { _id: any; name: string; quantity: number; targetQty?: number }

async function assertStockAvailable(
	items: StockItem[],
	productById: Map<string, ProductLike>,
	committedQty: Record<string, number>
): Promise<void> {
	for (const item of items) {
		const product = productById.get(String(item.product))
		if (!product) {
			throw new BadRequestException({
				code: 'PRODUCT_NOT_FOUND',
				product: String(item.product),
				message: `Товар ${item.product} не найден в вашей компании`,
			})
		}
		if (!item.quantity || item.quantity < 1) {
			throw new BadRequestException({
				code: 'INVALID_QUANTITY',
				product: String(product._id),
				productName: product.name,
				message: `Количество товара "${product.name}" должно быть не меньше 1`,
			})
		}
		const available = (product.quantity || 0) - (committedQty[String(item.product)] || 0)
		if (item.quantity > available) {
			throw new BadRequestException({
				code: 'INSUFFICIENT_STOCK',
				product: String(product._id),
				productName: product.name,
				requested: item.quantity,
				available,
				message: `Недостаточно товара "${product.name}" на складе: запрошено ${item.quantity}, доступно ${available}.`,
			})
		}
	}
}

function itemsEqual(
	a: { product: any; quantity: number }[] | undefined,
	b: { product: any; quantity: number }[] | undefined
): boolean {
	if (!a || !b) return false
	if (a.length !== b.length) return false
	const norm = (arr: any[]) =>
		arr
			.map((i) => ({
				p: String(i.product?._id || i.product),
				q: i.quantity || 0,
			}))
			.sort((x, y) => x.p.localeCompare(y.p))
	const an = norm(a as any)
	const bn = norm(b as any)
	for (let i = 0; i < an.length; i++) {
		if (an[i].p !== bn[i].p || an[i].q !== bn[i].q) return false
	}
	return true
}

function guardConfirmedPaidWithoutIsPaid(
	updateDto: { confirmedPaid?: boolean; isPaid?: boolean },
	oldOrder: { isPaid: boolean }
): void {
	if (updateDto.confirmedPaid === true && !oldOrder.isPaid && updateDto.isPaid !== true) {
		throw new BadRequestException(
			'Нельзя подтвердить оплату до того, как заказ отмечен как оплаченный'
		)
	}
}

function guardCompleteWithoutConfirmedPaid(
	updateDto: { isCompleted?: boolean; confirmedPaid?: boolean },
	oldOrder: { confirmedPaid: boolean }
): void {
	if (
		updateDto.isCompleted === true &&
		!oldOrder.confirmedPaid &&
		updateDto.confirmedPaid !== true
	) {
		throw new BadRequestException(
			'Нельзя завершить заказ до подтверждения оплаты казначеем'
		)
	}
}

function guardIsPaidRevert(
	updateDto: { isPaid?: boolean },
	oldOrder: { isPaid: boolean }
): void {
	if (updateDto.isPaid === false && oldOrder.isPaid) {
		throw new BadRequestException(
			'Отметку «оплачен» нельзя снять. Если нужна корректировка — отмените заказ или измените позиции'
		)
	}
}

describe('assertStockAvailable', () => {
	const makeProduct = (id: string, name: string, quantity: number): ProductLike => ({
		_id: id,
		name,
		quantity,
	})

	it('throws PRODUCT_NOT_FOUND when product is not in productById map', async () => {
		const items: StockItem[] = [{ product: 'unknown-id', quantity: 1 }]
		const productById = new Map<string, ProductLike>()

		await expect(assertStockAvailable(items, productById, {})).rejects.toMatchObject({
			response: expect.objectContaining({ code: 'PRODUCT_NOT_FOUND' }),
		})
	})

	it('throws INVALID_QUANTITY when quantity is zero', async () => {
		const product = makeProduct('p1', 'Молоко', 10)
		const productById = new Map([['p1', product]])
		const items: StockItem[] = [{ product: 'p1', quantity: 0 }]

		await expect(assertStockAvailable(items, productById, {})).rejects.toMatchObject({
			response: expect.objectContaining({ code: 'INVALID_QUANTITY' }),
		})
	})

	it('throws INVALID_QUANTITY when quantity is negative', async () => {
		const product = makeProduct('p1', 'Молоко', 10)
		const productById = new Map([['p1', product]])
		const items: StockItem[] = [{ product: 'p1', quantity: -5 }]

		await expect(assertStockAvailable(items, productById, {})).rejects.toMatchObject({
			response: expect.objectContaining({ code: 'INVALID_QUANTITY' }),
		})
	})

	it('throws INSUFFICIENT_STOCK when requested exceeds available', async () => {
		const product = makeProduct('p1', 'Хлеб', 5)
		const productById = new Map([['p1', product]])
		const items: StockItem[] = [{ product: 'p1', quantity: 10 }]

		await expect(assertStockAvailable(items, productById, {})).rejects.toMatchObject({
			response: expect.objectContaining({
				code: 'INSUFFICIENT_STOCK',
				requested: 10,
				available: 5,
			}),
		})
	})

	it('throws INSUFFICIENT_STOCK when committed qty reduces available below requested', async () => {
		const product = makeProduct('p1', 'Сахар', 10)
		const productById = new Map([['p1', product]])
		const items: StockItem[] = [{ product: 'p1', quantity: 8 }]

		const committed = { p1: 4 }

		await expect(assertStockAvailable(items, productById, committed)).rejects.toMatchObject({
			response: expect.objectContaining({
				code: 'INSUFFICIENT_STOCK',
				requested: 8,
				available: 6,
			}),
		})
	})

	it('passes when requested equals exactly available (boundary)', async () => {
		const product = makeProduct('p1', 'Масло', 10)
		const productById = new Map([['p1', product]])
		const items: StockItem[] = [{ product: 'p1', quantity: 10 }]

		await expect(assertStockAvailable(items, productById, {})).resolves.toBeUndefined()
	})

	it('passes when requested is less than available with committed taken into account', async () => {
		const product = makeProduct('p1', 'Кефир', 20)
		const productById = new Map([['p1', product]])
		const items: StockItem[] = [{ product: 'p1', quantity: 5 }]
		const committed = { p1: 10 }

		await expect(assertStockAvailable(items, productById, committed)).resolves.toBeUndefined()
	})

	it('throws PRODUCT_NOT_FOUND for each unknown product id independently', async () => {
		const product = makeProduct('p1', 'Товар1', 10)
		const productById = new Map([['p1', product]])
		const items: StockItem[] = [
			{ product: 'p1', quantity: 1 },
			{ product: 'missing', quantity: 1 },
		]

		await expect(assertStockAvailable(items, productById, {})).rejects.toMatchObject({
			response: expect.objectContaining({ code: 'PRODUCT_NOT_FOUND', product: 'missing' }),
		})
	})
})

describe('state-machine guards', () => {
	describe('guardConfirmedPaidWithoutIsPaid', () => {
		it('throws when confirmedPaid=true but order.isPaid=false and update does not set isPaid', () => {
			expect(() =>
				guardConfirmedPaidWithoutIsPaid({ confirmedPaid: true }, { isPaid: false })
			).toThrow('Нельзя подтвердить оплату до того, как заказ отмечен как оплаченный')
		})

		it('passes when confirmedPaid=true and order.isPaid is already true', () => {
			expect(() =>
				guardConfirmedPaidWithoutIsPaid({ confirmedPaid: true }, { isPaid: true })
			).not.toThrow()
		})

		it('passes when confirmedPaid=true and update also sets isPaid=true atomically', () => {
			expect(() =>
				guardConfirmedPaidWithoutIsPaid(
					{ confirmedPaid: true, isPaid: true },
					{ isPaid: false }
				)
			).not.toThrow()
		})

		it('passes when confirmedPaid is not set in update', () => {
			expect(() =>
				guardConfirmedPaidWithoutIsPaid({}, { isPaid: false })
			).not.toThrow()
		})
	})

	describe('guardCompleteWithoutConfirmedPaid', () => {
		it('throws when isCompleted=true but confirmedPaid not yet confirmed', () => {
			expect(() =>
				guardCompleteWithoutConfirmedPaid({ isCompleted: true }, { confirmedPaid: false })
			).toThrow('Нельзя завершить заказ до подтверждения оплаты казначеем')
		})

		it('passes when isCompleted=true and confirmedPaid is already true on old order', () => {
			expect(() =>
				guardCompleteWithoutConfirmedPaid({ isCompleted: true }, { confirmedPaid: true })
			).not.toThrow()
		})

		it('passes when isCompleted=true and update also sets confirmedPaid=true atomically', () => {
			expect(() =>
				guardCompleteWithoutConfirmedPaid(
					{ isCompleted: true, confirmedPaid: true },
					{ confirmedPaid: false }
				)
			).not.toThrow()
		})

		it('passes when isCompleted is not being changed', () => {
			expect(() =>
				guardCompleteWithoutConfirmedPaid({ isPaid: true } as any, { confirmedPaid: false })
			).not.toThrow()
		})
	})

	describe('guardIsPaidRevert', () => {
		it('throws when trying to set isPaid=false on an already paid order', () => {
			expect(() =>
				guardIsPaidRevert({ isPaid: false }, { isPaid: true })
			).toThrow('Отметку «оплачен» нельзя снять')
		})

		it('passes when order was not paid and update sets isPaid=false', () => {
			expect(() =>
				guardIsPaidRevert({ isPaid: false }, { isPaid: false })
			).not.toThrow()
		})

		it('passes when isPaid is not included in update dto', () => {
			expect(() =>
				guardIsPaidRevert({}, { isPaid: true })
			).not.toThrow()
		})

		it('passes when updating isPaid from false to true', () => {
			expect(() =>
				guardIsPaidRevert({ isPaid: true }, { isPaid: false })
			).not.toThrow()
		})
	})
})

describe('itemsEqual', () => {
	it('returns false when first array is undefined', () => {
		expect(itemsEqual(undefined, [])).toBe(false)
	})

	it('returns false when second array is undefined', () => {
		expect(itemsEqual([], undefined)).toBe(false)
	})

	it('returns false when arrays have different lengths', () => {
		const a = [{ product: 'p1', quantity: 1 }]
		const b = [{ product: 'p1', quantity: 1 }, { product: 'p2', quantity: 2 }]
		expect(itemsEqual(a, b)).toBe(false)
	})

	it('returns false when same products but different quantities', () => {
		const a = [{ product: 'p1', quantity: 1 }]
		const b = [{ product: 'p1', quantity: 2 }]
		expect(itemsEqual(a, b)).toBe(false)
	})

	it('returns false when different product ids', () => {
		const a = [{ product: 'p1', quantity: 1 }]
		const b = [{ product: 'p2', quantity: 1 }]
		expect(itemsEqual(a, b)).toBe(false)
	})

	it('returns true for identical single-item arrays', () => {
		const a = [{ product: 'p1', quantity: 5 }]
		const b = [{ product: 'p1', quantity: 5 }]
		expect(itemsEqual(a, b)).toBe(true)
	})

	it('returns true for identical multi-item arrays in same order', () => {
		const a = [
			{ product: 'p1', quantity: 2 },
			{ product: 'p2', quantity: 3 },
		]
		const b = [
			{ product: 'p1', quantity: 2 },
			{ product: 'p2', quantity: 3 },
		]
		expect(itemsEqual(a, b)).toBe(true)
	})

	it('returns true when arrays have same items in different order (normalized by sort)', () => {
		const a = [
			{ product: 'p2', quantity: 3 },
			{ product: 'p1', quantity: 2 },
		]
		const b = [
			{ product: 'p1', quantity: 2 },
			{ product: 'p2', quantity: 3 },
		]
		expect(itemsEqual(a, b)).toBe(true)
	})

	it('returns true when product is an object with _id (populated Mongoose ref)', () => {
		const a = [{ product: { _id: 'p1' }, quantity: 5 }]
		const b = [{ product: 'p1', quantity: 5 }]
		expect(itemsEqual(a, b)).toBe(true)
	})
})
