/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { BadGatewayException, BadRequestException, Logger } from '@nestjs/common'
import { AsyncLocalStorage } from 'async_hooks'
import {
	accountOrders,
	addressForm,
	addResult,
	boxberryButton,
	cancelLink,
	checkoutForm,
	docLink,
	checkoutResult,
	inputValue,
	isLoggedIn,
	keepCookies,
	LITNA,
	notices,
	orderStatus,
	orderText,
	reviewHtml,
	verifyForm,
	reviewNonce,
	robokassaForm,
	yandexPoints,
} from './litna.parse'

const BOXBERRY = 'https://points.boxberry.ru'
const ADDRESS = '/my-account/edit-address/billing/'
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const FORM = 'application/x-www-form-urlencoded; charset=UTF-8'
const MB = 1024 * 1024
const logger = new Logger('LitnaSession')
// адрес в журнал — без параметров: в них ключи заказов и доступа к документам
const bare = (url: string) => url.split(/[?#]/)[0]

// счёт запросов к сайту внутри операции: время операции — это число последовательных запросов
const operation = new AsyncLocalStorage<{ requests: number }>()

/** Операция с записью в журнал её длительности и числа запросов к сайту (для замеров; без адресов и ключей) */
export async function measured<T>(what: string, run: () => Promise<T>): Promise<T> {
	const store = { requests: 0 }
	const started = Date.now()
	try {
		return await operation.run(store, run)
	} finally {
		logger.log(`${what}: ${((Date.now() - started) / 1000).toFixed(1)} с, запросов к сайту — ${store.requests}`)
	}
}

/** Адрес покупателя в теле update-customer: почта — только в адресе оплаты */
function customerBody(c: Customer) {
	const { email, ...address } = { country: 'RU', ...c }
	return { shipping_address: address, billing_address: email ? { ...address, email } : address }
}

type Init = {
	method?: string
	body?: string
	headers?: Record<string, string>
	follow?: boolean
	timeout?: number
	/** Единственный адрес, куда можно идти, в том числе по переадресации */
	origin?: string
	/** Предел размера ответа, байт */
	limit?: number
	/** Ответ — байты (картинка), текстом не разбирается */
	binary?: boolean
	/** Ответ кусками сюда, целиком не собирается (большие ответы) */
	sink?: (chunk: Uint8Array) => void
}
export type Customer = { first_name?: string; last_name?: string; country?: string; state?: string; city?: string; postcode?: string; address_1?: string; phone?: string; email?: string }

const gateway = () => new BadGatewayException('Сайт lit-na.ru не отвечает — попробуйте позже')
const VERIFY = 'lit-na.ru просит подтвердить почту заказа — оплатите или отмените заказ на сайте'
export const CLOSED = 'lit-na.ru не пускает к оформлению заказа'
const down = () => new BadGatewayException('lit-na.ru недоступен — попробуйте позже')

/** Форма Robokassa именно этого заказа: с другим номером (сайт перепутал сессии) платить по ней нельзя */
function payment(html: string, orderId: number) {
	const form = robokassaForm(html)
	if (!form) throw gateway()
	if (form.fields.InvId !== String(orderId)) throw new BadGatewayException('Форма оплаты сайта не соответствует заказу')
	return form
}

/** Тело ответа не больше limit байт: чужой сайт не должен забить память сервера */
async function readBody(res: Response, limit: number, sink?: (chunk: Uint8Array) => void) {
	const reader = res.body?.getReader()
	if (!reader) return Buffer.alloc(0)
	const chunks: Uint8Array[] = []
	let size = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) return Buffer.concat(chunks)
		size += value.length
		if (size > limit) {
			await reader.cancel().catch(() => null)
			throw gateway()
		}
		if (sink) sink(value)
		else chunks.push(value)
	}
}

