/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { MigrationStep, MigrationResult } from './types'

// Сервер пишет цену в строку заказа и закупки вместе с суммой документа (common/line-prices). У документов, созданных
// раньше, цены в строках нет: экраны и статистика брали для них текущую цену товара, и смена цены меняла прошлое.
// Здесь цена дописывается в старые строки — только такая, которая воспроизводит сумму, сохранённую в документе.

export type PriceChange = { at: number; from: number; to: number }

const NAME = /: Товар ([\s\S]+) обновлен\. Изменения: ([\s\S]*)$/
const PRICE = /Цена изменена с (-?\d+(?:\.\d+)?) на (-?\d+(?:\.\d+)?)/
const RENAMED = 'Название изменено с '
// При удалении товар переименовывается: нынешняя пометка « (удалён дд.мм.гггг)», прежняя — «_удален_<дата ISO>»
const withoutDeleted = (name: string) => String(name || '').replace(/ \(удалён \d\d\.\d\d\.\d{4}\)$|_удален_\d{4}-\d\d-\d\dT[\d:.]+Z?$/, '')

/**
 * История цен товаров одной местности: { товар → смены цены, от новых к старым }. Источник — записи истории
 * «<кто>: Товар <название после правки> обновлен. Изменения: Название изменено с A на B, Цена изменена с X на Y».
 * В записи нет id товара, поэтому записи идут от новых к старым и названия отматываются назад вместе с ними;
 * название, которое носят два товара, пропускается.
 */
export function priceHistory(
	products: { _id: any; name?: string }[],
	recordsNewestFirst: { changeDate?: number; description?: string }[]
): Map<string, PriceChange[]> {
	const idByName = new Map<string, string | null>()
	for (const p of products) {
		const name = withoutDeleted(p.name)
		idByName.set(name, idByName.has(name) ? null : String(p._id))
	}
	const history = new Map<string, PriceChange[]>()
	for (const record of recordsNewestFirst) {
		const parsed = NAME.exec(record.description || '')
		if (!parsed) continue
		const [, name, changes] = parsed
		const id = idByName.get(name)
		if (!id) continue
		const price = PRICE.exec(changes)
		if (price) {
			if (!history.has(id)) history.set(id, [])
			history.get(id).push({ at: record.changeDate || 0, from: Number(price[1]), to: Number(price[2]) })
		}
		// До этой записи товар назывался иначе: старые записи о нём идут под прежним названием
		const from = changes.indexOf(RENAMED)
		const to = from < 0 ? -1 : changes.indexOf(` на ${name}`, from)
		if (to > from) {
			const before = changes.slice(from + RENAMED.length, to)
			idByName.delete(name)
			idByName.set(before, idByName.has(before) ? null : id)
		}
	}
	return history
}

/** Цена товара перед моментом moment: нынешняя, отмотанная назад по всем сменам цены, случившимся не раньше него. */
export function priceBefore(id: string, moment: number, current: Map<string, number>, history: Map<string, PriceChange[]>): number {
	let price = current.get(id) ?? 0
	for (const change of history.get(id) || []) if (change.at >= moment) price = change.from
	return price
}

/**
 * Цены строк старого документа: { товар → цена } или null, если однозначно восстановить нельзя.
 * Прежний сервер считал сумму документа разом, по ценам одного момента, не раньше создания документа (since).
 * Поэтому перебираются состояния цен: нынешнее и перед каждой сменой цены товаров документа после since.
 * Годится состояние, дающее все суммы документа (sums: [поле количества, сумма]); два разных годных состояния — отказ.
 */
export function restorePrices(
	items: any[],
	sums: [string, number][],
	since: number,
	current: Map<string, number>,
	history: Map<string, PriceChange[]>
): Map<string, number> | null {
	const ids = [...new Set((items || []).map((item) => String(item.product)))]
	// На суммы влияют только строки с количеством: в закупке лежат все товары местности, большинство — с нулём,
	// и их цена не должна делать два состояния «разными»
	const counted = new Set(
		items.filter((item) => sums.some(([field]) => Number(item[field]) || 0)).map((item) => String(item.product))
	)
	const moments = new Set<number>()
	for (const id of ids) for (const change of history.get(id) || []) if (change.at > since) moments.add(change.at)

	const found = new Map<string, Map<string, number>>()
	// От нынешнего состояния к прошлым: строки без количества получают цены самого позднего годного состояния
	for (const moment of [Infinity, ...[...moments].sort((a, b) => b - a)]) {
		const prices = new Map<string, number>(ids.map((id) => [id, priceBefore(id, moment, current, history)]))
		const fits = sums.every(([field, total]) => {
			const sum = items.reduce((acc, item) => acc + (Number(item[field]) || 0) * prices.get(String(item.product)), 0)
			return Math.abs(sum - total) < 0.005
		})
		const key = JSON.stringify([...prices].filter(([id]) => counted.has(id)))
		if (fits && !found.has(key)) found.set(key, prices)
	}
	return found.size === 1 ? [...found.values()][0] : null
}

