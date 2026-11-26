/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { index, modelOptions, mongoose, plugin, prop, Ref } from '@typegoose/typegoose'
import { Base } from '@typegoose/typegoose/lib/defaultClasses'
import { tenantPlugin } from '../common/plugins/tenant.plugin'
import { Company } from '../company/company.model'
import { Purchase } from '../purchases/purchase.model'

export interface LitnaAccount extends Base {}

/** Аккаунт местности на lit-na.ru: вход, получатель, адрес и пункт выдачи. Пары товаров — в самих товарах (Product.litnaId). */
@index({ company: 1 }, { unique: true })
@plugin(tenantPlugin)
@modelOptions({ schemaOptions: { collection: 'LitnaAccounts' }, options: { allowMixed: 0 } })
export class LitnaAccount {
	@prop({ ref: Company, type: mongoose.Types.ObjectId, required: true })
	company: Ref<Company>

	@prop({ default: '' })
	login: string

	/** AES-256-GCM, «iv.tag.данные» в base64: для входа на сайт нужен сам пароль, хеш не подходит. Нет логина — заказы гостем. */
	@prop({ default: '' })
	password: string

	/** Сохранённый вход перестал работать (не вошли при заказе): нужно зайти заново или выйти в гостя */
	@prop({ default: false })
	loginFailed: boolean

	@prop({ default: '' })
	firstName: string

	@prop({ default: '' })
	lastName: string

	@prop({ default: '' })
	phone: string

	@prop({ default: '' })
	email: string

	/**
	 * Адрес получателя — полями раздела «Адрес» кабинета сайта. От способа доставки не зависит: пишется в кабинет сайта
	 * и в примечание заказа.
	 */
	@prop({ default: '' })
	street: string

	@prop({ default: '' })
	city: string

	@prop({ default: '' })
	state: string

	@prop({ default: '' })
	postcode: string

	/** Запись старого вида: адрес одной строкой (у пункта выдачи — адрес пункта). Не пуст — запись ещё не переведена в поля */
	@prop({ default: '' })
	address: string

	/** Примечание к каждому заказу на сайте; адрес в него дописывается сам */
	@prop({ default: '' })
	comment: string

	/** code и title — выбранный пункт (title — строка для сайта), address — его адрес для показа, city — город, по которому искали пункт */
	@prop()
	delivery?: { kind: string; code?: string; title?: string; city?: string; address?: string }
}

export interface LitnaOrder extends Base {}

/**
 * Заказ на сайте по закупке. Ключ заказа (orderKey) открывает оплату и статус, поэтому лежит здесь, а не в закупке.
 * Пишется ДО оформления (намерение, без orderId): если ответ сайта потеряется, заказ ищется в кабинете, а не оформляется
 * второй раз. В записи — всё, чтобы довести закупку до «создана», если первый раз это прервалось.
 */
// живые записи (deletedAt: null): одна на закупку, и один заказ сайта — не больше чем у одной закупки
@index({ purchase: 1 }, { unique: true, partialFilterExpression: { deletedAt: { $type: 'null' } } })
@index({ company: 1, orderId: 1 }, { unique: true, partialFilterExpression: { orderId: { $type: 'number' }, deletedAt: { $type: 'null' } } })
@plugin(tenantPlugin)
@modelOptions({ schemaOptions: { collection: 'LitnaOrders' }, options: { allowMixed: 0 } })
export class LitnaOrder {
	@prop({ ref: Company, type: mongoose.Types.ObjectId, required: true })
	company: Ref<Company>

	@prop({ ref: Purchase, type: mongoose.Types.ObjectId, required: true })
	purchase: Ref<Purchase>

	/** Нет — оформление начато, ответа сайта ещё нет */
	@prop()
	orderId?: number

	@prop()
	orderKey?: string

	/** Момент отправки формы оформления (до неё — начало оформления): от него отсчитывается выдержка */
	@prop({ required: true })
	startedAt: number

	/** Логин аккаунта сайта, под которым оформлялось: под другим свой заказ не найти */
	@prop()
	login?: string

	/** Заказ гостем: обслуживается без входа (оплата, отмена и документы — по ключу заказа) */
	@prop({ default: false })
	guest?: boolean

	/** Куки гостевой сессии до отправки формы: повтор в той же сессии и с той же корзиной сайт узнаёт и второй заказ не создаёт */
	@prop()
	cookies?: [string, string][]

	/** Поля формы гостевого оформления: повтор — с ними же (способ, пункт, получатель), а не с нынешними настройками */
	@prop()
	sent?: Record<string, string>

	/** Почта, с которой оформлен заказ: ею подтверждаются гостевые страницы заказа, когда сайт об этом просит */
	@prop()
	email?: string

	/** Самый новый заказ кабинета до оформления: свой заказ после потери ответа ищется только среди более новых */
	@prop()
	seen?: number

	/** Случайный код в примечании заказа на сайте: по нему заказ опознаётся как свой */
	@prop()
	code?: string

	/** Сумма к оплате по расчёту (товары + доставка), ₽: с ней сверяется заказ на сайте */
	@prop({ required: true })
	expected: number

	/** Кто открыл оплату: проверка отмечает закупку оплаченной от его имени */
	@prop({ type: mongoose.Types.ObjectId })
	payer?: mongoose.Types.ObjectId

	/** Когда выдана форма оплаты: сайт принимает оплату и у отменённого заказа, удаление закупки сразу после неё опасно */
	@prop()
	payAt?: number

	/** Запись не удаляется, а помечается: след заказа на сайте остаётся (поздняя оплата отменённого заказа) */
	@prop({ default: null })
	deletedAt?: Date

	@prop({ type: mongoose.Types.ObjectId })
	deletedBy?: mongoose.Types.ObjectId

	/** Когда сайт впервые ответил «заказа с таким ключом нет»: в черновик — только при повторе не раньше 5 минут */
	@prop()
	missingAt?: number

	/** Отвязан без отмены на сайте (сайт был недоступен): поздняя оплата проверяется трое суток от этого момента */
	@prop()
	detachedAt?: number

	/** Когда фоновая проверка (ожидание оплаты, поздняя оплата) спрашивала сайт в последний раз: очередь идёт по кругу */
	@prop()
	lateAt?: number

	/** Закрытый заказ оказался оплаченным (фоновая проверка): уведомили, больше не спрашиваем */
	@prop()
	paidLateAt?: number

	/** То, что пишется в закупку (Purchase.litna); status «placing» — оформление начато */
	@prop()
	info: Purchase['litna']

	/** Строки закупки с ценами сайта */
	@prop()
	lines: { product: string; quantity: number; price: number }[]
}