/**
 * Сессия на lit-na.ru: своя банка кук и ключ записи в корзину (заголовок Nonce из ответа на GET cart).
 * Без credentials — гостевая (каталог, пункты, расчёт); с ними — кабинет местности, вход по первому отказу сайта.
 */
export class LitnaSession {
	// без этой куки хостинг отдаёт на admin-ajax.php заглушку со скриптом вместо ответа
	private cookies = new Map([['beget', 'begetok']])
	private nonce = ''
	// две операции сразу входят одним входом: второй вход сбил бы первому куки сессии
	private signingIn: Promise<void> | null = null

	/**
	 * cookies — сохранённые куки гостевой сессии: та же сессия на сайте (её корзина и ожидающий оплаты заказ);
	 * email — почта гостевого заказа: ею подтверждаются его страницы, когда сайт об этом просит.
	 */
	constructor(
		private readonly credentials?: { login: string; password: string },
		cookies?: [string, string][],
		private readonly email?: string
	) {
		for (const [k, v] of cookies || []) this.cookies.set(k, v)
	}

	cookie(name: string) {
		return this.cookies.get(name)
	}

	/** Куки сессии — сохранить и поднять её потом */
	dump(): [string, string][] {
		return [...this.cookies]
	}

	/** Переходы — вручную: куки входа приходят в ответе-переадресации, и их надо положить в банку */
	async request(path: string, init: Init & { cleanup?: boolean } = {}) {
		// сайт пишет сессию в конце каждого запроса: запрос, начатый во время очистки корзины, вернул бы прежнюю корзину назад
		if (!init.cleanup) await this.clearing
		const origin = init.origin || LITNA
		let url = new URL(path, origin).toString()
		let { method = init.body === undefined ? 'GET' : 'POST', body, headers = {} } = init
		for (let hop = 0; ; hop++) {
			// только свой адрес: ни переадресация, ни ссылка со страницы не уведут запрос (и куки) на чужой
			if (!url.startsWith(origin + '/')) {
				logger.warn(`Запрос на чужой адрес не отправлен: ${bare(url)}`)
				throw gateway()
			}
			try {
				const counter = operation.getStore()
				if (counter) counter.requests++
				const res = await fetch(url, {
					method,
					body,
					redirect: 'manual',
					headers: { 'User-Agent': UA, ...(origin === LITNA ? { Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...headers },
					signal: AbortSignal.timeout(init.timeout || 30_000),
				})
				if (origin === LITNA) keepCookies(this.cookies, res.headers.getSetCookie())
				const location = res.headers.get('location')
				if (init.follow !== false && location && res.status >= 300 && res.status < 400 && hop < 5) {
					await res.body?.cancel()
					url = new URL(location, url).toString()
					method = 'GET'
					body = undefined
					headers = {}
					continue
				}
				const bytes = await readBody(res, init.limit || 5 * MB, init.sink)
				return { res, url, bytes, text: init.binary ? '' : bytes.toString('utf8') }
			} catch (e) {
				logger.warn(`Запрос к ${bare(url)} не удался: ${(e as Error)?.message}`)
				throw gateway()
			}
		}
	}

	/** Открытый интерфейс магазина /wp-json/wc/store/v1: ответ — разобранный JSON (ошибка сайта — объект с code) */
	async api(path: string, body?: any, method?: string, cleanup = false) {
		const headers: Record<string, string> = { Accept: 'application/json' }
		if (body !== undefined) headers['Content-Type'] = 'application/json'
		if (this.nonce) headers.Nonce = this.nonce
		const { res, text } = await this.request('/wp-json/wc/store/v1' + path, {
			method: method || (body === undefined ? 'GET' : 'POST'),
			body: body === undefined ? undefined : JSON.stringify(body),
			headers,
			cleanup,
		})
		this.nonce = res.headers.get('nonce') || this.nonce
		try {
			return JSON.parse(text)
		} catch {
			throw gateway()
		}
	}

	form(path: string, data: Record<string, any>, init: Init = {}) {
		return this.request(path, { ...init, body: new URLSearchParams(data).toString(), headers: { 'Content-Type': FORM, 'X-Requested-With': 'XMLHttpRequest' } })
	}

	login() {
		this.signingIn ??= this.signIn().finally(() => (this.signingIn = null))
		return this.signingIn
	}

	private async signIn() {
		const page = await this.request('/my-account/')
		// сбой сайта — не «неверный пароль»: вход при этом не помечается сломанным
		if (page.res.status >= 500) throw down()
		if (isLoggedIn(page.text)) return
		const nonce = inputValue(page.text, 'woocommerce-login-nonce')
		if (!nonce || !this.credentials) throw gateway()
		// без Origin и Referer сайт молча не впускает
		const sent = await this.request('/my-account/', {
			body: new URLSearchParams({ username: this.credentials.login, password: this.credentials.password, 'woocommerce-login-nonce': nonce, _wp_http_referer: '/my-account/', login: 'Войти' }).toString(),
			headers: { 'Content-Type': FORM, Origin: LITNA, Referer: LITNA + '/my-account/' },
		})
		if (sent.res.status >= 500) throw down()
		if (!isLoggedIn(sent.text)) throw new BadRequestException('Не удалось войти на lit-na.ru — проверьте логин и пароль')
	}

	/** Адрес плательщика из кабинета (раздел «Адрес») — поля формы как у браузера; null — формы нет */
	async address() {
		return addressForm((await this.request(ADDRESS)).text)
	}

	/** Записать адрес в кабинет поверх полей формы; false — сайт не принял (обязательное поле пусто, сессия пропала) */
	async saveAddress(form: Record<string, string>, fields: Record<string, string>) {
		// без Origin и Referer сайт формы кабинета не принимает — как вход
		const { text } = await this.request(ADDRESS, {
			body: new URLSearchParams({ ...form, ...fields, save_address: 'Сохранить адрес' }).toString(),
			headers: { 'Content-Type': FORM, Origin: LITNA, Referer: LITNA + ADDRESS },
		})
		// принял — переадресация на список адресов (формы там нет); не принял — та же форма с ошибкой
		return isLoggedIn(text) && !addressForm(text)
	}

	/**
	 * Сайт вместо страницы гостевого заказа попросил подтвердить почту: форма уходит с почтой заказа, настоящая страница —
	 * в ответе (следующий GET попросит снова). Одна попытка: и в ответе форма — отказ.
	 */
	private async confirmed(r: Awaited<ReturnType<LitnaSession['request']>>) {
		const verify = verifyForm(r.text)
		if (!verify) return r
		if (!this.email) throw new BadRequestException(VERIFY)
		const done = await this.request(new URL(verify.action || r.url, r.url).toString(), {
			body: new URLSearchParams({ ...verify.fields, email: this.email, verify: '1' }).toString(),
			headers: { 'Content-Type': FORM, Origin: LITNA, Referer: r.url },
		})
		if (verifyForm(done.text)) throw new BadRequestException(VERIFY)
		return done
	}

	/** Страница кабинета или гостевого заказа: попросили войти — входим и открываем заново; попросили почту — подтверждаем */
	async page(path: string) {
		const first = await this.confirmed(await this.request(path))
		if (!this.credentials || isLoggedIn(first.text)) return first
		await this.login()
		return this.confirmed(await this.request(path))
	}

	/**
	 * Корзина заново одним пакетом: все строки и адрес (ответ подзапроса — уже корзина целиком, перечитывать не нужно).
	 * Пустую корзину (новая сессия, корзина аккаунта после заказа) не чистим. Адрес в пакете не принят — отдельным запросом;
	 * пакет не принят целиком — как прежде: корзина заново, строки отдельно от адреса.
	 * problems — что сайт не положил: stock (мало) или gone (товара нет). opened — сайт ответил, дальше корзина наполняется.
	 */
	async fillCart(lines: { id: number; quantity: number }[], customer: Customer, opened?: () => void) {
		const before = await this.api('/cart')
		opened?.()
		if (before?.items?.length) await this.api('/cart/items', undefined, 'DELETE')
		const sub = (path: string, body: any) => ({ path: '/wc/store/v1/cart/' + path, method: 'POST', headers: { Nonce: this.nonce }, body })
		const adds = lines.map((l) => sub('add-item', l))
		let responses = await this.batch([...adds, sub('update-customer', customerBody(customer))])
		if (!responses) {
			await this.api('/cart/items', undefined, 'DELETE')
			responses = await this.batch(adds)
			if (!responses) throw gateway()
		}
		const problems = new Map<number, 'stock' | 'gone'>()
		for (let j = 0; j < lines.length; j++) {
			const result = addResult(responses[j])
			if (result === 'error') throw gateway()
			if (result) problems.set(lines[j].id, result)
		}
		const address = responses[lines.length]
		const cart = address?.status >= 200 && address.status < 300 ? address.body : await this.api('/cart/update-customer', customerBody(customer))
		return { cart, problems }
	}

	/** Подзапросы пакетами (сайт принимает не больше 25 в одном); null — пакет не принят */
	private async batch(requests: any[]) {
		const out: any[] = []
		for (let i = 0; i < requests.length; i += 25) {
			const part = requests.slice(i, i + 25)
			const res = await this.api('/batch', { requests: part })
			if (!Array.isArray(res?.responses) || res.responses.length !== part.length) return null
			out.push(...res.responses)
		}
		return out
	}

	private clearing: Promise<unknown> | null = null

	/** Очистить корзину фоном — ответ не ждёт; следующая сборка корзины этой сессии её дождётся */
	clearLater() {
		const p = this.api('/cart/items', undefined, 'DELETE', true)
			.catch((e) => logger.warn(`Корзина lit-na.ru не очищена: ${(e as Error)?.message}`))
			// вторая очистка могла начаться, пока шла первая: её ожидание не снимаем
			.finally(() => this.clearing === p && (this.clearing = null))
		this.clearing = p
	}

	/** Форма страницы /checkout/; нет — сайт к оформлению не пускает (пустая корзина, мала сумма): причина в уведомлениях */
	async orderForm() {
		const { text: page } = await this.page('/checkout/')
		const form = checkoutForm(page)
		if (!form?.['woocommerce-process-checkout-nonce']) throw new BadRequestException(notices(page) || CLOSED)
		// без примечания код не дойдёт до заказа, и после потерянного ответа заказ не опознать
		if (!('order_comments' in form)) throw new BadGatewayException('На lit-na.ru нет поля примечания к заказу — оформление остановлено')
		return form
	}

	/**
	 * Оформление классической формой: все поля страницы /checkout/ (form — уже открытая) поверх — наши.
	 * Сбой после отправки не бросается, а возвращается как unknown: заказ на сайте мог появиться.
	 */
	async checkout(fields: Record<string, string>, beforeSend?: () => Promise<unknown>, form?: Record<string, string>) {
		form ??= await this.orderForm()
		await beforeSend?.()
		try {
			const { text } = await this.form('/?wc-ajax=checkout', { ...form, ...fields }, { timeout: 90_000 })
			return checkoutResult(text)
		} catch {
			return { unknown: 'ответ сайта на оформление потерян' }
		}
	}

	/**
	 * Форма Robokassa со страницы оплаты заказа: по ней видно, сколько сайт возьмёт. Способ оплаты на сайте не меняется:
	 * форма одна для всех способов, выбор — уже на странице Robokassa.
	 */
	async orderPayment(orderId: number, orderKey: string) {
		return payment((await this.page(`/checkout/order-pay/${orderId}/?key=${orderKey}`)).text, orderId)
	}

	async orderStatus(orderId: number, orderKey: string) {
		const { text } = await this.form('/wp-admin/admin-ajax.php', { action: 'robokassa_check_order_status', orderId, orderKey })
		return orderStatus(text)
	}

	/** Первая страница заказов кабинета; null — список не разобран */
	async orders() {
		return accountOrders((await this.page('/my-account/orders/')).text)
	}

	/** Текст таблицы заказа (с примечанием покупателя); null — страница заказа не разобрана */
	async orderText(orderId: number) {
		return orderText((await this.page(`/my-account/view-order/${orderId}/`)).text)
	}

	/** PDF документа заказа: ссылка — с первой из страниц, где она есть; null — ни на одной нет */
	async doc(orderId: number, documentType: string, pages: string[]) {
		let link: string | null = null
		for (const path of pages) if (!link) link = docLink((await this.page(path)).text, orderId, documentType)
		if (!link) return null
		const { res, bytes } = await this.request(link, { binary: true, limit: 5 * MB })
		// вместо PDF бывает страница с ошибкой — её клиенту как файл не отдаём
		if (!res.ok || bytes.subarray(0, 4).toString('latin1') !== '%PDF') throw gateway()
		return bytes
	}

	/** Отмена — ссылкой со страницы (список заказов кабинета; у гостя — страница «заказ получен»); false — ссылки нет */
	async cancelOrder(orderId: number, path = '/my-account/orders/') {
		const page = await this.page(path)
		// сбой сайта — не «ссылки нет»: отмена не проверена, а не невозможна
		if (page.res.status >= 500) throw down()
		const link = cancelLink(page.text, orderId)
		if (link) await this.request(link)
		return !!link
	}

	/** Атрибуты ссылки выбора пункта Яндекс Доставки — из пересчёта оформления с этим способом (корзина уже собрана) */
	async boxberryButton(rateId: string, city: string) {
		const security = reviewNonce((await this.request('/checkout/')).text)
		if (!security) throw gateway()
		const where = { country: 'RU', state: '', postcode: '', city, address: '' }
		const { text } = await this.form('/?wc-ajax=update_order_review', {
			security,
			payment_method: 'robokassa',
			...where,
			...Object.fromEntries(Object.entries(where).map(([k, v]) => ['s_' + k, v])),
			has_full_address: 'true',
			post_data: new URLSearchParams({ billing_country: 'RU', billing_city: city, 'shipping_method[0]': rateId, payment_method: 'robokassa' }).toString(),
			'shipping_method[0]': rateId,
		})
		return boxberryButton(reviewHtml(text))
	}

	/** Все пункты страны тем же запросом, каким их берёт карта виджета (~15 МБ) */
	async boxberryPoints(button: NonNullable<ReturnType<typeof boxberryButton>>) {
		const input = {
			api_token: button.token, custom_city: button.city, chgCity: 'false', chgPaysum: 'false', weight: button.weight,
			height: '0', width: '0', depth: '0', ordersum: button.ordersum, paysum: '0', calc: '1', select_office: '1', kd: '0',
			sucrh: '1', checkLocation: '1', versionAPI: button.api, target_start: button.targetStart, host: 'lit-na.ru',
		}
		const body = new URLSearchParams({ ajax: '1', getListPoints: '0' })
		for (const [k, v] of Object.entries(input)) body.append(`input_parameters[${k}]`, v)
		// ~15 МБ JSON: разбирается по кускам, по одному пункту — на сервере с малой памятью ни текст, ни дерево целиком не держим
		const parser = yandexPoints()
		await this.request(BOXBERRY + '/map/index.php', {
			origin: BOXBERRY,
			body: body.toString(),
			headers: { 'Content-Type': FORM, 'X-Requested-With': 'XMLHttpRequest', Origin: BOXBERRY, Referer: BOXBERRY + '/map/' },
			timeout: 90_000,
			limit: 40 * MB,
			sink: parser.write,
		})
		const points = parser.end()
		if (!points.length) throw new BadGatewayException('Не удалось получить пункты Яндекс Доставки')
		return points
	}
}
