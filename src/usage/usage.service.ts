/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { ModelType } from '@typegoose/typegoose/lib/types'
import { createHash } from 'crypto'
import { Types } from 'mongoose'
import { InjectModel } from 'nestjs-typegoose'
import { UsageBatchDto, UsageQueryDto } from './dto/usage.dto'
import { UsageHour, UsageMonth, UsageRole, UsageStat } from './usage.model'

const MSK = 3 * 3600 * 1000
const HOUR = 3600 * 1000
const DAY = 24 * HOUR
/**
 * До стольких дней сводка считается по подробным записям и график идёт по дням; дольше — по месячным итогам.
 * Подробных записей за 90 дней при 190 пользователях — около четверти миллиона: считать их на боевом сервере слишком долго.
 */
export const USAGE_BY_DAY_MAX = 45
/** «Не нажимали за период» сравнивает период с полугодом перед ним. */
const IDLE_DAYS = 180
const IDLE_MONTHS = 6
/** Больше стольких строк счётчика от одного пользователя за день не принимается: защита базы от клиента, который шлёт мусор. */
export const USAGE_ROWS_PER_DAY = 5000

const dayStart = (day: string) => new Date(`${day}T00:00:00.000Z`)
/** День по Москве (обе нынешние местности в этом поясе): запись, пришедшая после полуночи, относится к новому дню. */
export const mskDay = (now = Date.now()) =>
	new Date(now + MSK).toISOString().slice(0, 10)
/** Час по Москве, ГГГГ-ММ-ДДTЧЧ. Сдвиг пояса — целые часы, поэтому час по Москве начинается вместе с часом UTC. */
export const mskHour = (now = Date.now()) =>
	new Date(now + MSK).toISOString().slice(0, 13)
/** Месяц на n месяцев раньше: ('2026-02', 6) → '2025-08'. */
export const monthBack = (month: string, n: number) => {
	const total = +month.slice(0, 4) * 12 + (+month.slice(5, 7) - 1) - n
	return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
}

/**
 * Пачка счётчиков пользователя → операции для базы: daily — подробные записи по дням, hourly — те же записи по часам
 * (для сводки за 24 часа), monthly — месячные итоги
 * (по строке на элемент и одна строка самого пользователя), role — снимок прав его роли (или null, если роли нет).
 * Супер-админ и пользователь без местности не учитываются.
 * Одинаковые строки складываются в базе сами ($inc), время самого долгого посещения — через $max.
 * В день смены роли подробные записи этого дня целиком переходят на новую роль (роли нет в их ключе), а месячные итоги
 * делятся между двумя ролями — таблицы ролей за короткий и длинный период в этот день немного расходятся.
 */
