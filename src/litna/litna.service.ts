/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { BadGatewayException, BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { ConfigService } from '@nestjs/config'
import { ModelType } from '@typegoose/typegoose/lib/types'
import { randomBytes } from 'crypto'
import { Types } from 'mongoose'
import { InjectModel } from 'nestjs-typegoose'
import { UserModel } from '../auth/user.model'
import { ChangeHistoryService } from '../change-history/change-history.service'
import { RealtimeService } from '../change-history/realtime.service'
import { linesSum } from '../common/line-prices'
import { seal, sealSecret, unseal } from '../common/seal'
import { tenantContextStorage } from '../common/tenant-context/tenant-context.storage'
import { ProductPhoto } from '../products/product-photo.model'
import { Product } from '../products/product.model'
import { imageType, PHOTO_QUOTA } from '../products/products.service'
import { SeedTemplate } from '../seeds/seed-template.model'
import { Purchase } from '../purchases/purchase.model'
import { assertOwnPurchase, PurchasesService } from '../purchases/purchases.service'
import { LitnaAccountDto, LitnaLinkDto, LitnaLoginDto } from './dto/litna.dto'
import { CLOSED, Customer, LitnaSession, measured } from './litna.client'
import { LitnaAccount, LitnaOrder } from './litna.model'
import {
	cartPrices,
	cdekPoints,
	checkoutForm,
	isCancelled,
	isPaidStatus,
	isShipped,
	isSuccess,
	norm,
	notices,
	parseAddress,
	pickRate,
	Rate,
	shippingRates,
	siteProduct,
	SiteProduct,
	seedKindCovers,
	siteSeed,
	suggestPairs,
	YandexPoint,
} from './litna.parse'

const CATALOG_TTL = 10 * 60_000
const POINTS_TTL = 24 * 3600_000
// оформление без ответа сайта моложе этого считается идущим: заново не оформляем, ждём
const PLACING_FRESH = 3 * 60_000
// город, по которому сайт открывает виджет Яндекс Доставки: сам список пунктов — по всей стране
const YANDEX_PROBE_CITY = 'Москва'
// Корзина-проба для виджета Яндекса, ₽: виджет открывается на странице оформления, а к ней сайт пускает не с любой суммой
// (сейчас магазин требует от 3000 ₽); при этом проба меньше суммы бесплатной доставки (15 000 ₽), где Яндекса нет.
// shortcut: подобрано под нынешние условия магазина; сменятся они — пункты Яндекса перестанут грузиться (502), поправить здесь
const YANDEX_PROBE_SUM = 5000
// вход заранее (при открытии закупки) — не чаще раза в столько на местность: открытие страниц не должно сыпать входами на сайт
const WARM_EVERY = 5 * 60_000
const ADDRESS_MEMO = 60_000
// отвечает ли сайт — помнится столько на всех: кнопка сайта при создании закупки серая, пока он лежит
const UP_TTL = 60_000
const UP_TIMEOUT = 8_000
const POINTS_WARM_EVERY = 10 * 60_000
// фото товара — как у загрузки фото (products.controller): до 512 КБ
const PHOTO_LIMIT = 512 * 1024
// миниатюр в памяти: ~10 КБ каждая — около 5 МБ на весь каталог сайта
const THUMBS = 500
const BUSY = 'Заказ на lit-na.ru ещё оформляется — повторите позже или проверьте заказы на сайте'
// у гостя кабинета нет: проверить заказ можно только по письму сайта получателю
const GUEST_CHECK = 'Не удалось проверить заказ на lit-na.ru — снимите оформление и оформите заново'
// сбой загрузки каталога — столько не повторяем, отдаём прежний: публичные миниатюры не должны сыпать запросами на сайт
const CATALOG_RETRY = 60_000
const THUMB_TTL = 24 * 3600_000
// миниатюра товара каталога не загрузилась — столько не ходим за ней снова
const THUMB_RETRY = 10 * 60_000
const THUMB_LIMIT = 200 * 1024
// расчёт — несколько запросов к сайту: тот же состав, пары и аккаунт столько отвечаются из памяти
const QUOTE_TTL = 30_000
// ответ сайта о заказе при проверке — столько держим для всех, кто спрашивает про эту закупку
const CHECK_MEMO = 5_000
// поздняя оплата закрытых заказов: за столько после выдачи формы и не больше стольких за проход
const LATE_DAYS = 3 * 24 * 3600_000
const LATE_BATCH = 20
// «заказа с таким ключом нет» — верим только повтору не раньше чем через столько
const MISSING_CONFIRM = 5 * 60_000
type SiteStatus = { paid: boolean; status: string; missing?: boolean }
const goods = (n: number) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'товар' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'товара' : 'товаров'}`
const CHECK_SITE = 'Не удалось проверить заказ на lit-na.ru — проверьте заказы в кабинете сайта'
// сайт принимает оплату и у отменённого заказа: столько после выдачи формы оплаты закупку не удаляем
const PAY_HOLD = 30 * 60_000
// на первой странице списка заказов кабинета сайт показывает столько
const ORDERS_PAGE = 10
const minutesLeft = (ms: number) => Math.max(1, Math.ceil(ms / 60_000))
// код в примечании заказа: без похожих букв и цифр, чтобы его можно было прочитать глазами
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const kop = (rub: number) => Math.round(rub * 100)



const isPvz = (kind?: string) => !!kind?.endsWith('_pvz')
const TITLES: Record<string, string> = {
	cdek_pvz: 'CDEK — пункт выдачи',
	cdek_door: 'CDEK — до двери',
	yandex_pvz: 'Яндекс Доставка — пункт выдачи',
	yandex_door: 'Яндекс Доставка — до двери',
}

/**
 * Где получать: у пункта выдачи город — тот, по которому искали пункт; до двери — из адреса одной строкой.
 * Индекс и область — если нашлись в строке адреса (сайт считает доставку и по одному городу).
 */
const placeOf = (a: LitnaAccount) => {
	const parsed = parseAddress(a?.address)
	return { ...parsed, city: isPvz(a?.delivery?.kind) ? a.delivery.city || '' : parsed.city }
}

/** Заполнено всё, без чего сайт не примет заказ: получатель и доставка (вход не нужен — без него заказ гостем) */
const ready = (a: LitnaAccount) => !!(a?.firstName && a.lastName && a.phone && a.email && a.delivery?.kind && placeOf(a).city)
const loggedIn = (a: LitnaAccount) => !!(a?.login && a.password)

/** Адрес при пункте выдачи вписан руками: бесплатную доставку магазин везёт не в пункт, а по адресу */
const byHand = (a: LitnaAccount) => isPvz(a?.delivery?.kind) && !!a.delivery.manual && !!a.address

// Пункт пишется и в адрес: при бесплатной доставке сайт пункт не спрашивает, а поле адреса у него обязательное.
// Вписанный руками адрес уходит как написан.
const customer = (a: LitnaAccount): Customer => {
	const { city, postcode, state } = placeOf(a)
	return {
		first_name: a.firstName,
		last_name: a.lastName,
		state,
		city,
		postcode,
		address_1: isPvz(a.delivery.kind) && !byHand(a)
			? `ПВЗ ${a.delivery.kind === 'cdek_pvz' ? 'CDEK' : 'Яндекс Доставки'}: ${a.address || a.delivery.title || a.delivery.code}`
			: a.address,
		phone: a.phone,
		email: a.email,
	}
}

/** Поля раздела «Адрес» кабинета сайта из нашего аккаунта — те же, что уходят с заказом */
const billingOf = (a: LitnaAccount): Record<string, string> =>
	Object.fromEntries(Object.entries({ ...customer(a), country: 'RU' }).map(([k, v]) => [`billing_${k}`, v || '']))
/** Сайт хранит значения по-своему (пробелы, регистр, знаки в телефоне) — сравниваем по сути */
const plain = (k: string, v: any) => (k.endsWith('_phone') ? String(v ?? '').replace(/\D/g, '') : String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase())
const sameBilling = (form: Record<string, string>, fields: Record<string, string>) => Object.entries(fields).every(([k, v]) => plain(k, form[k]) === plain(k, v))

const revertedText = (placed: { orderId?: number }) => `Заказ №${placed.orderId} отменён на lit-na.ru — закупка переведена в черновик`

// куда идти человеку, если отмена не прошла: у гостя кабинета нет
const cancelHint = (placed: { guest?: boolean }) => (placed.guest ? 'напишите в магазин' : 'отмените его в кабинете сайта')

/** Сумма к оплате из формы Robokassa; без неё сверять нечего — и отменять заказ по такому ответу нельзя */
const paySum = (form: { fields: Record<string, string> }) => {
	const sum = Number(form.fields.OutSum)
	if (!(sum > 0)) throw new BadGatewayException('lit-na.ru не показал сумму к оплате')
	return sum
}

type Placed = Pick<
	LitnaOrder,
	'orderId' | 'orderKey' | 'startedAt' | 'login' | 'email' | 'guest' | 'cookies' | 'sent' | 'seen' | 'code' | 'expected' | 'info' | 'lines' | 'payer' | 'payAt' | 'missingAt'
> & {
	company?: any
	_id: any
	purchase: any
}
// живая запись заказа закупки (удалённые — след для поздней оплаты, в работе не участвуют)
const live = (purchase: any) => ({ purchase, deletedAt: null })
type Held = { session: LitnaSession; rate: Rate }
// статус, известный без запроса к сайту: из строки кабинета или только что оформленного заказа
const known = (placed: Placed): SiteStatus => ({ paid: isPaidStatus(placed.info?.status), status: placed.info?.status })
type Quote = Awaited<ReturnType<LitnaService['calc']>>

@Injectable()
export class LitnaService {
	private catalogCache: { at: number; items: SiteProduct[] } | null = null
	private yandexCache: { at: number; points: YandexPoint[] } | null = null
	// список пунктов ~15 МБ: все, кто ждёт, ждут одну загрузку
	private yandexLoading: Promise<YandexPoint[]> | null = null
	private yandexFailed: { at: number; error: unknown } | null = null
	// held — гостевая сессия расчёта с собранной корзиной и адресом: заказ гостем идёт в ней же
	// что сейчас делается на сайте по закупке — подпись и полоска шагов на кнопке ждущего человека; только пока идёт расчёт или заказ.
	// at — номер шага в своей операции (расчёт: 1–3, заказ: 1–6); назад не идёт: заказ без готового расчёта сначала считает
	private steps = new Map<string, { step: string; at: number }>()
	private quotes = new Map<string, { at: number; quote: Awaited<ReturnType<LitnaService['calc']>>; held?: Held }>()
	// пункты Яндекса заранее фоном: последняя попытка
	private pointsWarmAt = 0
	private ordering = new Set<string>()
	// форма оплаты выдаётся (число выдач) и закупка закрывается (отвязка, удаление) — по закупке, друг другу отказывают:
	// иначе форму можно получить по заказу, который в эту секунду отменяется
	private paying = new Map<string, number>()
	private closing = new Set<string>()
	// вошедшая сессия сайта на местность: вход — при первом обращении и когда сайт отказал
	private sessions = new Map<string, LitnaSession>()
	private thumbs = new Map<number, { at: number; contentType: string; bytes: Buffer }>()
	private thumbLoading = new Map<number, Promise<{ contentType: string; bytes: Buffer }>>()
	private thumbFailed = new Map<number, { at: number; error: unknown }>()
	// ответ сайта о заказе — на несколько секунд: вкладки и люди, открывшие закупку разом, спрашивают сайт один раз
	private statusMemo = new Map<string, { at: number; status: Promise<SiteStatus> }>()
	private cdekCache = new Map<string, { at: number; points: ReturnType<typeof cdekPoints> }>()
	private catalogLoading: Promise<SiteProduct[]> | null = null
	private catalogFailedAt = 0
	private warmed = new Map<string, { at: number; result: { login: string | null; loginFailed: boolean } }>()
	private addressMemo = new Map<string, { at: number; result: { same: boolean | null; site?: any } }>()
	private upCheck: { at: number; up: Promise<boolean> } | null = null

	constructor(
		@InjectModel(LitnaAccount) private readonly accountModel: ModelType<LitnaAccount>,
		@InjectModel(LitnaOrder) private readonly orderModel: ModelType<LitnaOrder>,
		@InjectModel(Purchase) private readonly purchaseModel: ModelType<Purchase>,
		@InjectModel(Product) private readonly productModel: ModelType<Product>,
		@InjectModel(UserModel) private readonly userModel: ModelType<UserModel>,
		@InjectModel(SeedTemplate) private readonly seedModel: ModelType<SeedTemplate>,
		@InjectModel(ProductPhoto) private readonly photoModel: ModelType<ProductPhoto>,
		private readonly purchases: PurchasesService,
		private readonly changeHistory: ChangeHistoryService,
		private readonly config: ConfigService,
		private readonly realtime: RealtimeService
	) {}

	private readonly logger = new Logger(LitnaService.name)

	// метка «litna» — та же, что была у своей копии шифрования: сохранённые пароли читаются
	private secret() {
		return sealSecret(this.config, 'litna')
	}

	// обычное событие обновления закупок: чужие открытые экраны перечитают закупки сразу
	private refresh(company: any) {
		this.realtime.emit(String(company), 'purchase-updated')
	}

	private findAccount() {
		return this.accountModel.findOne().lean().exec()
	}

	/**
	 * login — почта, если вошли под аккаунтом сайта, иначе null (заказы гостем); пароль наружу не отдаётся никогда.
	 * full=false — тому, кто только видит закупки: без получателя, адреса и почты входа (login — true или null).
	 */
	async account(full = true) {
		const a = await this.findAccount()
		// без права настройки — только признаки: получатель, адрес, пункт выдачи и почта аккаунта наружу не уходят
		if (!full) return { configured: ready(a), login: loggedIn(a) || null, loginFailed: !!(loggedIn(a) && a.loginFailed) }
		return {
			configured: ready(a),
			login: loggedIn(a) ? a.login : null,
			loginFailed: !!(loggedIn(a) && a.loginFailed),
			firstName: a?.firstName || '',
			lastName: a?.lastName || '',
			phone: a?.phone || '',
			email: a?.email || '',
			address: a?.address || '',
			delivery: a?.delivery || null,
		}
	}

	// настройка сайта — не событие закупок: в историю, но без push подписчикам
	private async changed(user: UserModel) {
		this.refresh(user.company)
		await this.changeHistory.createChangeHistory(
			{ user: user._id, changeType: 'litna-account-updated', description: 'Аккаунт lit-na.ru изменён', changeDate: Date.now() },
			{ push: false }
		)
		return this.account()
	}

	/**
	 * Получатель и адрес из кабинета сайта (раздел «Адрес») в наших полях. Способ доставки и пункт сайт в аккаунте не хранит.
	 * address пуст, если в кабинете записан пункт выдачи: эту строку пишет наш же заказ, адресом получателя она не является.
	 */
	private async siteProfile(s: LitnaSession) {
		const form = await s.address()
		if (!form) throw new BadGatewayException('lit-na.ru не показал адрес аккаунта')
		const v = (k: string) => String(form[`billing_${k}`] || '').trim()
		const street = v('address_1')
		const address = street.startsWith('ПВЗ ') ? '' : [v('postcode'), v('state'), v('city'), street].filter(Boolean).join(', ')
		return { form, profile: { firstName: v('first_name'), lastName: v('last_name'), phone: v('phone'), email: v('email'), address } }
	}

	/**
	 * Сверка адреса приложения с кабинетом сайта (его могли поменять на сайте): true — совпадает, false — отличается
	 * (site — что записано на сайте), null — сверять нечего (гость, не всё заполнено) или сайт не ответил.
	 * Ответ помнится минуту: расчёт закупки и вкладка админки спрашивают подряд.
	 */
	async addressCheck(): Promise<{ same: boolean | null; site?: { name: string; phone: string; email: string; address: string } }> {
		const a = await this.findAccount()
		if (!loggedIn(a) || !ready(a)) return { same: null }
		const company = String(a.company)
		const memo = this.addressMemo.get(company)
		if (memo && Date.now() - memo.at < ADDRESS_MEMO) return memo.result
		let result: Awaited<ReturnType<LitnaService['addressCheck']>> = { same: null }
		try {
			const s = await this.tryLogin(a)
			if (s) {
				const { form } = await this.siteProfile(s)
				const v = (k: string) => String(form[`billing_${k}`] || '').trim()
				result = sameBilling(form, billingOf(a))
					? { same: true }
					: { same: false, site: { name: [v('first_name'), v('last_name')].filter(Boolean).join(' '), phone: v('phone'), email: v('email'), address: [v('postcode'), v('state'), v('city'), v('address_1')].filter(Boolean).join(', ') } }
			}
		} catch (e) {
			this.logger.warn(`Адрес в кабинете lit-na.ru не сверен: ${(e as Error)?.message}`)
		}
		if (result.same !== null) this.addressMemo.set(company, { at: Date.now(), result })
		return result
	}

	/**
	 * Адрес из приложения — в кабинет сайта, теми же полями, что уходят с заказом. true — записан (или уже такой),
	 * false — не вышло (сайт не ответил, идёт заказ, вход сломан), null — писать некуда или нечего (гость, не всё заполнено).
	 */
	private async pushProfile(user: UserModel): Promise<boolean | null> {
		const a = await this.findAccount()
		this.addressMemo.delete(String(user.company))
		if (!loggedIn(a) || !ready(a)) return null
		try {
			// под замком местности: запись в кабинет не идёт одновременно с оформлением заказа в той же сессии сайта
			return await this.locked(user, async () => {
				const s = await this.tryLogin(a)
				if (!s) return false
				const { form } = await this.siteProfile(s)
				const fields = billingOf(a)
				return sameBilling(form, fields) || s.saveAddress(form, fields)
			})
		} catch (e) {
			this.logger.warn(`Адрес в кабинет lit-na.ru не записан: ${(e as Error)?.message}`)
			return false
		}
	}

	/** Получатель и доставка; адрес не проверяется (город не выделится — расчёт покажет проблему account). site — записан ли адрес в кабинет сайта */
	async saveAccount(dto: LitnaAccountDto, user: UserModel) {
		const set: Record<string, any> = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined))
		// пробел по краям — и сайт не узнает почту заказа при подтверждении
		for (const k of ['email', 'phone']) if (typeof set[k] === 'string') set[k] = set[k].trim()
		await this.accountModel.updateOne({ company: String(user.company) }, { $set: set }, { upsert: true }).exec()
		const site = await this.pushProfile(user)
		return { ...(await this.changed(user)), site }
	}

	/** Вход под аккаунтом сайта: проверяется сейчас; не вошли — ничего не сохраняется */
	async login(dto: LitnaLoginDto, user: UserModel) {
		const company = String(user.company)
		// без ключа пароль не сохранить — не входим на сайт зря
		const key = sealSecret(this.config, 'litna', true)
		const s = new LitnaSession({ login: dto.login, password: dto.password })
		try {
			await s.login()
		} catch (e) {
			throw e instanceof BadRequestException ? new BadRequestException('Не удалось войти — проверьте почту и пароль') : e
		}
		await this.accountModel
			.updateOne({ company }, { $set: { login: dto.login, password: seal(dto.password, key), loginFailed: false } }, { upsert: true })
			.exec()
		this.sessions.set(company, s)
		this.warmed.delete(company)
		// получатель и адрес — из кабинета сайта, поверх записанного у нас: для сайта верны его данные (пустое с сайта наше не стирает).
		// У пункта выдачи адрес — сам пункт: его адрес сайта не заменяет. Не прочитались — вход всё равно выполнен.
		this.addressMemo.delete(company)
		try {
			const { profile } = await this.siteProfile(s)
			const now = await this.findAccount()
			const fill = Object.fromEntries(Object.entries(profile).filter(([k, v]) => v && !(k === 'address' && isPvz(now?.delivery?.kind))))
			if (Object.keys(fill).length) await this.accountModel.updateOne({ company }, { $set: fill }).exec()
		} catch (e) {
			this.logger.warn(`Адрес из кабинета lit-na.ru не прочитан: ${(e as Error)?.message}`)
		}
		return this.changed(user)
	}

	/** Выйти в гостя: логин и пароль убираются, сессия сбрасывается */
	async logout(user: UserModel) {
		const company = String(user.company)
		await this.accountModel.updateOne({ company }, { $set: { login: '', password: '', loginFailed: false } }).exec()
		this.sessions.delete(company)
		this.addressMemo.delete(company)
		this.warmed.delete(company)
		return this.changed(user)
	}

	/**
	 * Вход заранее — при открытии закупки, чтобы заказ потом шёл быстрее, а сломанный вход был виден сразу.
	 * Живая сессия лишнего входа не делает; неудачный вход — не ошибка запроса, а loginFailed. Гость — без сайта.
	 */
	async warm(user: UserModel) {
		const a = await this.findAccount()
		const login = loggedIn(a) ? a.login : null
		if (!login) return { login, loginFailed: false, up: await this.siteUp() }
		const company = String(user.company)
		const last = this.warmed.get(company)
		if (last && Date.now() - last.at < WARM_EVERY) return { ...last.result, up: await this.siteUp() }
		// сайт недавно не отвечал — вход не пробуем и «вход не работает» не ставим: недоступность сайта — не ошибка входа
		const recent = this.upCheck && Date.now() - this.upCheck.at < UP_TTL ? await this.upCheck.up : null
		if (recent === false) return { login, loginFailed: !!a.loginFailed, up: false }
		// вход сам показывает, жив ли сайт: один поход на сайт вместо проверки и входа
		try {
			const result = { login, loginFailed: !(await this.tryLogin(a)) }
			this.upCheck = { at: Date.now(), up: Promise.resolve(true) }
			this.warmed.set(company, { at: Date.now(), result })
			return { ...result, up: true }
		} catch {
			this.upCheck = { at: Date.now(), up: Promise.resolve(false) }
			return { login, loginFailed: !!a.loginFailed, up: false }
		}
	}

	/** Отвечает ли сайт: один лёгкий запрос на всех ждущих, ответ помнится минуту */
	private siteUp() {
		if (!this.upCheck || Date.now() - this.upCheck.at >= UP_TTL) {
			const up = new LitnaSession()
				.request('/wp-json/wc/store/v1/products?per_page=1', { headers: { Accept: 'application/json' }, timeout: UP_TIMEOUT })
				.then(({ res, text }) => res.ok && Array.isArray(JSON.parse(text)))
				.catch(() => false)
			this.upCheck = { at: Date.now(), up }
		}
		return this.upCheck.up
	}

	/** Массовая правка пар: litnaId — в перечисленные товары своей местности, остальные не трогаются; одна запись в историю */
	async saveLinks(links: LitnaLinkDto[], user: UserModel) {
		const company = String(user.company)
		// один товар — одна пара (последняя); местность — явно в условии: bulkWrite мимо отбора по местности
		const pairs = new Map(links.map((l) => [l.product.toLowerCase(), l.siteId ?? null]))
		if (!pairs.size) return { ok: true }
		// «уже такое» не пишем; у «без пары» (null) условие находит и товары без поля — $ne: null их бы пропустил
		const differs = (litnaId: number | null) => (litnaId === null ? { $not: { $type: 'null' } } : { $ne: litnaId })
		const written = await this.productModel.bulkWrite(
			[...pairs].map(([_id, litnaId]) => ({ updateOne: { filter: { _id, company, litnaId: differs(litnaId) }, update: { $set: { litnaId } } } }))
		)
		const changed = written?.modifiedCount || 0
		if (changed) {
			await this.changeHistory.createChangeHistory(
				{ user: user._id, changeType: 'litna-links-updated', description: `Привязка к lit-na.ru изменена: ${goods(changed)}`, changeDate: Date.now() },
				{ push: false }
			)
		}
		return { ok: true }
	}

	private async session(account?: LitnaAccount) {
		const a = account || (await this.findAccount())
		if (!a?.login || !a.password) throw new BadRequestException('Не заполнены логин и пароль lit-na.ru')
		const company = String(a.company)
		let s = this.sessions.get(company)
		if (!s) {
			let password: string
			try {
				password = unseal(a.password, this.secret())
			} catch {
				throw new BadRequestException('Сохранённый пароль lit-na.ru не читается — введите его заново')
			}
			s = new LitnaSession({ login: a.login, password })
			this.sessions.set(company, s)
		}
		return s
	}

	/**
	 * Каталог сайта (~240 товаров, по 100 на страницу) — в памяти 10 минут, одна загрузка на всех ждущих.
	 * Сбой — прежний каталог, если он есть (иначе 502), и минуту без новых попыток.
	 */
	siteCatalog(): Promise<SiteProduct[]> {
		const cached = this.catalogCache
		if (cached && Date.now() - cached.at < CATALOG_TTL) return Promise.resolve(cached.items)
		if (Date.now() - this.catalogFailedAt < CATALOG_RETRY) {
			return cached ? Promise.resolve(cached.items) : Promise.reject(new BadGatewayException('lit-na.ru не отдал каталог'))
		}
		this.catalogLoading ??= this.loadCatalog()
			.catch((e) => {
				this.catalogFailedAt = Date.now()
				if (cached) return cached.items
				throw e
			})
			.finally(() => (this.catalogLoading = null))
		return this.catalogLoading
	}

	private async loadCatalog() {
		const s = new LitnaSession()
		const items: SiteProduct[] = []
		for (let page = 1; page <= 10; page++) {
			const list = await s.api(`/products?per_page=100&page=${page}`)
			if (!Array.isArray(list)) throw new BadGatewayException('lit-na.ru не отдал каталог')
			items.push(...list.map(siteProduct))
			if (list.length < 100) break
		}
		if (!items.length) throw new BadGatewayException('lit-na.ru не отдал каталог')
		this.catalogCache = { at: Date.now(), items }
		return items
	}

	/**
	 * Товары сайта и подсказка пар по названию — только для товаров, у которых пару ещё не выбирали (litnaId нет вовсе).
	 * seeds — по товарам шаблона «Семян», ключ — название товара шаблона.
	 */
	async catalog(seeds = false) {
		const site = await this.siteCatalog()
		// false — обновить каталог не вышло, отдан прежний
		const up = this.catalogFailedAt < (this.catalogCache?.at ?? 0)
		const own = seeds
			? ((await this.seedModel.findOne({ key: 'default' }).lean().exec())?.products || []).map((p) => ({ _id: p.name, name: p.name, price: p.price, litnaId: p.litnaId }))
			: await this.productModel.find({ deletedAt: null }).select('name price litnaId').lean().exec()
		const items = site.map((p) => ({ id: p.id, sku: p.sku, name: p.name, price: p.price, stock: p.stock, inStock: p.inStock, category: p.category, image: p.image }))
		// у товаров местности ещё и та же цена; у шаблона «Семян» цены не сверяем
		const suggest = suggestPairs(own.filter((p) => p.litnaId === undefined), site, !seeds)
		if (!seeds) return { items, suggest, up }
		// для формы создания местности «с lit-na.ru»: сколько товаров попадёт в засев и по каким видам
		const seed = siteSeed(site)
		const counts = new Map<string, number>()
		for (const p of seed) counts.set(p.category, (counts.get(p.category) || 0) + 1)
		return { items, suggest, up, count: seed.length, categories: [...counts].map(([name, count]) => ({ name, count })) }
	}

	/** Засев новой местности с сайта — до её создания: сайт недоступен или засеять нечего — местность не создаётся */
	async siteSeed() {
		let site: SiteProduct[]
		try {
			site = await this.siteCatalog()
		} catch {
			throw new BadGatewayException('Не удалось получить каталог lit-na.ru — местность не создана')
		}
		const products = siteSeed(site)
		if (!products.length) throw new BadGatewayException('В каталоге lit-na.ru нет товаров для засева — местность не создана')
		return { products, kindCovers: seedKindCovers(products) }
	}

	/**
	 * Фото засеянным товарам — фоном, после ответа: миниатюра сайта (та же, что /litna/thumb), в обычном хранилище фото
	 * местности и в пределах её квоты. Сбой картинки пропускается; к сайту — не больше 3 запросов сразу.
	 */
	async seedPhotos(companyId: string) {
		try {
			const company = new Types.ObjectId(companyId)
			const queue = await this.productModel.find({ company, litnaId: { $type: 'number' }, photo: null }).select('_id litnaId').lean().exec()
			let full = false
			const worker = async () => {
				for (let p = queue.shift(); p && !full; p = queue.shift()) {
					try {
						const { contentType, bytes } = await this.thumb(p.litnaId)
						// как у загрузки фото товара: до 512 КБ; квота местности — общая
						if (bytes.length > PHOTO_LIMIT) continue
						// сначала запись, потом подсчёт вместе с ней: загрузки фото в местность в это же время квоту не превысят
						const token = randomBytes(16).toString('hex')
						await this.photoModel.create({ company, token, contentType, data: bytes })
						const [used] = await this.photoModel
							.aggregate([{ $match: { company } }, { $group: { _id: null, bytes: { $sum: { $binarySize: '$data' } } } }])
							.exec()
						if ((used?.bytes || 0) > PHOTO_QUOTA) full = true
						const set = full ? null : await this.productModel.updateOne({ _id: p._id, company, photo: null }, { photo: token }).exec()
						if (!set?.matchedCount) await this.photoModel.deleteOne({ token }).exec()
					} catch {
						// нет картинки, сайт не отдал — товар остаётся с обложкой
					}
				}
			}
			await Promise.all([worker(), worker(), worker()])
			this.realtime.emit(companyId, 'product-updated')
		} catch (e) {
			this.logger.warn(`Фото засева с lit-na.ru не скопированы: ${(e as Error)?.message}`)
		}
	}

	/** Картинка товара сайта — для обложки нашего товара; на сервере не хранится */
	async image(siteId: number) {
		const src = (await this.siteCatalog()).find((p) => p.id === siteId)?.imageSrc
		if (!src) throw new NotFoundException('У товара на lit-na.ru нет картинки')
		// адрес — только lit-na.ru (иначе 502 в request), не больше 8 МБ, и только настоящая картинка по первым байтам
		const { res, bytes } = await new LitnaSession().request(src, { binary: true, limit: 8 * 1024 * 1024 })
		const contentType = res.ok ? imageType(bytes) : null
		if (!contentType) throw new BadGatewayException('lit-na.ru не отдал картинку')
		return { contentType, bytes }
	}

	/** Миниатюра товара сайта для списка выбора (~300 px): публично; в памяти — последние THUMBS штук на сутки, одна загрузка на товар */
	thumb(siteId: number): Promise<{ contentType: string; bytes: Buffer }> {
		const cached = this.thumbs.get(siteId)
		if (cached && Date.now() - cached.at < THUMB_TTL) return Promise.resolve({ contentType: cached.contentType, bytes: cached.bytes })
		// не вышло недавно — тот же ответ без похода на сайт: публичный адрес не должен сыпать запросами
		const failed = this.thumbFailed.get(siteId)
		if (failed && Date.now() - failed.at < THUMB_RETRY) return Promise.reject(failed.error)
		let loading = this.thumbLoading.get(siteId)
		if (!loading) {
			loading = this.loadThumb(siteId).finally(() => this.thumbLoading.delete(siteId))
			this.thumbLoading.set(siteId, loading)
		}
		return loading
	}

	private async loadThumb(siteId: number) {
		const product = (await this.siteCatalog()).find((p) => p.id === siteId)
		// неизвестный номер не запоминается: иначе публичным адресом можно забить память
		if (!product) throw new NotFoundException('Товар lit-na.ru не найден')
		let thumb: { contentType: string; bytes: Buffer }
		try {
			if (!product.thumbSrc) throw new NotFoundException('У товара на lit-na.ru нет картинки')
			const { res, bytes } = await new LitnaSession().request(product.thumbSrc, { binary: true, limit: THUMB_LIMIT })
			const contentType = res.ok ? imageType(bytes) : null
			if (!contentType) throw new BadGatewayException('lit-na.ru не отдал картинку')
			thumb = { contentType, bytes }
		} catch (error) {
			this.thumbFailed.set(siteId, { at: Date.now(), error })
			throw error
		}
		// самая старая — вон: Map помнит порядок добавления
		this.thumbs.delete(siteId)
		if (this.thumbs.size >= THUMBS) this.thumbs.delete(this.thumbs.keys().next().value)
		this.thumbs.set(siteId, { at: Date.now(), ...thumb })
		return thumb
	}

	/** Гостевая корзина с товаром в наличии (на сумму не меньше sum) и городом: по ней сайт считает доставку и отдаёт пункты */
	private async probe<T>(city: string, use: (s: LitnaSession, cart: any) => Promise<T>, sum = 0, nth = 0) {
		const item = (await this.siteCatalog())
			.filter((p) => p.inStock && p.price > 0)
			// сначала товары с артикулом: служебные позиции магазина (например «Тест») идут без него и считаются по-другому
			.sort((x, y) => Number(!x.sku) - Number(!y.sku))
			.map((p) => ({ id: p.id, quantity: Math.max(1, Math.ceil(sum / p.price)), stock: p.stock }))
			.filter((p) => p.quantity <= p.stock)[nth]
		if (!item) throw new BadGatewayException('На lit-na.ru нет товаров в наличии')
		// одноразовая гостевая сессия: корзину после пробы не чистим — истечёт сама
		const s = new LitnaSession()
		const { cart, problems } = await s.fillCart([{ id: item.id, quantity: item.quantity }], { city })
		if (problems.size) throw new BadGatewayException('lit-na.ru не положил товар в корзину')
		return use(s, cart)
	}

	/** Пункты Яндекса заранее, фоном: список (~15 МБ) грузится долго — к открытию окна пунктов он уже в памяти; попытка — не чаще раза в 10 минут */
	prewarmPoints() {
		if ((this.yandexCache && Date.now() - this.yandexCache.at < POINTS_TTL) || this.yandexLoading || Date.now() - this.pointsWarmAt < POINTS_WARM_EVERY) return
		this.pointsWarmAt = Date.now()
		this.yandexPoints().catch(() => null)
	}

	async points(kind: string, city: string) {
		if (kind === 'cdek') {
			const key = norm(city)
			const cached = this.cdekCache.get(key)
			if (cached && Date.now() - cached.at < CATALOG_TTL) return cached.points
			const points = await this.probe(city, async (_s, cart) => cdekPoints(cart).map((p) => ({ ...p, city: p.city || city })))
			this.cdekCache.set(key, { at: Date.now(), points })
			return points
		}
		const wanted = norm(city)
		return (await this.yandexPoints())
			.filter((p) => norm(p.cityname) === wanted)
			// name — что сохранять в аккаунт: так пункт подписывает сам сайт, и так он его ждёт при заказе
			.map((p) => ({ code: p.pointid, name: `${p.cityname} (${p.Address})`, address: p.Address, hours: p.WorkSchedule, city: p.cityname, postcode: p.zip }))
	}

	/** Пункты Яндекс Доставки всей страны — в памяти сутки. Токен виджета не храним: он приходит с сайта. */
	private yandexPoints() {
		if (this.yandexCache && Date.now() - this.yandexCache.at < POINTS_TTL) return Promise.resolve(this.yandexCache.points)
		// сбой загрузки — минуту тот же ответ: каждая попытка — корзина на сайте и ~15 МБ ответа
		if (this.yandexFailed && Date.now() - this.yandexFailed.at < CATALOG_RETRY) return Promise.reject(this.yandexFailed.error)
		this.yandexLoading ??= (async () => {
			// не всякую посылку Яндекс берёт (тяжёлую — нет): пробуем несколько разных товаров
			for (let nth = 0; nth < 4; nth++) {
				const points = await this.probe(YANDEX_PROBE_CITY, async (s, cart) => {
					const rate = shippingRates(cart).find((r) => r.kind === 'yandex_pvz')
					const button = rate && (await s.boxberryButton(rate.id, YANDEX_PROBE_CITY))
					return button ? s.boxberryPoints(button) : null
				}, YANDEX_PROBE_SUM, nth)
				if (points) {
					this.yandexCache = { at: Date.now(), points }
					return points
				}
			}
			throw new BadGatewayException('Не удалось открыть пункты Яндекс Доставки на lit-na.ru')
		})()
			.catch((error) => {
				this.yandexFailed = { at: Date.now(), error }
				throw error
			})
			.finally(() => (this.yandexLoading = null))
		return this.yandexLoading
	}

	private async draft(id: string) {
		const purchase = await this.purchaseModel.findById(id).lean().exec()
		if (!purchase) throw new NotFoundException('Закупка не найдена')
		if (purchase.isCreated) throw new BadRequestException('Закупка уже создана')
		return purchase
	}

	private say(purchase: { _id?: any; company?: any }, step: string, at: number) {
		const key = `${purchase.company}:${purchase._id}`
		this.steps.set(key, { step, at: Math.max(at, this.steps.get(key)?.at || 0) })
	}

	step(id: string, user: UserModel) {
		return this.steps.get(`${user.company}:${id}`) ?? { step: null, at: 0 }
	}

	quote(id: string, user: UserModel) {
		return measured('Расчёт lit-na.ru', async () => {
			const purchase = await this.draft(id)
			assertOwnPurchase(purchase, user)
			const account = await this.findAccount()
			const key = await this.quoteKey(purchase, account)
			const now = Date.now()
			for (const [k, v] of this.quotes) if (now - v.at >= QUOTE_TTL) this.quotes.delete(k)
			const hit = this.quotes.get(key)
			if (hit) return { ...hit.quote, addressDiffers: (await this.addressCheck()).same === false }
			const held: Partial<Held> = {}
			try {
				// сверка адреса с кабинетом сайта идёт рядом с расчётом (расчёт — в гостевой корзине, сверка — в сессии аккаунта)
				const [quote, address] = await Promise.all([this.calc(purchase, account, held), this.addressCheck()])
				this.quotes.set(key, { at: Date.now(), quote, held: held.session ? (held as Held) : undefined })
				return { ...quote, addressDiffers: address.same === false }
			} finally {
				this.steps.delete(`${purchase.company}:${purchase._id}`)
			}
		})
	}

	/** Ключ памяти расчёта: закупка, состав, пары товаров и вся запись аккаунта — любое изменение даёт новый расчёт */
	private async quoteKey(purchase: Purchase & { _id?: any }, account: LitnaAccount) {
		const items = (purchase.items || []).filter((i) => i.quantity > 0).map((i) => [String(i.product), i.quantity])
		const pairs = await this.productModel.find({ _id: { $in: items.map(([p]) => p) } }).select('litnaId').lean().exec()
		return JSON.stringify([String(purchase._id), items, pairs.map((p) => [String(p._id), p.litnaId ?? null]), account])
	}

	/** Свежий расчёт из памяти забирается: второй раз по нему не заказать (и гостевая сессия с заказом — уже не пустая) */
	private takeQuote(key: string) {
		const hit = this.quotes.get(key)
		this.quotes.delete(key)
		return hit && Date.now() - hit.at < QUOTE_TTL ? hit : null
	}

	/**
	 * Расчёт черновика в гостевой корзине (корзину аккаунта не трогаем): токен (GET /cart), строки и адрес одним пакетом,
	 * страница оформления. held — сессия с этой корзиной и выбранный способ, если к оформлению сайт пускает.
	 */
	private async calc(purchase: Purchase, account: LitnaAccount, held?: Partial<Held>) {
		const site = new Map((await this.siteCatalog()).map((p) => [p.id, p]))
		const items = (purchase.items || []).filter((i) => i.quantity > 0)
		// пара — в самом товаре (litnaId)
		const products = await this.productModel.find({ _id: { $in: items.map((i) => i.product) } }).select('name litnaId').lean().exec()
		const byId = new Map(products.map((p) => [String(p._id), p]))
		const lines = items.map((i) => {
			const product = String(i.product)
			const siteId = byId.get(product)?.litnaId ?? null
			const p = site.get(siteId)
			const problem: string | null = !siteId ? 'unlinked' : !p ? 'gone' : p.stock < i.quantity ? 'stock' : null
			return { product, name: byId.get(product)?.name || '', quantity: i.quantity, siteId, siteName: p?.name ?? null, price: p?.price ?? null, stock: p?.stock ?? null, problem }
		})
		// problems — только уровня заказа; у строк — свои (lines[].problem)
		const problems = new Set<string>()
		const kind = account?.delivery?.kind
		if (!ready(account)) problems.add('account')
		else if (isPvz(kind) && !account.delivery.code) problems.add('point')
		const linesOk = () => lines.every((l) => !l.problem)
		let rate: Rate | undefined
		let notice: string | null = null
		if (!problems.size && lines.length && linesOk()) {
			// одноразовая гостевая сессия: корзину после расчёта не чистим — истечёт сама
			const s = new LitnaSession()
			this.say(purchase, 'Открываем сайт', 1)
			const { cart, problems: rejected } = await s.fillCart(
				lines.map((l) => ({ id: l.siteId, quantity: l.quantity })),
				customer(account),
				() => this.say(purchase, 'Собираем корзину', 2)
			)
			const prices = cartPrices(cart)
			for (const l of lines) {
				l.problem = rejected.get(l.siteId) || null
				if (!l.problem && prices.has(l.siteId)) l.price = prices.get(l.siteId)
			}
			if (linesOk()) {
				rate = pickRate(shippingRates(cart), kind)
				if (!rate) problems.add('delivery')
				// пускает ли сайт к оформлению с такой корзиной (например, минимальная сумма заказа): нет формы — причина в уведомлениях
				this.say(purchase, 'Считаем доставку', 3)
				const page = (await s.request('/checkout/')).text
				if (!checkoutForm(page)?.['woocommerce-process-checkout-nonce']) {
					problems.add('site')
					notice = notices(page) || CLOSED
				} else if (rate && held) Object.assign(held, { session: s, rate })
			}
		}
		// адрес вписан руками: при бесплатной доставке посылка идёт по нему (manual — подпись «Адрес»), при платной — в пункт
		const toAddress = byHand(account) && rate?.kind === 'free'
		const point = byHand(account) && !toAddress ? account.delivery.title : account?.address || account?.delivery?.title
		const goods = kop(lines.reduce((sum, l) => sum + kop(l.price || 0) * l.quantity, 0) / 100) / 100
		const shipping = kop(rate?.price || 0) / 100
		return {
			lines,
			goods,
			shipping,
			total: (kop(goods) + kop(shipping)) / 100,
			free: rate?.kind === 'free',
			delivery: { kind: kind || null, title: TITLES[kind] || null, point: (isPvz(kind) && point) || '', ...(toAddress && { manual: true }) },
			problems: [...problems],
			notice,
			// пустой черновик заказывать нечего
			canOrder: !problems.size && lines.length > 0 && linesOk(),
		}
	}

	/** asGuest — этот заказ гостем, даже если вход сохранён (вход при этом не трогается) */
	order(id: string, total: number, user: UserModel, asGuest = false) {
		return measured('Заказ lit-na.ru', () =>
			this.locked(user, async () => {
				const purchase = await this.draft(id)
				assertOwnPurchase(purchase, user)
				try {
					return await this.orderDraft(purchase, total, user, asGuest)
				} finally {
					this.steps.delete(`${purchase.company}:${purchase._id}`)
				}
			})
		)
	}

	private async orderDraft(purchase: Purchase & { _id: any }, total: number, user: UserModel, asGuest: boolean) {
		let placed = (await this.orderModel.findOne(live(purchase._id)).lean().exec()) as Placed
		// прошлое оформление прервалось без ответа сайта: свой заказ ищется в кабинете по коду, а не оформляется второй раз
		if (placed) this.say(purchase, 'Ищем заказ на сайте', 1)
		if (placed && !placed.orderId) placed = await this.resume(placed)
		if (placed) return this.settle(placed, purchase, user)
		// только что оформленный: статус известен без запроса к сайту
		const fresh = await this.place(purchase, total, user, asGuest)
		try {
			return await this.settle(fresh, purchase, user, true)
		} finally {
			// корзину аккаунта — фоном и только после сверки суммы на странице оплаты: запрос той же сессии, начатый во время
			// очистки, вернул бы корзину назад (сайт пишет сессию в конце каждого запроса — проверено на сайте);
			// гостевую не трогаем: повтор оформления в той же сессии опирается на неё
			if (!fresh.guest) this.sessions.get(String(user.company))?.clearLater()
		}
	}

	/** По местности — одно оформление или удаление за раз: два сразу собирали бы одну корзину аккаунта и путали намерения */
	private async locked<T>(user: UserModel, run: () => Promise<T>) {
		const company = String(user.company)
		// не 409: 409 у заказа — новый расчёт
		if (this.ordering.has(company)) throw new BadRequestException(BUSY)
		this.ordering.add(company)
		try {
			return await run()
		} finally {
			this.ordering.delete(company)
		}
	}

	/** Вошедшая сессия местности (живая — без нового входа); не вошли — null и «вход перестал работать» в аккаунте */
	private async tryLogin(account: LitnaAccount) {
		try {
			const s = await this.session(account)
			await s.login()
			if (account.loginFailed) await this.accountModel.updateOne({ company: account.company }, { loginFailed: false }).exec()
			return s
		} catch (e) {
			// сайт недоступен — это не сломанный вход
			if (!(e instanceof BadRequestException)) throw e
			await this.accountModel.updateOne({ company: account.company }, { loginFailed: true }).exec()
			this.sessions.delete(String(account.company))
			this.warmed.delete(String(account.company))
			return null
		}
	}

	/** Вход проверяется в момент заказа: не вошли — отказ до любого шага на сайте; code — чтобы клиент отличил его от прочих 400 */
	private async signedIn(account: LitnaAccount) {
		const s = await this.tryLogin(account)
		if (!s) throw new BadRequestException({ code: 'LOGIN_FAILED', message: 'Не удалось войти на lit-na.ru — зайдите заново' })
		return s
	}

	/** Сессия для заказа: гостевой — без входа (по ключу заказа); заказ аккаунта — только под тем же аккаунтом */
	private async sessionFor(placed: Placed) {
		// гостевые страницы заказа сайт со временем открывает только после подтверждения почты заказа
		if (placed.guest) return new LitnaSession(undefined, undefined, placed.email || (await this.findAccount())?.email)
		const a = await this.findAccount()
		if (!loggedIn(a) || a.login !== placed.login) throw new BadRequestException(`Заказ оформлен под аккаунтом lit-na.ru ${placed.login} — зайдите заново под этим аккаунтом`)
		return this.session(a)
	}

	private async place(purchase: Purchase & { _id: any }, total: number, user: UserModel, asGuest = false): Promise<Placed> {
		const company = String(user.company)
		const account = await this.findAccount()
		// без входа — гостем: своя сессия на сайте, её куки сохраняются, чтобы после потерянного ответа повторить в ней же
		const guest = asGuest || !loggedIn(account)
		// свежий расчёт (до 30 с) не пересчитывается: сверка — по корзине заказа и сумме к оплате после оформления
		const memo = this.takeQuote(await this.quoteKey(purchase, account))
		const now: Partial<Held> = {}
		const quote = memo?.quote ?? (await this.calc(purchase, account, now))
		// 409 — тело сам расчёт: клиент показывает его заново
		if (!quote.canOrder || kop(quote.total) !== kop(total)) throw new ConflictException(quote)
		// гостю — сессия расчёта: корзина и адрес в ней уже есть
		const held = guest ? memo?.held || (now.session ? (now as Held) : undefined) : undefined
		if (!guest) this.say(purchase, 'Входим в аккаунт', 1)
		let s = guest ? held?.session || new LitnaSession() : await this.signedIn(account)
		// у аккаунта самый новый заказ кабинета — граница: свой заказ после сбоя ищется среди более новых. Читается, пока пишется
		// намерение, и дочитывается ДО сборки корзины: запрос той же сессии, начатый раньше правки корзины и законченный позже,
		// вернул бы корзину назад (сайт пишет сессию в конце каждого запроса)
		const before = guest ? null : s.orders()
		before?.catch(() => null)
		const code = Array.from(randomBytes(8), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('')
		// Намерение — до корзины и оформления. Закупку с ним нельзя ни править, ни создать «вручную», ни удалить обычным путём.
		const info = { orderId: null, status: 'placing', shipping: quote.shipping, total: quote.total, delivery: quote.delivery, createdAt: Date.now() }
		const doc = {
			company,
			purchase: purchase._id,
			startedAt: Date.now(),
			login: guest ? null : account.login,
			email: account.email,
			guest,
			// у аккаунта граница пишется вместе с отправкой формы: нет её — форма не уходила
			seen: guest ? 0 : null,
			code,
			expected: quote.total,
			info,
			lines: quote.lines.map((l) => ({ product: l.product, quantity: l.quantity, price: l.price })),
		}
		const { _id } = await this.orderModel.create(doc).catch((e) => {
			throw e?.code === 11000 ? new BadRequestException(BUSY) : e
		})
		const placing: Placed = { _id, ...doc }
		const marked = await this.purchaseModel.updateOne({ _id: purchase._id, isCreated: false }, { litna: info }).exec()
		if (!marked.matchedCount) {
			await this.drop(placing)
			throw new NotFoundException('Закупка не найдена')
		}
		let fields: Record<string, string>
		let result: Awaited<ReturnType<LitnaSession['checkout']>>
		try {
			await before?.catch(() => null)
			// сессия расчёта: форма открылась — корзина на месте; нет (сессия умерла, корзина пуста) — собираем заново
			this.say(purchase, 'Готовим заказ', 2)
			const form = held ? await s.orderForm().catch(() => null) : undefined
			if (held && !form) s = new LitnaSession()
			if (form) this.say(purchase, 'Вносим адрес', 4)
			fields = form ? await this.choose(s, account, held.rate) : await this.prepare(s, account, purchase, quote)
			// код — в начале: сайт может обрезать длинное примечание
			fields.order_comments = `${code} · Skladan · закупка №${purchase.purchaseNumber}`
			// выдержка — от момента отправки формы, а не от сборки корзины; гостю — и куки сессии с собранной корзиной
			this.say(purchase, 'Оформляем заказ', 5)
			result = await s.checkout(
				fields,
				async () => {
					const list = before && (await before)
					if (before && !list) throw new BadGatewayException('Не удалось открыть заказы на lit-na.ru')
					placing.startedAt = Date.now()
					if (list) placing.seen = Math.max(0, ...list.orders.map((o) => o.orderId))
					// гостю — куки сессии и сами поля формы: повтор после потерянного ответа идёт с тем же способом, пунктом и получателем
					placing.cookies = guest ? s.dump() : undefined
					placing.sent = guest ? fields : undefined
					await this.orderModel
						.updateOne({ _id }, { startedAt: placing.startedAt, ...(list && { seen: placing.seen }), ...(guest && { cookies: placing.cookies, sent: fields }) })
						.exec()
				},
				form || undefined
			)
		} catch (e) {
			// до отправки формы: заказа на сайте нет
			await this.drop(placing)
			throw e
		}
		if ('orderId' in result) return this.bind(placing, result.orderId, result.orderKey)
		if (guest) return this.guestRetry(placing, s, fields, result, purchase, user)
		// Отказ или потерянный ответ: WooCommerce отвечает отказом и после создания заказа — сначала ищем свой по коду.
		// Неуверенность — исключение из recover, намерение остаётся.
		const found = await this.recover(placing)
		if (found) return found
		if ('error' in result) {
			// доказано, что заказа нет, и сайт отказал явно — ждать нечего
			await this.drop(placing)
			throw new BadRequestException(`lit-na.ru: ${result.error}`)
		}
		// ответ потерян, заказа пока нет: сайт мог ещё не дописать его — намерение остаётся, повтор подождёт
		throw new BadRequestException(BUSY)
	}

	/** Корзина заказа заново (корзину аккаунта сайт после заказа сам не чистит) с адресом, сверка суммы, способ и пункт → поля формы */
	private async prepare(s: LitnaSession, account: LitnaAccount, purchase: Purchase, quote: Quote) {
		const { cart, problems } = await s.fillCart(
			quote.lines.map((l) => ({ id: l.siteId, quantity: l.quantity })),
			customer(account),
			() => this.say(purchase, 'Собираем корзину', 3)
		)
		const rate = pickRate(shippingRates(cart), account.delivery.kind)
		const prices = cartPrices(cart)
		const sum = rate && quote.lines.reduce((t, l) => t + kop(prices.get(l.siteId)) * l.quantity, kop(rate.price))
		if (problems.size || sum !== kop(quote.total)) {
			// на сайте только что сменились цены или наличие: человеку — свежий пересчёт, а не прежний расчёт
			this.catalogCache = null
			throw new ConflictException({ ...(await this.calc(purchase, account)), message: 'На lit-na.ru изменились цены или наличие' })
		}
		this.say(purchase, 'Вносим адрес', 4)
		return this.choose(s, account, rate)
	}

	/** Поля формы и пункт выдачи в сессии сайта (корзина и адрес в ней уже есть) */
	private async choose(s: LitnaSession, account: LitnaAccount, rate: Rate) {
		const { code, title } = account.delivery
		const fields = this.fields(account, rate)
		// пункт — до оформления, и с проверкой: без него заказ ушёл бы без пункта
		if (rate.kind === 'cdek_pvz') {
			if (!isSuccess((await s.form('/?wc-ajax=official_cdek_save-office', { code })).text)) {
				throw new BadRequestException('lit-na.ru не принял пункт CDEK — выберите пункт заново')
			}
			fields.office_code = code
		}
		if (rate.kind === 'yandex_pvz') {
			// сайт отвечает «0» и при успехе; признак успеха — куки выбранного пункта
			await s.form('/wp-admin/admin-ajax.php', { action: 'boxberry_update', method: 'boxberry_self', code, address: title || code })
			if (decodeURIComponent(s.cookie('bxb_code') || '') !== code || !s.cookie('bxb_address')) {
				throw new BadRequestException('lit-na.ru не принял пункт Яндекс Доставки — выберите пункт заново')
			}
		}
		return fields
	}

	/** Поля формы оформления: получатель (у гостя почта и телефон — для письма и связи), способ, оплата */
	private fields(account: LitnaAccount, rate: Rate): Record<string, string> {
		return {
			...Object.fromEntries(Object.entries({ ...customer(account), country: 'RU' }).map(([k, v]) => [`billing_${k}`, v || ''])),
			'shipping_method[0]': rate.id,
			payment_method: 'robokassa',
			privacy_policy_checkbox: 'on',
			_wp_http_referer: '/?wc-ajax=update_order_review',
		}
	}

	/**
	 * Снять запись заказа: заказа на сайте нет (или он отменён) — закупка снова обычная (и уже доведённая — тоже,
	 * без заказа ей «создана с lit-na.ru» не быть). Запись с номером заказа остаётся помеченной — след для поздней оплаты.
	 */
	private async drop(placed: Placed) {
		if (placed.orderId) await this.orderModel.updateOne({ _id: placed._id }, { deletedAt: new Date() }).exec()
		else await this.orderModel.deleteOne({ _id: placed._id }).exec()
		await this.purchaseModel.updateOne({ _id: placed.purchase }, { $unset: { litna: 1 } }).exec()
		this.refresh(placed.company)
	}

	private async bind(placed: Placed, orderId: number, orderKey: string, status = 'pending'): Promise<Placed> {
		const info = { ...placed.info, orderId, status }
		// куки гостевой сессии больше не нужны: заказ дальше обслуживается по ключу
		await this.orderModel.updateOne({ _id: placed._id }, { orderId, orderKey, info, $unset: { cookies: 1, sent: 1 } }).exec()
		await this.purchaseModel.updateOne({ _id: placed.purchase }, { litna: info }).exec()
		this.refresh(placed.company)
		return { ...placed, orderId, orderKey, info }
	}

	/**
	 * Свой заказ после потерянного ответа: среди заказов кабинета новее границы — тот, на странице которого наш код.
	 * Чужие (без кода) не трогаются никогда. null — доказано, что нашего заказа нет; любая неуверенность — 400, запись остаётся.
	 */
	private async recover(placed: Placed) {
		// граница пишется вместе с отправкой формы: её нет — форма не уходила, заказа на сайте нет
		if (placed.seen == null) return null
		const account = await this.findAccount()
		// под другим аккаунтом заказа не видно — это не доказательство, что его нет
		if (!placed.code || !account?.login || account.login !== placed.login) throw new BadRequestException(CHECK_SITE)
		const s = await this.session(account)
		const list = await s.orders()
		if (!list) throw new BadRequestException(CHECK_SITE)
		const seen = placed.seen || 0
		for (const o of list.orders.filter((o) => o.orderId > seen).sort((a, b) => b.orderId - a.orderId)) {
			const page = await s.orderText(o.orderId)
			if (page === null) throw new BadRequestException(CHECK_SITE)
			if (!page.includes(placed.code)) continue
			// ключ есть только у ожидающего оплаты (в ссылке «Оплатить»); оплаченный и отменённый ведём по статусу строки
			if (!o.orderKey && !isPaidStatus(o.status) && !isCancelled(o.status)) throw new BadRequestException(CHECK_SITE)
			return this.bind(placed, o.orderId, o.orderKey || '', o.status)
		}
		// видна только первая страница: отсутствие доказано, лишь если видны все заказы новее границы
		const complete = seen > 0 ? list.orders.some((o) => o.orderId <= seen) : list.orders.length < ORDERS_PAGE && !list.more
		if (!complete) throw new BadRequestException(CHECK_SITE)
		return null
	}

	/**
	 * Гость: кабинета нет. Сайт ответил отказом — он уже закончил, и повтор в той же сессии с той же корзиной сайт
	 * сведёт к уже созданному ожидающему заказу (order_awaiting_payment), если тот появился. Ответ потерян — сайт мог
	 * ещё работать: повтор — только после выдержки (resume).
	 */
	private async guestRetry(
		placing: Placed,
		s: LitnaSession,
		fields: Record<string, string>,
		first: { error: string } | { unknown: string },
		purchase: Purchase,
		user: UserModel
	) {
		if ('unknown' in first) throw new BadRequestException(BUSY)
		const again = await s.checkout(fields)
		if ('orderId' in again) return this.bind(placing, again.orderId, again.orderKey)
		// Тот же отказ: данные не менялись — снимаем. Если отказ был уже после создания заказа (сбой шлюза дважды), на сайте
		// остался неоплаченный заказ: магазин отменит его по таймеру, а след — в истории и в ответе (код из примечания)
		if ('error' in again) {
			await this.drop(placing)
			const left = `на сайте мог остаться неоплаченный заказ с кодом ${placing.code}`
			await this.changeHistory.createChangeHistory(
				{
					user: user._id,
					changeType: 'litna-released',
					description: `Оформление на lit-na.ru снято после отказа сайта, закупка ${purchase.purchaseNumber}; ${left}`,
					changeDate: Date.now(),
				},
				{ push: false }
			)
			throw new BadRequestException(`lit-na.ru: ${again.error}`)
		}
		throw new BadRequestException(GUEST_CHECK)
	}

	/**
	 * Гостевое намерение: поднять ту же сессию; корзина на месте — отправить оформление ещё раз, не пересобирая её
	 * (сайт вернёт уже созданный заказ, а не новый). Сессия умерла — доказать ничего нельзя: намерение остаётся.
	 */
	private async guestResume(placed: Placed) {
		if (Date.now() - placed.startedAt < PLACING_FRESH) throw new BadRequestException(BUSY)
		// те же поля, что при первой отправке (способ, пункт, получатель), а не нынешние настройки аккаунта
		const fields = placed.sent
		const s = new LitnaSession(undefined, placed.cookies)
		const cart = placed.cookies?.length && fields ? await s.api('/cart') : null
		const method = fields?.['shipping_method[0]']
		if (!cart?.items?.length || !shippingRates(cart).some((r) => r.id === method)) throw new BadRequestException(GUEST_CHECK)
		const again = await s.checkout(fields)
		if ('orderId' in again) return this.bind(placed, again.orderId, again.orderKey)
		throw new BadRequestException(GUEST_CHECK)
	}

	/** Незавершённое намерение: свой заказ нашёлся — продолжаем с ним; доказано, что его нет, — снимаем (не раньше выдержки) */
	private async resume(placed: Placed) {
		if (placed.guest) return this.guestResume(placed)
		const found = await this.recover(placed)
		if (found) return found
		if (Date.now() - placed.startedAt < PLACING_FRESH) throw new BadRequestException(BUSY)
		await this.drop(placed)
		return null
	}

	/** Статус заказа; без ключа (заказ найден по коду уже оплаченным или отменённым) — тот, что был в строке кабинета */
	private statusOf(placed: Placed): Promise<SiteStatus> {
		return placed.orderKey ? this.siteStatus(placed) : Promise.resolve(known(placed))
	}

	/**
	 * Довести черновик с заказом: отменён на сайте — снова черновик и новый расчёт; оплачен — «создана» и «оплачена»;
	 * ожидает оплаты — сумма к оплате должна совпасть с расчётом, не совпала — заказ отменяется.
	 */
	private async settle(placed: Placed, purchase: Purchase, user: UserModel, fresh = false) {
		const site = fresh ? known(placed) : await this.statusOf(placed)
		const recalc = async (message: string) => new ConflictException({ ...(await this.calc(purchase, await this.findAccount())), message })
		if (isCancelled(site.status)) {
			await this.drop(placed)
			throw await recalc(`Заказ №${placed.orderId} отменён на lit-na.ru — проверьте расчёт и оформите заново`)
		}
		if (site.paid) {
			await this.finish(placed, user)
			return this.markPaid(placed, user, site.status)
		}
		this.say(purchase, 'Сверяем сумму', 6)
		const onSite = paySum(await (await this.sessionFor(placed)).orderPayment(placed.orderId, placed.orderKey))
		if (kop(onSite) !== kop(placed.expected)) {
			const message = `Сумма к оплате на lit-na.ru (${onSite} ₽) не совпала с расчётом (${placed.expected} ₽)`
			if (!(await this.cancel(placed, site))) throw new BadRequestException(`${message}, а отменить заказ №${placed.orderId} не удалось — ${cancelHint(placed)}`)
			await this.drop(placed)
			throw await recalc(`${message} — заказ отменён, проверьте расчёт`)
		}
		return this.finish(placed, user)
	}

	/** Закупка → «создана» штатным путём; строки — с ценами сайта, доставка в totalAmount не входит */
	private async finish(placed: Placed, user: UserModel) {
		const items = placed.lines.map((l) => ({ ...l, confirmedQuantity: 0 }))
		const written = await this.purchaseModel
			.updateOne({ _id: placed.purchase, isCreated: false }, { litna: placed.info, items, totalAmount: kop(linesSum(items)) / 100, totalConfirmedAmount: 0 })
			.exec()
		// уже доведена — второй раз строки не переписываем и «создана» не ставим
		if (!written.matchedCount) return this.purchaseModel.findById(placed.purchase).exec()
		return this.purchases.update(String(placed.purchase), { isCreated: true }, user, true)
	}

	private async placed(id: string) {
		const purchase = await this.purchaseModel.findById(id).lean().exec()
		const placed = purchase && ((await this.orderModel.findOne(live(purchase._id)).lean().exec()) as Placed)
		if (!placed?.orderId) throw new NotFoundException('Заказ на lit-na.ru по этой закупке не найден')
		return { purchase, placed }
	}

	/** Счёт или накладная (упаковочный лист) заказа на сайте — PDF как есть, ключ доступа к документу остаётся на сервере */
	async doc(id: string, type: 'invoice' | 'packing') {
		const { placed } = await this.placed(id)
		const { orderId, orderKey } = placed
		// у гостя кабинета нет: ссылка — на странице оплаты или «заказ получен» (по ключу заказа)
		const pages = placed.guest
			? [`/checkout/order-pay/${orderId}/?pay_for_order=true&key=${orderKey}`, `/checkout/order-received/${orderId}/?key=${orderKey}`]
			: [`/my-account/view-order/${orderId}/`]
		const bytes = await (await this.sessionFor(placed)).doc(orderId, type === 'invoice' ? 'invoice' : 'packing-slip', pages)
		if (!bytes) throw new NotFoundException('Документ на сайте недоступен')
		return { bytes, name: `${type === 'invoice' ? 'schet' : 'nakladnaya'}-${placed.orderId}.pdf` }
	}

	/** Отметка оплаты от имени того, кто открыл оплату: история и уведомления — как при обычной оплате; в litna — статус сайта и время */
	private async markPaid(placed: Placed, user: UserModel, status: string) {
		const payer = (placed.payer && (await this.userModel.findById(placed.payer).exec())) || user
		await this.purchaseModel.updateOne({ _id: placed.purchase }, { 'litna.status': status, 'litna.paidAt': Date.now() }).exec()
		return this.purchases.update(String(placed.purchase), { isPaid: true }, payer, true)
	}

	/** Черновик с заказом доводится только под замком местности — как в оформлении и удалении */
	private async draftLocked<T>(id: string, user: UserModel, run: () => Promise<T>) {
		const { purchase } = await this.placed(id)
		return purchase.isCreated || purchase.isPaid ? run() : this.locked(user, run)
	}

	pay(id: string, user: UserModel) {
		return measured('Форма оплаты lit-na.ru', async () => {
			const key = id.toLowerCase()
			if (this.closing.has(key)) throw new BadRequestException('Закупку сейчас отвязывают или удаляют — оплата не открыта')
			this.paying.set(key, (this.paying.get(key) || 0) + 1)
			try {
				return await this.draftLocked(id, user, () => this.payPlaced(id, user))
			} finally {
				const left = this.paying.get(key) - 1
				if (left > 0) this.paying.set(key, left)
				else this.paying.delete(key)
			}
		})
	}

	/** Закрытие закупки (отвязка, удаление): не начинается, пока по ней выдаётся форма оплаты, и не даёт выдать её, пока идёт */
	private async closingOf<T>(id: string, run: () => Promise<T>) {
		const key = id.toLowerCase()
		if (this.paying.has(key)) throw new BadRequestException('По закупке сейчас открывают оплату — повторите через минуту')
		this.closing.add(key)
		try {
			return await run()
		} finally {
			this.closing.delete(key)
		}
	}

	private async payPlaced(id: string, user: UserModel) {
		const { purchase, placed } = await this.placed(id)
		assertOwnPurchase(purchase, user)
		if (purchase.isPaid) return { paid: true, purchase }
		const site = await this.statusOf(placed)
		// «заказа нет» с первого раза — не повод: один сбой сайта не должен «забыть» живой заказ
		if (site.missing && !(await this.missingConfirmed(placed))) throw new BadGatewayException(`lit-na.ru не нашёл заказ №${placed.orderId} — повторите позже`)
		if (isCancelled(site.status)) {
			// отменённый черновик снова обычный; созданная закупка — тоже черновик (не раньше выдержки после формы оплаты)
			if (purchase.isCreated) {
				const draft = await this.revert(purchase, placed, user)
				if (draft) throw new ConflictException({ code: 'ORDER_CANCELLED', message: revertedText(placed), purchase: draft })
				await this.setStatus(purchase, site.status, user)
			} else await this.drop(placed)
			throw new BadRequestException('Заказ отменён на сайте')
		}
		if (placed.missingAt) await this.orderModel.updateOne({ _id: placed._id }, { $unset: { missingAt: 1 } }).exec()
		// черновик с заказом (оформление прервалось после ответа сайта) не должен застревать
		if (!purchase.isCreated) await this.finish(placed, user)
		if (site.paid) return { paid: true, purchase: await this.markPaid(placed, user, site.status) }
		// время выдачи формы — до запроса к сайту и только у незакрытой записи: возврат в черновик между ними ловится здесь
		const open = await this.orderModel.findOneAndUpdate({ _id: placed._id, deletedAt: null }, { payer: user._id, payAt: Date.now() }, { new: true }).lean().exec()
		if (!open) {
			throw new ConflictException({ code: 'ORDER_CANCELLED', message: revertedText(placed), purchase: await this.purchaseModel.findById(purchase._id).lean().exec() })
		}
		const form = await (await this.sessionFor(placed)).orderPayment(placed.orderId, placed.orderKey)
		const onSite = paySum(form)
		const expected = placed.info?.total ?? purchase.litna?.total
		if (kop(onSite) !== kop(expected)) {
			throw new ConflictException({ message: `Сумма к оплате на lit-na.ru (${onSite} ₽) не совпадает с закупкой (${expected} ₽)`, site: onSite, expected })
		}
		return form
	}

	/** Статус заказа: сначала без входа (хватает ключа заказа и куки хостинга), непонятный ответ — через сессию местности */
	private async siteStatus(placed: Placed): Promise<SiteStatus> {
		const ask = (s: LitnaSession) => s.orderStatus(placed.orderId, placed.orderKey)
		let status = await ask(new LitnaSession())
		// у гостевого заказа другой сессии нет
		if (!status && !placed.guest) {
			const s = await this.sessionFor(placed)
			status = await ask(s)
			if (!status) {
				await s.login()
				status = await ask(s)
			}
		}
		if (!status) throw new BadGatewayException('lit-na.ru не сообщил статус заказа')
		return status
	}

	/**
	 * Заказ без ключа (оформлен на самом сайте или найден в кабинете уже оплаченным): статус — из строки списка заказов кабинета.
	 * null — спросить не у кого: в этой сессии сайта сейчас оформляют заказ или заказа нет на первой странице списка.
	 */
	private async listedStatus(placed: Placed): Promise<SiteStatus | null> {
		if (this.ordering.has(String(placed.company))) return null
		// сохранённый вход уже не работает — раз в час неудачно входить на сайт незачем, ждём входа человека
		if ((await this.findAccount())?.loginFailed) return null
		// shortcut: видна только первая страница списка заказов; ушёл с неё — статус больше не меняется, тогда читать страницу заказа
		const list = await (await this.sessionFor(placed)).orders()
		// список не разобран (сайт сменил страницу, не вошли) — в журнал, а не молча: иначе слежение тихо остановится
		if (!list) throw new BadGatewayException('lit-na.ru не показал заказы кабинета')
		const row = list.orders.find((o) => o.orderId === placed.orderId)
		if (!row) return null
		// запись заказа знает статус сама: по ней (без ключа) отвечают остальные проверки
		if (row.status !== placed.info?.status) await this.orderModel.updateOne({ _id: placed._id }, { info: { ...placed.info, status: row.status } }).exec()
		return { paid: isPaidStatus(row.status), status: row.status }
	}

	async check(id: string, user: UserModel) {
		return this.draftLocked(id, user, () => this.checkPlaced(id, user))
	}

	// отмена на сайте не окончательна: отменённый заказ сайт тоже даёт оплатить — тогда закупка отмечается оплаченной
	private async checkPlaced(id: string, user: UserModel) {
		const { purchase, placed } = await this.placed(id)
		if (purchase.isPaid) return { paid: true, status: purchase.litna?.status ?? null, purchase }
		const site = await this.memoStatus(placed)
		// «заказа нет» с первого раза — ничего не меняем, спросим снова
		if (site.missing && !(await this.missingConfirmed(placed))) return { paid: false, status: purchase.litna?.status ?? null, purchase }
		if (!site.missing && placed.missingAt) await this.orderModel.updateOne({ _id: placed._id }, { $unset: { missingAt: 1 } }).exec()
		let result: any = purchase
		if (!purchase.isCreated) {
			// черновик с заказом не должен застревать: отменён — снова черновик, иначе — «создана»
			if (isCancelled(site.status)) {
				await this.drop(placed)
				return { paid: false, status: site.status, purchase: await this.purchaseModel.findById(purchase._id).lean().exec() }
			}
			result = await this.finish(placed, user)
		} else if (isCancelled(site.status)) {
			const draft = await this.revert(purchase, placed, user)
			if (draft) return { paid: false, status: 'cancelled', reverted: true, message: revertedText(placed), purchase: draft }
		}
		if (site.status !== result.litna?.status) result = await this.setStatus(result, site.status, user)
		if (site.paid) result = await this.markPaid(placed, user, site.status)
		return { paid: site.paid, status: site.status, purchase: result }
	}

	private async setStatus(purchase: any, status: string, user: UserModel) {
		const result = await this.purchaseModel.findByIdAndUpdate(purchase._id, { 'litna.status': status }, { new: true }).lean().exec()
		this.refresh(user.company)
		return result
	}

	/** Ответ сайта о заказе — один на несколько секунд (CHECK_MEMO) для всех, кто спрашивает про эту закупку */
	private memoStatus(placed: Placed) {
		const key = String(placed._id)
		const memo = this.statusMemo.get(key)
		if (memo && Date.now() - memo.at < CHECK_MEMO) return memo.status
		const status = this.statusOf(placed)
		this.statusMemo.set(key, { at: Date.now(), status })
		status.catch(() => this.statusMemo.delete(key))
		return status
	}

	/** «Заказа с таким ключом нет»: верим только повтору не раньше MISSING_CONFIRM после первого такого ответа */
	private async missingConfirmed(placed: Placed) {
		if (!placed.missingAt) {
			await this.orderModel.updateOne({ _id: placed._id, missingAt: null }, { missingAt: Date.now() }).exec()
			return false
		}
		return Date.now() - placed.missingAt >= MISSING_CONFIRM
	}

	/**
	 * Заказ на сайте отменён или его там нет — созданная закупка снова черновик, запись заказа помечается закрытой (след
	 * остаётся). Не раньше 30 минут после выдачи формы оплаты (сайт принимает оплату и у отменённого заказа) и не во
	 * время оформления в этой местности. null — не переводим (статус «отменён» остаётся в закупке, проверка спрашивает дальше).
	 */
	private async revert(purchase: Purchase, placed: Placed, user: UserModel) {
		if (purchase.isPaid || this.ordering.has(String(user.company))) return null
		return this.locked(user, async () => {
			// Первым — условно закрыть запись: «не закрыта» и «форму оплаты не выдавали последние 30 минут» одним запросом.
			// Форма, выданная в это же мгновение, этому помешает (она пишет payAt только у незакрытой записи).
			const closed = await this.orderModel
				.findOneAndUpdate(
					{ _id: placed._id, deletedAt: null, $or: [{ payAt: null }, { payAt: { $lt: Date.now() - PAY_HOLD } }] },
					{ deletedAt: new Date(), deletedBy: user._id },
					{ new: true }
				)
				.lean()
				.exec()
			if (!closed) return null
			const description = `Заказ №${placed.orderId} отменён на lit-na.ru — закупка №${purchase.purchaseNumber} переведена в черновик`
			const draft = await this.purchases.toDraft(String(placed.purchase), user, description)
			// закупку не перевели (её успели оплатить или принять) — запись снова открыта
			if (!draft) await this.orderModel.updateOne({ _id: placed._id }, { deletedAt: null, $unset: { deletedBy: 1 } }).exec()
			return draft
		})
	}

	/** Отмена ссылкой: из кабинета, у гостя — со страницы «заказ получен» (на странице оплаты ссылки нет — проверено на сайте); удалась — только если сайт после неё говорит «отменён» */
	private async cancel(placed: Placed, site: SiteStatus) {
		// «заказа нет» — не «отменён»: может быть сбоем сайта, отменять всё равно надо по ссылке
		if (isCancelled(site.status) && !site.missing) return true
		const from = placed.guest ? `/checkout/order-received/${placed.orderId}/?key=${placed.orderKey}` : undefined
		if (site.paid || !(await (await this.sessionFor(placed)).cancelOrder(placed.orderId, from))) return false
		return isCancelled((await this.statusOf(placed)).status)
	}

	async remove(id: string, user: UserModel) {
		return this.locked(user, () => this.closingOf(id, () => this.removeLocked(id, user)))
	}

	private async removeLocked(id: string, user: UserModel) {
		{
			const purchase = await this.purchaseModel.findById(id).lean().exec()
			if (purchase) assertOwnPurchase(purchase, user)
			let placed = purchase && ((await this.orderModel.findOne(live(purchase._id)).lean().exec()) as Placed)
			// Гостевое намерение без номера: оформление не досылаем (создали бы заказ, чтобы тут же отменять) — свежее ждёт,
			// старое снимается, как «Снять оформление». Аккаунта: свой заказ по коду нашёлся — отменяем ниже; доказано, что
			// его нет, — намерение снимается.
			if (placed && !placed.orderId && placed.guest) {
				if (Date.now() - placed.startedAt < PLACING_FRESH) throw new BadRequestException(BUSY)
				await this.drop(placed)
				await this.changeHistory.createChangeHistory({
					user: user._id,
					changeType: 'litna-released',
					description: `Оформление на lit-na.ru снято при удалении закупки ${purchase.purchaseNumber}`,
					changeDate: Date.now(),
				})
				placed = null
			}
			if (placed && !placed.orderId) placed = await this.resume(placed)
			const paying = placed?.payAt ? PAY_HOLD - (Date.now() - placed.payAt) : 0
			if (paying > 0) throw new BadRequestException(`Оплата могла начаться — удалить можно через ${minutesLeft(paying)} мин`)
			if (placed && !purchase.isPaid) {
				const site = await this.statusOf(placed)
				if (site.paid) throw new BadRequestException('Заказ уже оплачен на lit-na.ru — удалить закупку нельзя')
				if (!(await this.cancel(placed, site))) throw new BadRequestException(`Не удалось отменить заказ №${placed.orderId} на lit-na.ru — ${cancelHint(placed)}`)
			}
			const removed = await this.purchases.remove(id, user, true)
			// запись не стирается: заказ на сайте остаётся, и его поздняя оплата должна быть видна
			if (placed) await this.orderModel.updateOne({ _id: placed._id }, { deletedAt: new Date(), deletedBy: user._id }).exec()
			return removed
		}
	}

	/**
	 * Отвязать созданную неоплаченную закупку от заказа сайта: она становится обычной («Вручную»). Заказ на сайте отменяется
	 * (сайт заказы не удаляет), как при удалении закупки; сайт недоступен — отвязывается без отмены (ради этого случая
	 * «Отвязать» и есть), а поздняя оплата неотменённого заказа проверяется ещё трое суток. Запись заказа закрывается — след остаётся.
	 */
	async detach(id: string, user: UserModel) {
		return this.locked(user, () => this.closingOf(id, () => this.detachLocked(id, user)))
	}

	private async detachLocked(id: string, user: UserModel) {
		{
			const purchase = await this.purchaseModel.findById(id).lean().exec()
			if (!purchase) throw new NotFoundException('Закупка не найдена')
			assertOwnPurchase(purchase, user)
			if (!purchase.litna) throw new BadRequestException('Закупка не связана с заказом lit-na.ru')
			if (!purchase.isCreated) throw new BadRequestException('Закупка ещё не создана — снимите оформление')
			if (purchase.isPaid) throw new BadRequestException('Закупка уже оплачена')
			const placed = (await this.orderModel.findOne(live(purchase._id)).lean().exec()) as Placed
			const paying = placed?.payAt ? PAY_HOLD - (Date.now() - placed.payAt) : 0
			if (paying > 0) throw new BadRequestException(`Оплата могла начаться — отвязать можно через ${minutesLeft(paying)} мин`)
			// null — сайт недоступен (сеть, 5xx, непонятный ответ): отвязываем без отмены
			const reachable = <T>(ask: Promise<T>) => ask.catch((e) => (e instanceof BadGatewayException ? null : Promise.reject(e)))
			const site = placed?.orderId ? await reachable(this.statusOf(placed)) : null
			if (site?.paid) {
				await this.markPaid(placed, user, site.status)
				throw new BadRequestException(`Заказ №${placed.orderId} уже оплачен на lit-na.ru`)
			}
			// отменён или «заказа нет» — отменять нечего; «заказа нет» мог быть сбоем сайта, поэтому такая запись остаётся под поздней проверкой оплаты
			let cancelled = !!site && isCancelled(site.status)
			if (site && !cancelled) {
				// отменить не вышло (вход, ссылки нет, сайт не подтвердил) — не отвязываем; сайт пропал посреди отмены — отвязываем без неё
				const done = await reachable(this.cancel(placed, site).catch((e) => (e instanceof BadRequestException ? false : Promise.reject(e))))
				if (done === false) throw new BadRequestException(`Не удалось отменить заказ №${placed.orderId} на lit-na.ru — ${cancelHint(placed)}`)
				cancelled = !!done
			}
			if (placed) {
				await this.orderModel
					.updateOne({ _id: placed._id }, { deletedAt: new Date(), deletedBy: user._id, ...((!cancelled || site?.missing) && placed.orderId && { detachedAt: Date.now() }) })
					.exec()
			}
			await this.purchaseModel.updateOne({ _id: purchase._id, isPaid: { $ne: true } }, { $unset: { litna: 1 } }).exec()
			const orderId = purchase.litna.orderId ?? placed?.orderId ?? '—'
			await this.changeHistory.createChangeHistory({
				user: user._id,
				changeType: 'litna-detached',
				description: `Закупка №${purchase.purchaseNumber} отвязана от заказа №${orderId} lit-na.ru вручную; заказ на сайте ${cancelled ? 'отменён' : placed?.orderId ? 'не отменён — сайт недоступен' : 'не проверялся — записи заказа нет'}`,
				changeDate: Date.now(),
			})
			this.refresh(user.company)
			return { purchase: await this.purchaseModel.findById(purchase._id).lean().exec(), cancelled }
		}
	}

	/**
	 * Поздняя оплата закрытого заказа (рассрочка и Сплит одобряются часами, вкладка с оплатой могла остаться открытой):
	 * раз в 30 минут спросить сайт о закрытых заказах, по которым выдавали форму оплаты или которые отвязали без отмены (сайт
	 * был недоступен) за последние 3 суток.
	 * Оплачен — запись в историю с push и отметка, чтобы не повторять; саму закупку не трогаем. Сбой сайта — до следующего раза.
	 */
	/**
	 * Закупки, ждущие оплаты: заказ могли оплатить (или отменить) прямо на сайте, не открывая приложение.
	 * Сервер сам спрашивает сайт — та же проверка, что при открытии закупки: оплачен — закупка отмечается оплаченной.
	 */
	@Cron(CronExpression.EVERY_10_MINUTES)
	async pendingCheck() {
		const skip = { skipTenantScope: true } as any
		try {
			const waiting = await this.purchaseModel
				.find({ isCreated: true, isPaid: { $ne: true }, isCompleted: { $ne: true }, 'litna.orderId': { $type: 'number' }, deletedAt: null })
				.setOptions(skip)
				.select('_id user company')
				.lean()
				.exec()
			if (!waiting.length) return
			const records = await this.orderModel
				.find({ purchase: { $in: waiting.map((p) => p._id) }, deletedAt: null, orderId: { $type: 'number' }, orderKey: { $nin: [null, ''] } })
				.setOptions(skip)
				.sort({ lateAt: 1 })
				.limit(LATE_BATCH)
				.lean()
				.exec()
			if (records.length) await this.orderModel.updateMany({ _id: { $in: records.map((r) => r._id) } }, { lateAt: Date.now() }).setOptions(skip).exec()
			const byId = new Map(waiting.map((p) => [String(p._id), p]))
			for (const r of records) {
				const id = String(r.purchase)
				// закупку прямо сейчас отвязывают или удаляют — заказ на сайте отменяет человек, фон не вмешивается
				if (this.closing.has(id.toLowerCase())) continue
				const company = String(r.company ?? (byId.get(id) as any)?.company)
				const who = r.payer || (byId.get(id) as any)?.user
				// как запрос человека из этой местности: записи истории и выборки получают местность сами
				await tenantContextStorage
					.run({ company, isSuperAdmin: false, userId: String(who), bypass: false }, async () => {
						const user = ((who && (await this.userModel.findById(who).exec())) || { _id: who, company }) as UserModel
						await this.checkPlaced(id, user)
					})
					.catch((e) => this.logger.warn(`Фоновая проверка оплаты заказа №${r.orderId} lit-na.ru не прошла: ${(e as Error)?.message}`))
			}
		} catch (e) {
			this.logger.warn(`Фоновая проверка оплаты lit-na.ru не прошла: ${(e as Error)?.message}`)
		}
	}

	/**
	 * Оплаченные закупки до приёмки: раз в час сервер спрашивает сайт, не отправлен ли заказ. Статус магазина «Доставка» —
	 * в закупке «Отправлен», запись в историю и push. Дальше не следим: «Выполнен» магазин не ставит.
	 * Заказ отменили после оплаты — тоже в историю: что делать с закупкой, решает человек.
	 */
	@Cron(CronExpression.EVERY_HOUR)
	async shippedCheck() {
		const skip = { skipTenantScope: true } as any
		try {
			const paid = await this.purchaseModel
				.find({ isCreated: true, isPaid: true, isCompleted: { $ne: true }, 'litna.orderId': { $type: 'number' }, 'litna.status': { $nin: ['delivery', 'completed', 'cancelled', 'refunded', 'trash'] }, deletedAt: null })
				.setOptions(skip)
				.select('_id company purchaseNumber litna.status')
				.lean()
				.exec()
			if (!paid.length) return
			const records = await this.orderModel
				.find({ purchase: { $in: paid.map((p) => p._id) }, deletedAt: null, orderId: { $type: 'number' }, $or: [{ orderKey: { $nin: [null, ''] } }, { guest: { $ne: true } }] })
				.setOptions(skip)
				.sort({ lateAt: 1 })
				.limit(LATE_BATCH)
				.lean()
				.exec()
			if (records.length) await this.orderModel.updateMany({ _id: { $in: records.map((r) => r._id) } }, { lateAt: Date.now() }).setOptions(skip).exec()
			const byId = new Map(paid.map((p) => [String(p._id), p as any]))
			for (const r of records) {
				const purchase = byId.get(String(r.purchase))
				const company = String(r.company ?? purchase.company)
				await tenantContextStorage
					.run({ company, isSuperAdmin: false, userId: null, bypass: false }, async () => {
						const site = r.orderKey ? await this.siteStatus(r as Placed) : await this.listedStatus(r as Placed)
						if (!site || site.missing || !site.status || site.status === purchase.litna?.status) return
						const shipped = isShipped(site.status)
						// условная запись: две проверки подряд (или два сервера) не напишут в историю дважды
						const written = await this.purchaseModel
							.updateOne({ _id: r.purchase, 'litna.status': { $ne: site.status } }, { 'litna.status': site.status, ...(shipped ? { 'litna.shippedAt': Date.now() } : isCancelled(site.status) ? { 'litna.cancelledAt': Date.now() } : {}) })
							.exec()
						if (!written.modifiedCount) return
						this.refresh(company)
						if (!shipped && !isCancelled(site.status)) return
						await this.changeHistory.createChangeHistory({
							company,
							changeType: shipped ? 'litna-shipped' : 'litna-cancelled-after-paid',
							description: shipped
								? `Заказ №${r.orderId} на lit-na.ru отправлен — закупка №${purchase.purchaseNumber}`
								: `Заказ №${r.orderId} на lit-na.ru отменён после оплаты — проверьте закупку №${purchase.purchaseNumber}`,
							changeDate: Date.now(),
						} as any)
					})
					.catch((e) => this.logger.warn(`Статус заказа №${r.orderId} lit-na.ru не проверен: ${(e as Error)?.message}`))
			}
		} catch (e) {
			this.logger.warn(`Проверка отправки заказов lit-na.ru не прошла: ${(e as Error)?.message}`)
		}
	}

	@Cron(CronExpression.EVERY_30_MINUTES)
	async lateCheck() {
		const skip = { skipTenantScope: true } as any
		try {
			const records = await this.orderModel
				.find({
					deletedAt: { $ne: null },
					orderId: { $type: 'number' },
					orderKey: { $nin: [null, ''] },
					$or: [{ payAt: { $gte: Date.now() - LATE_DAYS } }, { detachedAt: { $gte: Date.now() - LATE_DAYS } }],
					paidLateAt: null,
				})
				.setOptions(skip)
				.sort({ lateAt: 1 })
				.limit(LATE_BATCH)
				.lean()
				.exec()
			// по кругу: спрошенные уходят в конец очереди, иначе при большом числе записей часть не проверялась бы никогда
			if (records.length) await this.orderModel.updateMany({ _id: { $in: records.map((r) => r._id) } }, { lateAt: Date.now() }).setOptions(skip).exec()
			for (const r of records) {
				const site = await new LitnaSession().orderStatus(r.orderId, r.orderKey).catch(() => null)
				if (!site?.paid) continue
				const marked = await this.orderModel.updateOne({ _id: r._id, paidLateAt: null }, { paidLateAt: Date.now() }).setOptions(skip).exec()
				if (!marked.modifiedCount) continue
				const purchase = await this.purchaseModel.findById(r.purchase).setOptions(skip).lean().exec()
				await this.changeHistory.createChangeHistory({
					company: r.company,
					changeType: 'litna-paid-after-cancel',
					description: `Заказ №${r.orderId} на lit-na.ru оплачен после отмены — проверьте закупку №${purchase?.purchaseNumber ?? '—'}`,
					changeDate: Date.now(),
				} as any)
			}
		} catch (e) {
			this.logger.warn(`Проверка поздней оплаты lit-na.ru не прошла: ${(e as Error)?.message}`)
		}
	}

	/** Ручной выход из застрявшего оформления: только намерение без номера заказа и только после выдержки */
	async release(id: string, user: UserModel) {
		return this.locked(user, async () => {
			const purchase = await this.purchaseModel.findById(id).lean().exec()
			if (purchase) assertOwnPurchase(purchase, user)
			const placed = purchase && ((await this.orderModel.findOne(live(purchase._id)).lean().exec()) as Placed)
			if (!placed) throw new NotFoundException('Оформление на lit-na.ru по этой закупке не найдено')
			if (placed.orderId) throw new BadRequestException(`Заказ №${placed.orderId} на lit-na.ru уже оформлен — снять оформление нельзя`)
			const wait = PLACING_FRESH - (Date.now() - placed.startedAt)
			if (wait > 0) throw new BadRequestException(`Оформление ещё идёт — снять можно через ${minutesLeft(wait)} мин`)
			await this.drop(placed)
			await this.changeHistory.createChangeHistory({
				user: user._id,
				changeType: 'litna-released',
				description: `Оформление на lit-na.ru снято вручную (закупка ${purchase.purchaseNumber})`,
				changeDate: Date.now(),
			})
			return { released: true, purchase: await this.purchaseModel.findById(purchase._id).lean().exec() }
		})
	}
}