export const m013FreezeLinePrices: MigrationStep = {
	name: '013-freeze-line-prices',
	description: 'Цены в строках старых заказов и закупок: записать цену, воспроизводящую сохранённую сумму документа',

	async up(ctx): Promise<MigrationResult> {
		const t0 = Date.now()
		const { db, logger, dryRun } = ctx
		const bucket = () => ({ asNow: 0, fromHistory: 0, open: 0, busy: 0, left: [] as string[] })
		const report = { Orders: bucket(), Purchases: bucket() }

		for (const company of await db.collection('Company').find({}).toArray()) {
			const products = await db.collection('Products').find({ company: company._id }).toArray()
			const current = new Map<string, number>(products.map((p) => [String(p._id), Number(p.price) || 0]))
			const records = await db
				.collection('ChangeHistory')
				.find({ company: company._id, changeType: 'product-updated', description: /Цена изменена|Название изменено/ })
				.sort({ changeDate: -1 })
				.toArray()
			const history = priceHistory(products as any[], records as any[])

			// fixed(doc) — суммы, которые цены обязаны воспроизвести; null — сумма документа ещё не зафиксирована
			// (сервер пересчитает её по текущим ценам при следующем действии), такие строки получают текущие цены
			const freeze = async (
				collection: 'Orders' | 'Purchases',
				numberField: string,
				dateField: string,
				fixed: (doc: any) => [string, number][] | null
			) => {
				const b = report[collection]
				const docs = await db.collection(collection).find({ company: company._id, 'items.price': { $exists: false } }).toArray()
				for (const doc of docs) {
					const items = doc.items || []
					if (!items.length) continue
					const sums = fixed(doc)
					const prices = sums ? restorePrices(items, sums, Number(doc[dateField]) || 0, current, history) : current
					if (!prices) {
						b.left.push(`${company.name} №${doc[numberField]}`)
						continue
					}
					const kind = !sums ? 'open' : items.every((item: any) => prices.get(String(item.product)) === (current.get(String(item.product)) ?? 0)) ? 'asNow' : 'fromHistory'
					if (dryRun) {
						b[kind]++
						continue
					}
					const set: Record<string, number> = {}
					items.forEach((item: any, i: number) => (set[`items.${i}.price`] = prices.get(String(item.product)) ?? 0))
					// Пишется, только если строки те же, что прочитаны: документ, изменённый за это время, пропускается
					const res = await db.collection(collection).updateOne({ _id: doc._id, items }, { $set: set })
					b[res.modifiedCount ? kind : 'busy']++
				}
			}

			// Сумма зафиксирована, когда сервер перестаёт её пересчитывать по текущим ценам: заказ — с отметки оплаты
			// (завершённый — заведомо), закупка — с оплаты (принятая частично или полностью — заведомо)
			await freeze('Orders', 'orderNumber', 'orderDate', (o) => (o.isPaid || o.isCompleted ? [['quantity', o.totalAmount || 0]] : null))
			await freeze('Purchases', 'purchaseNumber', 'purchaseDate', (p) =>
				p.isPaid || p.partialCompleted || p.isCompleted
					? [
							['quantity', p.totalAmount || 0],
							['confirmedQuantity', p.totalConfirmedAmount || 0],
						]
					: null
			)
		}

		const line = async (title: string, collection: 'Orders' | 'Purchases') => {
			const b = report[collection]
			// Все документы с позициями, оставшиеся без цен, — включая те, что не относятся ни к одной местности
			const noPrice = await db.collection(collection).countDocuments({ 'items.0': { $exists: true }, 'items.price': { $exists: false } })
			return (
				`${title}: цены как сейчас — ${b.asNow}, из истории — ${b.fromHistory}, без зафиксированной суммы (по текущим) — ${b.open}` +
				(b.busy ? `, изменены во время работы и пропущены — ${b.busy}` : '') +
				`, не восстановлены — ${b.left.length}${b.left.length ? ` (${b.left.slice(0, 40).join(', ')})` : ''}` +
				`; всего без цен в строках ${dryRun ? 'сейчас' : 'осталось'} — ${noPrice}`
			)
		}
		const notes = `${await line('Заказы', 'Orders')}. ${await line('Закупки', 'Purchases')}`
		logger.log(notes)
		const changed = ['Orders', 'Purchases'].reduce((n, c) => n + report[c].asNow + report[c].fromHistory + report[c].open, 0)
		return {
			name: '013-freeze-line-prices',
			changed: dryRun ? 0 : changed,
			wouldChange: dryRun ? changed : undefined,
			durationMs: Date.now() - t0,
			notes,
		}
	},

	// Данные не откатываются: цены в строках нужны новому серверу. down только снимает отметку «выполнена» (cli rollback),
	// чтобы шаг можно было запустить снова — после импорта старой выгрузки местности или для документов из «не восстановлены».
	async down(): Promise<MigrationResult> {
		return { name: '013-freeze-line-prices', changed: 0, durationMs: 0 }
	},
}