export function usageOps(user: any, dto: UsageBatchDto, now = Date.now()) {
	const none = {
		daily: [] as any[],
		hourly: [] as any[],
		monthly: [] as any[],
		role: null as null | { roleId: string; key: string; op: any },
	}
	if (!user || user.isSuperAdmin || !user.company) return none
	const events = (dto.events || []).filter((e) => e.n > 0 || (e.ms || 0) > 0)
	if (!events.length) return none
	const day = mskDay(now)
	const month = day.slice(0, 7)
	const company = new Types.ObjectId(String(user.company._id || user.company))
	const id = new Types.ObjectId(String(user._id))
	// Роль подставлена в пользователя при входе в запрос (название, права); номер роли постоянный, название могут сменить
	const r =
		user.role && typeof user.role === 'object' && user.role._id
			? user.role
			: null
	const roleId = r ? new Types.ObjectId(String(r._id)) : null
	const role = String(r?.name || '')
	const staff = !!user.isAdmin

	// when — день или час записи (ключ), at — его начало датой
	const rows = (when: Record<string, string>, at: Date) =>
		events.map((e) => ({
			updateOne: {
				filter: {
					company,
					...when,
					user: id,
					device: dto.device,
					screen: e.s,
					kind: e.k,
					label: e.l,
				},
				update: {
					$inc: { count: e.n, ms: e.ms || 0 },
					$max: { maxMs: e.max || 0 },
					$set: { role, roleId, staff },
					$setOnInsert: { at },
				},
				upsert: true,
			},
		}))
	const daily = rows({ day }, dayStart(day))
	const hourly = rows(
		{ hour: mskHour(now) },
		new Date(Math.floor(now / HOUR) * HOUR)
	)

	const sum = (kind: string, field: 'n' | 'ms') =>
		events.filter((e) => e.k === kind).reduce((s, e) => s + (e[field] || 0), 0)
	const monthly: any[] = events
		.filter((e) => e.k !== 'open')
		.map((e) => ({
			updateOne: {
				filter: {
					company,
					month,
					device: dto.device,
					roleId,
					screen: e.s,
					kind: e.k,
					label: e.l,
				},
				update: {
					$inc: { count: e.n, ms: e.ms || 0 },
					$max: { maxMs: e.max || 0 },
					$addToSet: { users: id },
					$set: { role },
				},
				upsert: true,
			},
		}))
	monthly.push({
		updateOne: {
			filter: {
				company,
				month,
				device: dto.device,
				roleId,
				screen: '',
				kind: 'user',
				label: String(id),
			},
			update: {
				$inc: {
					opens: sum('open', 'n'),
					visits: sum('view', 'n'),
					clicks: sum('click', 'n'),
					ms: sum('view', 'ms'),
				},
				$addToSet: { days: day.slice(8) },
				$set: { role, staff },
			},
			upsert: true,
		},
	})

	if (!roleId) return { daily, hourly, monthly, role: null }
	// Снимок прав роли: новая запись, только когда меняется название или состав прав; иначе продлевается срок открытой
	const permissions = [...(r.permissions || [])].map(String).sort()
	const key = createHash('sha1')
		.update(JSON.stringify([role, !!r.isSystem, permissions]))
		.digest('hex')
		.slice(0, 16)
	const op = {
		updateOne: {
			filter: { roleId, key, open: true },
			update: {
				$setOnInsert: {
					company,
					name: role,
					isSystem: !!r.isSystem,
					permissions,
					from: day,
				},
				$max: { to: day },
			},
			upsert: true,
		},
	}
	return { daily, hourly, monthly, role: { roleId: String(roleId), key, op } }
}

const size = (field: any) => ({ $size: field })
const when = (kind: string, value: any) => ({
	$sum: { $cond: [{ $eq: ['$kind', kind] }, value, 0] },
})
/** Объединение массива массивов: кто нажимал, без повторов. */
const union = (field: string) => ({
	$reduce: {
		input: field,
		initialValue: [],
		in: { $setUnion: ['$$value', '$$this'] },
	},
})
/** Номер роли строкой (пусто, если роли нет) — чтобы склеить с днём или месяцем и взять роль из самой поздней записи без сортировки. */
const roleStr = { $ifNull: [{ $toString: '$roleId' }, ''] }
const lastRole = { $arrayElemAt: [{ $split: ['$last', '|'] }, 1] }
const LIMIT = { maxTimeMS: 60_000 }
/** Только отказ уникального индекса — не ошибка: две вкладки одного пользователя могут одновременно создать одну и ту же запись. */
const onlyDuplicates = (e: any) => {
	const rows = e?.writeErrors || []
	return rows.length
		? rows.every((w: any) => (w.code ?? w.err?.code) === 11000)
		: e?.code === 11000
}

@Injectable()
export class UsageService {
	private readonly logger = new Logger('Usage')

	constructor(
		@InjectModel(UsageStat) private readonly model: ModelType<UsageStat>,
		@InjectModel(UsageMonth) private readonly months: ModelType<UsageMonth>,
		@InjectModel(UsageRole) private readonly roles: ModelType<UsageRole>,
		@InjectModel(UsageHour) private readonly hours: ModelType<UsageHour>
	) {}

	/**
	 * В памяти на текущий день (после перезапуска начинается заново): сколько строк принято от пользователя
	 * и какой снимок прав каждой роли уже записан сегодня (номер роли → отпечаток).
	 */
	private readonly accepted = new Map<string, number>()
	private readonly rolesToday = new Map<string, string>()
	private today = ''

