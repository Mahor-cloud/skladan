/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

// Цена строки заказа или закупки записывается в саму строку вместе с суммой документа: смена цены товара не должна
// менять то, что уже посчитано. Здесь — общее для заказов и закупок.

type Line = { product: any; price?: number }

/** Цены, уже записанные в строках документа: { товар → цена }. Строки старых документов без цены пропускаются. */
export function keptPrices(items: Line[] = []): Map<string, number> {
	const kept = new Map<string, number>()
	for (const item of items || []) {
		if (typeof item?.price === 'number') kept.set(String(item.product?._id || item.product), item.price)
	}
	return kept
}

/**
 * Строки с ценами. kept — цены, зафиксированные в документе: товар, который в нём уже был, остаётся по своей цене.
 * current(товар) — цена для остальных строк; undefined — цену не назначать (сумма документа сейчас не пересчитывается,
 * строка старого документа остаётся без цены).
 */
export function priceLines<T extends { product: any }>(
	items: T[],
	kept: Map<string, number>,
	current: (productId: string) => number | undefined
): (T & { price?: number })[] {
	return items.map((item) => {
		const id = String(item.product)
		const price = kept.has(id) ? kept.get(id) : current(id)
		// поле без значения в базу не пишется: null в строке выглядел бы как записанная цена
		return price === undefined ? { ...item } : { ...item, price }
	})
}

/** Сумма строк по полю количества; строка без цены даёт 0. */
export const linesSum = (items: { price?: number }[], field = 'quantity') =>
	items.reduce((sum, item) => sum + (Number(item[field]) || 0) * (item.price || 0), 0)

/** Выражение агрегации: цена строки из документа, у старых документов без неё — текущая цена подтянутого товара. */
export const LINE_PRICE = { $ifNull: ['$items.price', { $ifNull: ['$product.price', 0] }] }
