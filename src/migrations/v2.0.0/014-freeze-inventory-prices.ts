/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { priceBefore, priceHistory } from './013-freeze-line-prices'
import { MigrationStep, MigrationResult } from './types'

// Сервер пишет цену в строки инвентаризации при её завершении (inventory.service). У инвентаризаций, завершённых раньше,
// цены в строках нет: экран оценивал расхождения по текущей цене товара, и смена цены меняла прошлую оценку.
// Сумм инвентаризация не хранит, сверить восстановленную цену не с чем — она берётся прямо из истории смен цены:
// нынешняя, отмотанная назад до момента завершения.

/**
 * Когда инвентаризацию завершили: самая ранняя запись истории «…Инвентаризация завершена» между её началом и началом
 * следующей инвентаризации местности (открытой бывает только одна, поэтому в этом промежутке завершали именно её);
 * записи нет — дата начала. completions — времена таких записей, nextStart — начало следующей (нет — Infinity).
 */
export function completedAt(startDate: number, nextStart: number, completions: number[]): number {
	const times = completions.filter((t) => t >= startDate && t < nextStart)
	return times.length ? Math.min(...times) : startDate
}

export const m014FreezeInventoryPrices: MigrationStep = {
	name: '014-freeze-inventory-prices',
	description: 'Цены в строках завершённых инвентаризаций: цена товара на момент завершения по истории смен цены',

	async up(ctx): Promise<MigrationResult> {
		const t0 = Date.now()
		const { db, logger, dryRun } = ctx
		const report = { asNow: 0, fromHistory: 0, byStartDate: 0, busy: 0 }

		for (const company of await db.collection('Company').find({}).toArray()) {
			const products = await db.collection('Products').find({ company: company._id }).toArray()
			const current = new Map<string, number>(products.map((p) => [String(p._id), Number(p.price) || 0]))
			const history = priceHistory(
				products as any[],
				(await db
					.collection('ChangeHistory')
					.find({ company: company._id, changeType: 'product-updated', description: /Цена изменена|Название изменено/ })
					.sort({ changeDate: -1 })
					.toArray()) as any[]
			)
			const completions = (
				await db
					.collection('ChangeHistory')
					.find({ company: company._id, changeType: 'inventory-updated', description: /Инвентаризация завершена/ })
					.toArray()
			).map((r) => Number(r.changeDate) || 0)
			// Начала всех инвентаризаций местности — чтобы знать, где кончается промежуток каждой
			const starts = (await db.collection('Inventory').find({ company: company._id }).project({ startDate: 1 }).toArray())
				.map((d) => Number(d.startDate) || 0)
				.sort((x, y) => x - y)

			const docs = await db.collection('Inventory').find({ company: company._id, isCompleted: true, 'items.price': { $exists: false } }).toArray()
			for (const doc of docs) {
				const items = doc.items || []
				if (!items.length) continue
				const start = Number(doc.startDate) || 0
				const done = completedAt(start, starts.find((t) => t > start) ?? Infinity, completions)
				// цена на момент завершения: смены цены позже него отматываются
				const prices = items.map((item: any) => priceBefore(String(item.product), done + 1, current, history))
				const kind = items.every((item: any, i: number) => prices[i] === (current.get(String(item.product)) ?? 0)) ? 'asNow' : 'fromHistory'
				let written = true
				if (!dryRun) {
					const set: Record<string, number> = {}
					prices.forEach((price: number, i: number) => (set[`items.${i}.price`] = price))
					// Пишется, только если строки те же, что прочитаны: инвентаризация, изменённая за это время, пропускается
					written = (await db.collection('Inventory').updateOne({ _id: doc._id, items }, { $set: set })).modifiedCount > 0
				}
				report[written ? kind : 'busy']++
				if (written && done === start) report.byStartDate++
			}
		}

		const left = await db.collection('Inventory').countDocuments({ isCompleted: true, 'items.0': { $exists: true }, 'items.price': { $exists: false } })
		const notes =
			`Завершённые инвентаризации: цены как сейчас — ${report.asNow}, из истории — ${report.fromHistory}` +
			`; момент завершения не найден в истории, взята дата начала — ${report.byStartDate}` +
			(report.busy ? `; изменены во время работы и пропущены — ${report.busy}` : '') +
			`; всего без цен в строках ${dryRun ? 'сейчас' : 'осталось'} — ${left}`
		logger.log(notes)
		const changed = report.asNow + report.fromHistory
		return {
			name: '014-freeze-inventory-prices',
			changed: dryRun ? 0 : changed,
			wouldChange: dryRun ? changed : undefined,
			durationMs: Date.now() - t0,
			notes,
		}
	},

	// Данные не откатываются; down только снимает отметку «выполнена» (cli rollback), чтобы шаг можно было запустить снова.
	async down(): Promise<MigrationResult> {
		return { name: '014-freeze-inventory-prices', changed: 0, durationMs: 0 }
	},
}