	/**
	 * Записи идут параллельно и независимо; сбой одной в ответ не попадает (только в журнал): клиент, получив ошибку,
	 * прислал бы пачку снова, и в коллекции, где запись уже прошла, числа удвоились бы.
	 */
	async record(user: any, dto: UsageBatchDto): Promise<void> {
		const { daily, hourly, monthly, role } = usageOps(user, dto)
		if (!daily.length) return
		const day = mskDay()
		if (day !== this.today) {
			this.accepted.clear()
			this.rolesToday.clear()
			this.today = day
		}
		// Предел общий для подробных и часовых записей: строк по часам за день от человека столько же, сколько по дню
		const seen = this.accepted.get(String(user._id)) || 0
		if (seen >= USAGE_ROWS_PER_DAY) return
		this.accepted.set(String(user._id), seen + daily.length)
		const writes = [
			this.write(this.model, daily),
			this.write(this.hours, hourly),
			this.write(this.months, monthly),
		]
		if (role && this.rolesToday.get(role.roleId) !== role.key)
			writes.push(this.snapshot(role))
		for (const r of await Promise.allSettled(writes))
			if (r.status === 'rejected')
				this.logger.warn(
					`запись счётчика не прошла: ${r.reason?.message || r.reason}`
				)
	}

	private async write(model: ModelType<any>, ops: any[]) {
		try {
			await model.bulkWrite(ops, { ordered: false })
		} catch (e: any) {
			// Остальные строки пачки при ordered: false записаны; потеря одного прибавления счётчика несущественна
			if (!onlyDuplicates(e)) throw e
		}
	}

	/** Записать снимок прав роли; если роль изменилась (появился новый снимок) — закрыть прежние. */
	private async snapshot(role: { roleId: string; key: string; op: any }) {
		this.rolesToday.set(role.roleId, role.key)
		try {
			const res = await this.roles.bulkWrite([role.op])
			if (res.upsertedCount)
				await this.roles.updateMany(
					{
						roleId: new Types.ObjectId(role.roleId),
						open: true,
						key: { $ne: role.key },
					},
					{ $unset: { open: 1 } }
				)
		} catch (e: any) {
			if (onlyDuplicates(e)) return
			this.rolesToday.delete(role.roleId) // не записалось — попробовать со следующей пачкой
			throw e
		}
	}

