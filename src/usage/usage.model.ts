/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { index, modelOptions, mongoose, prop } from '@typegoose/typegoose'

export const USAGE_KINDS = ['open', 'view', 'click', 'error', 'empty'] as const

/**
 * Счётчик использования интерфейса по дням: одна запись — один пользователь, день, устройство, экран и элемент.
 * kind: open — заход в приложение, view — посещение экрана (ms — активное время), click — нажатие,
 * error — показанная ошибка, empty — пустой результат. Хранится бессрочно.
 * По этим записям считается сводка за короткий период и сводка по одному человеку за любой.
 */
@index(
	{ company: 1, day: 1, user: 1, device: 1, screen: 1, kind: 1, label: 1 },
	{ unique: true }
)
@index({ at: 1 })
@index({ user: 1, at: 1 })
@modelOptions({
	schemaOptions: { collection: 'UsageStats', versionKey: false },
	options: { allowMixed: 0 },
})
export class UsageStat {
	@prop({ type: mongoose.Types.ObjectId, required: true })
	company!: mongoose.Types.ObjectId

	/** День по московскому времени, ГГГГ-ММ-ДД */
	@prop({ required: true })
	day!: string

	/** Начало этого дня как дата: по нему сводка отбирает период по индексу */
	@prop({ required: true })
	at!: Date

	@prop({ type: mongoose.Types.ObjectId, required: true })
	user!: mongoose.Types.ObjectId

	/** Постоянный номер роли: название могут сменить, и в разных местностях оно может совпадать */
	@prop({ type: mongoose.Types.ObjectId })
	roleId?: mongoose.Types.ObjectId

	/** Название роли на момент последней отправки за этот день */
	@prop({ default: '' })
	role!: string

	/** Отметка «служащий» у пользователя: вместе с правами роли определяет, что ему доступно */
	@prop()
	staff?: boolean

	@prop({ required: true })
	device!: string

	@prop({ default: '' })
	screen!: string

	@prop({ required: true })
	kind!: string

	@prop({ default: '' })
	label!: string

	@prop({ default: 0 })
	count!: number

	@prop({ default: 0 })
	ms!: number

	/** Самое долгое посещение экрана за день */
	@prop({ default: 0 })
	maxMs!: number
}

/**
 * Готовые итоги по месяцам — для сводки за длинный период (год, всё время): подробных записей за год около миллиона,
 * считать по ним каждое открытие страницы на боевом сервере слишком долго. Пишутся одновременно с подробными.
 * Два вида записей:
 *  - элемент (kind: view | click | error | empty): местность, месяц, устройство, роль (по номеру), экран, элемент → count, ms, maxMs
 *    и users — кто нажимал (для числа пользователей); их число ограничено размером интерфейса, а не числом людей;
 *  - человек (kind: user, label — id пользователя): opens, visits, clicks, ms и days — числа месяца, когда он заходил.
 */
@index(
	{ company: 1, month: 1, device: 1, roleId: 1, screen: 1, kind: 1, label: 1 },
	{ unique: true }
)
@index({ month: 1 })
@modelOptions({
	schemaOptions: { collection: 'UsageMonths', versionKey: false },
	options: { allowMixed: 0 },
})
export class UsageMonth {
	@prop({ type: mongoose.Types.ObjectId, required: true })
	company!: mongoose.Types.ObjectId

	/** Месяц по московскому времени, ГГГГ-ММ */
	@prop({ required: true })
	month!: string

	@prop({ required: true })
	device!: string

	/** Постоянный номер роли (в ключе записи); role — её название на момент последней отправки */
	@prop({ type: mongoose.Types.ObjectId })
	roleId?: mongoose.Types.ObjectId

	@prop({ default: '' })
	role!: string

	@prop()
	staff?: boolean

	@prop({ default: '' })
	screen!: string

	@prop({ required: true })
	kind!: string

	@prop({ default: '' })
	label!: string

	@prop({ default: 0 })
	count!: number

	@prop({ default: 0 })
	ms!: number

	@prop({ default: 0 })
	maxMs!: number

	@prop({ type: () => [mongoose.Types.ObjectId], default: undefined })
	users?: mongoose.Types.ObjectId[]

	@prop()
	opens?: number

	@prop()
	visits?: number

	@prop()
	clicks?: number

	@prop({ type: () => [String], default: undefined })
	days?: string[]
}

/**
 * Какие права были у роли и когда: новая запись появляется, когда у роли меняется название или состав прав.
 * from и to — первый и последний день (по Москве), когда пользователи с этой ролью в таком виде работали в приложении.
 * open — запись описывает роль в нынешнем виде; когда роль меняется, прежняя запись закрывается. Если роли потом вернут
 * прежние права, появится новая запись со своими датами — старая не растягивается на время, когда права были другими.
 * По этим записям действия разбираются по правам без восстановления правок ролей по «Истории».
 */
@index(
	{ roleId: 1, key: 1 },
	{ unique: true, partialFilterExpression: { open: true } }
)
@index({ company: 1 })
@modelOptions({
	schemaOptions: { collection: 'UsageRoles', versionKey: false },
	options: { allowMixed: 0 },
})
export class UsageRole {
	@prop({ type: mongoose.Types.ObjectId, required: true })
	company!: mongoose.Types.ObjectId

	@prop({ type: mongoose.Types.ObjectId, required: true })
	roleId!: mongoose.Types.ObjectId

	/** Отпечаток названия и состава прав: по нему видно, что роль изменилась */
	@prop({ required: true })
	key!: string

	@prop()
	open?: boolean

	@prop({ default: '' })
	name!: string

	@prop({ default: false })
	isSystem!: boolean

	@prop({ type: () => [String], default: [] })
	permissions!: string[]

	@prop({ required: true })
	from!: string

	@prop({ required: true })
	to!: string
}