	/**
	 * Сводка для страницы супер-админа. Период — дни по Москве включительно; без дат — последние 30 дней; all — от первой записи;
	 * hours — последние 24 часа: нынешний час и 23 перед ним, по часовым записям (from и to в ответе — часы ГГГГ-ММ-ДДTЧЧ).
	 * Короткий период и отбор одного человека считаются по подробным записям, длинный — по месячным итогам (целыми месяцами).
	 */
	async summary(q: UsageQueryDto, now = Date.now()) {
		const scope: Record<string, any> = {}
		if (q.company) scope.company = new Types.ObjectId(q.company)
		const inCompany = { ...scope }
		if (q.device) scope.device = q.device
		// Начало первого из 24 часов; дни from и to нужны и здесь — для прав ролей и «не нажимали»
		const since = q.hours ? (Math.floor(now / HOUR) - 23) * HOUR : 0
		const to = q.all || q.hours ? mskDay(now) : q.to || mskDay(now)
		let from = q.hours
			? mskDay(since)
			: q.from || mskDay(Date.parse(`${to}T00:00:00Z`) - 29 * DAY - MSK)
		if (q.all && !since)
			from = `${(await this.months.findOne(scope).sort({ month: 1 }).select('month').lean())?.month || to.slice(0, 7)}-01`
		const byMonth =
			(Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY >=
			USAGE_BY_DAY_MAX
		const whole = byMonth && !q.user
		if (whole) from = `${from.slice(0, 7)}-01`

		const db = this.model.db
		// Номер роли → нынешнее название; у удалённой роли — последнее записанное в снимках
		const snaps = await this.roles.find(inCompany).sort({ to: 1 }).lean()
		const nameOf = new Map<string, string>(
			snaps.map((s) => [String(s.roleId), s.name])
		)
		for (const r of await db
			.collection('Roles')
			.find(inCompany, { projection: { name: 1 } })
			.toArray())
			nameOf.set(String(r._id), r.name)
		const name = (id: any) => (id ? (nameOf.get(String(id)) ?? '') : '')

		// Отбор по роли и по праву переводится в номера ролей. Роль отбирается по тому же названию, под которым она показана в таблице.
		const picked: any[] = []
		if (q.role === '-') picked.push({ roleId: null })
		else if (q.role)
			picked.push({
				roleId: {
					$in: [...nameOf]
						.filter(([, n]) => n === q.role)
						.map(([id]) => new Types.ObjectId(id)),
				},
			})
		// Право: роли, у которых оно было хотя бы часть периода (роль берётся целиком — счётчики по дням внутри роли не делятся)
		const held = (s: any) => s.from <= to && s.to >= from
		if (q.perm)
			picked.push({
				roleId: {
					$in: snaps
						.filter((s) => held(s) && s.permissions.includes(q.perm))
						.map((s) => s.roleId),
				},
			})
		const roleCond = picked.length ? { $and: picked } : {}

		const data = whole
			? await this.fromMonths(
					scope,
					roleCond,
					from.slice(0, 7),
					to.slice(0, 7),
					!!q.all
				)
			: await this.fromDays(
					scope,
					roleCond,
					q.user,
					from,
					to,
					byMonth,
					!!q.all,
					since
				)

		// Роли: строки по номерам → по названиям. Одноимённые складываются; люди считаются без повторов
		// (человек мог сменить роль, роль могли удалить и создать заново).
		const byRole: {
			id: string
			users: Set<string>
			clicks: number
			visits: number
			ms: number
		}[] = data.roles.map((r: any) => ({
			id: r.role ? String(r.role) : '',
			users: new Set<string>((r.users || []).map(String)),
			clicks: r.clicks || 0,
			visits: r.visits || 0,
			ms: r.ms || 0,
		}))
		const total = (rows: typeof byRole) => ({
			users: new Set(rows.flatMap((r) => [...r.users])).size,
			clicks: rows.reduce((s, r) => s + r.clicks, 0),
			visits: rows.reduce((s, r) => s + r.visits, 0),
			ms: rows.reduce((s, r) => s + r.ms, 0),
		})
		const roleNames = [...new Set(byRole.map((r) => name(r.id)))]
		const roles = roleNames
			.map((role) => ({
				role,
				...total(byRole.filter((r) => name(r.id) === role)),
			}))
			.sort((a, b) => b.ms - a.ms)

		// Права: у каких ролей право было в периоде и сколько эти роли работали
		const holders = new Map<string, Set<string>>()
		for (const s of snaps.filter(held))
			for (const p of s.permissions)
				holders.set(p, (holders.get(p) || new Set()).add(String(s.roleId)))
		const perms = [...holders]
			.map(([perm, ids]) => {
				const rows = byRole.filter((r) => ids.has(r.id))
				const t = total(rows)
				return {
					perm,
					roles: new Set(rows.map((r) => name(r.id))).size,
					users: t.users,
					clicks: t.clicks,
					ms: t.ms,
				}
			})
			.filter((p) => p.users)
			.sort((a, b) => b.ms - a.ms)

		const mergeClicks = (rows: { role: string; clicks: number }[]) => {
			const out = new Map<string, number>()
			for (const r of rows) out.set(r.role, (out.get(r.role) || 0) + r.clicks)
			return [...out].map(([role, clicks]) => ({ role, clicks }))
		}
		const names = await db
			.collection('Users')
			.find(
				{
					_id: {
						$in: data.users.map((p: any) => new Types.ObjectId(String(p.user))),
					},
				},
				{ projection: { name: 1, login: 1 } }
			)
			.toArray()
		const byId = new Map(names.map((n: any) => [String(n._id), n]))
		const companies = await db
			.collection('Company')
			.find({}, { projection: { name: 1 } })
			.sort({ name: 1 })
			.toArray()
		return {
			from: since ? mskHour(since) : from,
			to: since ? mskHour(now) : to,
			by: since ? 'hour' : byMonth ? 'month' : 'day',
			companies: companies.map((c: any) => ({
				_id: String(c._id),
				name: c.name,
			})),
			...data,
			elements: data.elements.map((e: any) => ({
				...e,
				roles: mergeClicks(
					e.roles.map((r: any) => ({ role: name(r.role), clicks: r.clicks }))
				),
			})),
			roles,
			perms,
			users: data.users.map((p: any) => ({
				...p,
				role: name(p.role),
				user: String(p.user),
				company: String(p.company),
				name: byId.get(String(p.user))?.name || '',
				login: byId.get(String(p.user))?.login || '',
			})),
		}
	}

	/**
	 * Сводка по подробным записям. Роль в ответе — её номер; названия подставляет summary.
	 * since — начало первого часа: сводка за 24 часа по часовым записям, ряд графика — hours, у людей days — число часов с заходом.
	 */
	private async fromDays(
		scope: Record<string, any>,
		roleCond: Record<string, any>,
		user: string | undefined,
		from: string,
		to: string,
		byMonth: boolean,
		all: boolean,
		since = 0
	) {
		const who: Record<string, any> = { ...roleCond }
		if (user) who.user = new Types.ObjectId(user)
		const narrowed = !!user || !!Object.keys(roleCond).length
		const src: ModelType<any> = since ? this.hours : this.model
		const unit = since ? 'hour' : 'day'
		// at — начало дня (часа) записи: условие по нему идёт по индексу, без него сводка читала бы всю коллекцию
		const period = since
			? { at: { $gte: new Date(since) } }
			: {
					day: { $gte: from, $lte: to },
					at: { $gte: dayStart(from), $lte: dayStart(to) },
				}
		const totals = {
			opens: when('open', '$count'),
			clicks: when('click', '$count'),
			ms: when('view', '$ms'),
		}
		const none = [{ $match: { _id: null } }]
		const byRole = [
			{
				$group: {
					_id: '$roleId',
					users: { $addToSet: '$user' },
					clicks: when('click', '$count'),
					visits: when('view', '$count'),
					ms: when('view', '$ms'),
				},
			},
			{
				$project: {
					_id: 0,
					role: '$_id',
					users: 1,
					clicks: 1,
					visits: 1,
					ms: 1,
				},
			},
		]

		const [f] = await src
			.aggregate([
				{ $match: { ...scope, ...who, ...period } },
				{
					$facet: {
						// ряд графика: по дням или, за 24 часа, по часам
						days: byMonth
							? none
							: [
									{
										$group: {
											_id: `$${unit}`,
											users: { $addToSet: '$user' },
											...totals,
										},
									},
									{
										$project: {
											_id: 0,
											[unit]: '$_id',
											users: size('$users'),
											opens: 1,
											clicks: 1,
											ms: 1,
										},
									},
									{ $sort: { [unit]: 1 } },
								],
						months: byMonth
							? [
									{
										$group: {
											_id: { $substrCP: ['$day', 0, 7] },
											users: { $addToSet: '$user' },
											...totals,
										},
									},
									{
										$project: {
											_id: 0,
											month: '$_id',
											users: size('$users'),
											opens: 1,
											clicks: 1,
											ms: 1,
										},
									},
									{ $sort: { month: 1 } },
								]
							: none,
						screens: [
							{ $match: { kind: 'view' } },
							{
								$group: {
									_id: '$screen',
									visits: { $sum: '$count' },
									ms: { $sum: '$ms' },
									maxMs: { $max: '$maxMs' },
									users: { $addToSet: '$user' },
								},
							},
							{
								$project: {
									_id: 0,
									screen: '$_id',
									visits: 1,
									ms: 1,
									maxMs: 1,
									users: size('$users'),
								},
							},
							{ $sort: { ms: -1 } },
						],
						elements: [
							{ $match: { kind: 'click' } },
							{
								$group: {
									_id: { screen: '$screen', label: '$label', role: '$roleId' },
									clicks: { $sum: '$count' },
									users: { $addToSet: '$user' },
								},
							},
							{
								$group: {
									_id: { screen: '$_id.screen', label: '$_id.label' },
									clicks: { $sum: '$clicks' },
									users: { $push: '$users' },
									roles: { $push: { role: '$_id.role', clicks: '$clicks' } },
								},
							},
							{ $sort: { clicks: -1 } },
							{ $limit: 500 },
							{
								$project: {
									_id: 0,
									screen: '$_id.screen',
									label: '$_id.label',
									clicks: 1,
									roles: 1,
									users: size(union('$users')),
								},
							},
						],
						// что нажимали за период — чтобы убрать это из «не нажимали»
						clicked: [
							{ $match: { kind: 'click' } },
							{ $group: { _id: { screen: '$screen', label: '$label' } } },
						],
						problems: [
							{ $match: { kind: { $in: ['error', 'empty'] } } },
							{
								$group: {
									_id: { kind: '$kind', screen: '$screen', label: '$label' },
									count: { $sum: '$count' },
									users: { $addToSet: '$user' },
								},
							},
							{
								$project: {
									_id: 0,
									kind: '$_id.kind',
									screen: '$_id.screen',
									label: '$_id.label',
									count: 1,
									users: size('$users'),
								},
							},
							{ $sort: { count: -1 } },
							{ $limit: 200 },
						],
						users: [
							{
								$group: {
									_id: '$user',
									company: { $first: '$company' },
									last: { $max: { $concat: [`$${unit}`, '|', roleStr] } },
									lastDay: { $max: `$${unit}` },
									days: { $addToSet: `$${unit}` },
									visits: when('view', '$count'),
									...totals,
								},
							},
							{
								$project: {
									_id: 0,
									user: '$_id',
									company: 1,
									role: lastRole,
									lastDay: 1,
									days: size('$days'),
									opens: 1,
									visits: 1,
									clicks: 1,
									ms: 1,
								},
							},
							{ $sort: { ms: -1 } },
						],
						devices: [
							{
								$group: {
									_id: '$device',
									users: { $addToSet: '$user' },
									clicks: when('click', '$count'),
									ms: when('view', '$ms'),
								},
							},
							{
								$project: {
									_id: 0,
									device: '$_id',
									users: size('$users'),
									clicks: 1,
									ms: 1,
								},
							},
						],
						// роли для отбора и таблиц ролей и прав; при отборе по роли, праву или человеку и в длинном периоде считаются отдельно, ниже
						roles: narrowed || byMonth ? none : byRole,
					},
				},
			])
			.option({ allowDiskUse: true, maxTimeMS: 120_000 })

		// «Не нажимали» и роли читаются из месячных итогов: по подробным записям это были бы ещё проходы по периоду и полугоду перед ним.
		// Исключение — отбор одного человека: месячные итоги элементы по людям не делят, зато его подробных записей немного.
		const fromMonth = from.slice(0, 7)
		const toMonth = to.slice(0, 7)
		const key = (e: any) => `${e.screen}\n${e.label}`
		const clicked = new Set((f?.clicked || []).map((c: any) => key(c._id)))
		let idle: any[] = []
		if (!all && user) {
			idle = await this.model
				.aggregate([
					{
						$match: {
							...scope,
							...who,
							kind: 'click',
							at: {
								$gte: dayStart(
									mskDay(
										Date.parse(`${from}T00:00:00Z`) - IDLE_DAYS * DAY - MSK
									)
								),
								$lte: dayStart(to),
							},
						},
					},
					{
						$group: {
							_id: { screen: '$screen', label: '$label' },
							inPeriod: {
								$sum: { $cond: [{ $gte: ['$day', from] }, '$count', 0] },
							},
							before: { $sum: '$count' },
							lastDay: { $max: '$day' },
						},
					},
					// за 24 часа период короче дня: нажатое в эти часы берётся из сводки выше
					{
						$match: since
							? { _id: { $nin: (f?.clicked || []).map((c: any) => c._id) } }
							: { inPeriod: 0 },
					},
					{ $sort: { before: -1 } },
					{ $limit: 100 },
					{
						$project: {
							_id: 0,
							screen: '$_id.screen',
							label: '$_id.label',
							before: 1,
							lastDay: 1,
						},
					},
				])
				.option(LIMIT)
		} else if (!all) {
			idle = (
				await this.clicksByMonths(
					scope,
					roleCond,
					monthBack(fromMonth, IDLE_MONTHS),
					toMonth
				)
			)
				.filter((e: any) => !clicked.has(key(e)))
				.slice(0, 100)
		}
		const roles =
			!narrowed && !byMonth
				? f?.roles || []
				: byMonth
					? await this.rolesFromMonths(scope, fromMonth, toMonth)
					: await src
							.aggregate([{ $match: { ...scope, ...period } }, ...byRole])
							.option(LIMIT)

		return {
			days: since ? [] : f?.days || [],
			hours: since ? f?.days || [] : [],
			months: f?.months || [],
			screens: f?.screens || [],
			elements: f?.elements || [],
			problems: f?.problems || [],
			users: f?.users || [],
			devices: f?.devices || [],
			idle,
			roles,
		}
	}

	/** Сводка по месячным итогам: from и to — месяцы ГГГГ-ММ включительно. Форма ответа та же, что у fromDays. */
	private async fromMonths(
		scope: Record<string, any>,
		roleCond: Record<string, any>,
		from: string,
		to: string,
		all: boolean
	) {
		const people = { $match: { kind: 'user' } }
		const sums = {
			opens: { $sum: '$opens' },
			clicks: { $sum: '$clicks' },
			ms: { $sum: '$ms' },
		}

		const [f] = await this.months
			.aggregate([
				{ $match: { ...scope, ...roleCond, month: { $gte: from, $lte: to } } },
				{
					$facet: {
						months: [
							people,
							{
								$group: {
									_id: '$month',
									users: { $addToSet: '$label' },
									...sums,
								},
							},
							{
								$project: {
									_id: 0,
									month: '$_id',
									users: size('$users'),
									opens: 1,
									clicks: 1,
									ms: 1,
								},
							},
							{ $sort: { month: 1 } },
						],
						screens: [
							{ $match: { kind: 'view' } },
							{
								$group: {
									_id: '$screen',
									visits: { $sum: '$count' },
									ms: { $sum: '$ms' },
									maxMs: { $max: '$maxMs' },
									users: { $push: '$users' },
								},
							},
							{
								$project: {
									_id: 0,
									screen: '$_id',
									visits: 1,
									ms: 1,
									maxMs: 1,
									users: size(union('$users')),
								},
							},
							{ $sort: { ms: -1 } },
						],
						elements: [
							{ $match: { kind: 'click' } },
							{
								$group: {
									_id: { screen: '$screen', label: '$label', role: '$roleId' },
									clicks: { $sum: '$count' },
									users: { $push: '$users' },
								},
							},
							{
								$group: {
									_id: { screen: '$_id.screen', label: '$_id.label' },
									clicks: { $sum: '$clicks' },
									users: { $push: union('$users') },
									roles: { $push: { role: '$_id.role', clicks: '$clicks' } },
								},
							},
							{ $sort: { clicks: -1 } },
							{ $limit: 500 },
							{
								$project: {
									_id: 0,
									screen: '$_id.screen',
									label: '$_id.label',
									clicks: 1,
									roles: 1,
									users: size(union('$users')),
								},
							},
						],
						problems: [
							{ $match: { kind: { $in: ['error', 'empty'] } } },
							{
								$group: {
									_id: { kind: '$kind', screen: '$screen', label: '$label' },
									count: { $sum: '$count' },
									users: { $push: '$users' },
								},
							},
							{
								$project: {
									_id: 0,
									kind: '$_id.kind',
									screen: '$_id.screen',
									label: '$_id.label',
									count: 1,
									users: size(union('$users')),
								},
							},
							{ $sort: { count: -1 } },
							{ $limit: 200 },
						],
						users: [
							people,
							// Человек за месяц: записей несколько (телефон и большой экран, смена роли), дни могут совпадать.
							// last — «последнее число месяца|роль» этой записи: наибольшее — роль, под которой он заходил последним.
							{
								$group: {
									_id: { user: '$label', month: '$month' },
									company: { $first: '$company' },
									last: {
										$max: {
											$concat: [
												{ $ifNull: [{ $max: '$days' }, '00'] },
												'|',
												roleStr,
											],
										},
									},
									days: { $push: '$days' },
									visits: { $sum: '$visits' },
									...sums,
								},
							},
							{ $addFields: { days: union('$days') } },
							{
								$group: {
									_id: '$_id.user',
									company: { $first: '$company' },
									last: { $max: { $concat: ['$_id.month', '-', '$last'] } },
									lastDay: {
										$max: { $concat: ['$_id.month', '-', { $max: '$days' }] },
									},
									days: { $sum: size('$days') },
									visits: { $sum: '$visits' },
									opens: { $sum: '$opens' },
									clicks: { $sum: '$clicks' },
									ms: { $sum: '$ms' },
								},
							},
							{
								$project: {
									_id: 0,
									user: '$_id',
									company: 1,
									role: lastRole,
									lastDay: 1,
									days: 1,
									opens: 1,
									visits: 1,
									clicks: 1,
									ms: 1,
								},
							},
							{ $sort: { ms: -1 } },
						],
						devices: [
							people,
							{
								$group: {
									_id: '$device',
									users: { $addToSet: '$label' },
									clicks: { $sum: '$clicks' },
									ms: { $sum: '$ms' },
								},
							},
							{
								$project: {
									_id: 0,
									device: '$_id',
									users: size('$users'),
									clicks: 1,
									ms: 1,
								},
							},
						],
					},
				},
			])
			.option(LIMIT)

		// Элементы, которые нажимали в полгода перед периодом, но ни разу за период. За «всё время» таких не бывает.
		const idle = all
			? []
			: (
					await this.clicksByMonths(
						scope,
						roleCond,
						monthBack(from, IDLE_MONTHS),
						to,
						from
					)
				).slice(0, 100)
		const roles = await this.rolesFromMonths(scope, from, to)
		return {
			days: [],
			months: f?.months || [],
			screens: f?.screens || [],
			elements: f?.elements || [],
			problems: f?.problems || [],
			users: f?.users || [],
			devices: f?.devices || [],
			idle,
			roles,
		}
	}

	/**
	 * Элементы с нажатиями за месяцы from…to по убыванию числа нажатий: { screen, label, before, lastDay — последний месяц }.
	 * period — с какого месяца считается «за период»: задан — только те, что за период не нажимали; не задан — все.
	 */
	private clicksByMonths(
		scope: Record<string, any>,
		roleCond: Record<string, any>,
		from: string,
		to: string,
		period = '9999'
	) {
		return this.months
			.aggregate([
				{
					$match: {
						...scope,
						...roleCond,
						kind: 'click',
						month: { $gte: from, $lte: to },
					},
				},
				{
					$group: {
						_id: { screen: '$screen', label: '$label' },
						inPeriod: {
							$sum: { $cond: [{ $gte: ['$month', period] }, '$count', 0] },
						},
						before: { $sum: '$count' },
						lastDay: { $max: '$month' },
					},
				},
				{ $match: { inPeriod: 0 } },
				{ $sort: { before: -1 } },
				{
					$project: {
						_id: 0,
						screen: '$_id.screen',
						label: '$_id.label',
						before: 1,
						lastDay: 1,
					},
				},
			])
			.option(LIMIT)
	}

	/** Роли (по номерам, с перечнем людей) за месяцы from…to — для отбора и таблиц ролей и прав: в пределах местности и устройства, без отбора по роли и человеку. */
	private rolesFromMonths(
		scope: Record<string, any>,
		from: string,
		to: string
	) {
		return this.months
			.aggregate([
				{ $match: { ...scope, month: { $gte: from, $lte: to }, kind: 'user' } },
				{
					$group: {
						_id: '$roleId',
						users: { $addToSet: '$label' },
						clicks: { $sum: '$clicks' },
						visits: { $sum: '$visits' },
						ms: { $sum: '$ms' },
					},
				},
				{
					$project: {
						_id: 0,
						role: '$_id',
						users: 1,
						clicks: 1,
						visits: 1,
						ms: 1,
					},
				},
			])
			.option(LIMIT)
	}
}
