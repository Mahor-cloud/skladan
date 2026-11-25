/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

// Всё, что читается со страниц и из ответов lit-na.ru, — здесь, чистыми функциями: сайт чужой, при его переделке
// чинится один файл, а тесты на образцах (litna.parse.spec.ts) показывают, что именно сломалось.

export const LITNA = 'https://lit-na.ru'

const ENTITIES: Record<string, string> = {
	amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»',
	mdash: '—', ndash: '–', hellip: '…', times: '×',
}

export const decode = (s: string) =>
	String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
		if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m
		const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)
		// недопустимый номер символа остаётся как есть
		return code <= 0x10ffff ? String.fromCodePoint(code) : m
	})

/** Текст без разметки и лишних пробелов; тег — до «>» без «<» внутри, иначе разбор незакрытых тегов квадратичный */
export const text = (html: string) => decode(String(html ?? '').replace(/<[^<>]*>/g, ' ')).replace(/\s+/g, ' ').trim()

/** Значение атрибута тега: порядок атрибутов и пробелы вокруг «=» на сайте разные */
const attr = (tag: string, name: string) => {
	const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'))
	return m ? decode(m[1] ?? m[2]) : undefined
}

// Теги ищутся indexOf, без выражений «<тег…>[\s\S]*?</тег>»: на странице с множеством незакрытых тегов те работают
// за квадратичное время и останавливают весь сервер, а страница чужая и может быть любой.

type Tag = { start: number; end: number; tag: string }

/**
 * Открывающие теги name по порядку, по требованию (поиск элемента без закрывающего тега на этом и кончается).
 * Тег — до «>» без «<» внутри; нет «>» — дальше не ищем: его нет и для следующих.
 */
function* openTags(html: string, name: string, lower = html.toLowerCase()): Generator<Tag> {
	const open = '<' + name
	let gt = -1
	for (let i = lower.indexOf(open); i >= 0; i = lower.indexOf(open, i + open.length)) {
		const next = lower[i + open.length]
		if (next !== undefined && !/[\s>/]/.test(next)) continue
		if (gt < i) gt = html.indexOf('>', i)
		if (gt < 0) break
		const lt = html.indexOf('<', i + 1)
		if (lt >= 0 && lt < gt) continue
		yield { start: i, end: gt + 1, tag: html.slice(i, gt + 1) }
	}
}

/** Элементы name (test — отбор по открывающему тегу) до ближайшего «</name>», без наложений; нет закрывающего — дальше не ищем */
function elements(html: string, name: string, test: (tag: string) => boolean = () => true) {
	const lower = html.toLowerCase()
	const close = `</${name}>`
	const out: (Tag & { inner: string; outer: string })[] = []
	let last = -1
	for (const t of openTags(html, name, lower)) {
		if (t.start < last || !test(t.tag)) continue
		const at = lower.indexOf(close, t.end)
		if (at < 0) break
		last = at + close.length
		out.push({ ...t, inner: html.slice(t.end, at), outer: html.slice(t.start, last) })
	}
	return out
}

/** Значения prefix…" по порядку (prefix кончается кавычкой); без закрывающей кавычки — дальше не ищем */
function quoted(html: string, prefix: string) {
	const out: { at: number; value: string }[] = []
	for (let i = html.indexOf(prefix); i >= 0; ) {
		const end = html.indexOf('"', i + prefix.length)
		if (end < 0) break
		out.push({ at: i, value: html.slice(i + prefix.length, end) })
		i = html.indexOf(prefix, end + 1)
	}
	return out
}

const hrefs = (html: string) => quoted(html, 'href="').map((q) => q.value)
const classOf = (tag: string) => attr(tag, 'class') || ''
const withClass = (cls: string) => (tag: string) => classOf(tag).includes(cls)
/** Начало атрибута class="…" с этим классом; -1 — нет (в стилях и скриптах страницы классы тоже встречаются) */
const classAt = (html: string, cls: string) => quoted(html, 'class="').find((q) => q.value.includes(cls))?.at ?? -1

/** Поля формы так, как их отправил бы браузер: переключатели и галочки — только отмеченные, список — выбранный пункт */
export function formFields(form: string): Record<string, string> {
	const out: Record<string, string> = {}
	for (const { tag } of openTags(form, 'input')) {
		const name = attr(tag, 'name')
		const type = (attr(tag, 'type') || 'text').toLowerCase()
		if (!name || ((type === 'radio' || type === 'checkbox') && !/\schecked\b/i.test(tag))) continue
		out[name] = attr(tag, 'value') ?? (type === 'checkbox' ? 'on' : '')
	}
	for (const { tag, inner } of elements(form, 'select')) {
		const options = [...openTags(inner, 'option')].map((o) => o.tag)
		const chosen = options.find((o) => /\sselected\b/i.test(o)) ?? options[0]
		const name = attr(tag, 'name')
		if (name) out[name] = (chosen && attr(chosen, 'value')) ?? ''
	}
	for (const { tag, inner } of elements(form, 'textarea')) {
		const name = attr(tag, 'name')
		if (name) out[name] = decode(inner)
	}
	return out
}

export const inputValue = (html: string, name: string) => {
	const tag = [...openTags(html, 'input')].find((t) => attr(t.tag, 'name') === name)?.tag
	return tag ? attr(tag, 'value') : undefined
}

/** Ссылка «Выйти» есть на каждой странице кабинета только после входа */
export const isLoggedIn = (html: string) => html.includes('customer-logout')

/**
 * Форма «подтвердите почту заказа»: её сайт показывает вместо гостевых страниц заказа старше ~10 минут
 * (оплата, «заказ получен»); отправленная с почтой заказа — настоящая страница приходит в ответе.
 */
export function verifyForm(html: string) {
	const form = elements(html, 'form', withClass('woocommerce-verify-email'))[0]
	return form ? { action: attr(form.tag, 'action') || '', fields: formFields(form.inner) } : null
}

export const checkoutForm = (html: string) => {
	const form = elements(html, 'form', (tag) => attr(tag, 'name') === 'checkout')[0]
	return form ? formFields(form.inner) : null
}

/** Форма «Адрес» кабинета (адрес плательщика) — поля как у браузера; null — формы на странице нет */
export const addressForm = (html: string) => {
	const form = elements(html, 'form').find((f) => f.inner.includes('name="billing_first_name"'))
	return form ? formFields(form.inner) : null
}

/** Готовая форма Robokassa со страницы оплаты заказа */
export const robokassaForm = (html: string) => {
	const form = elements(html, 'form', (tag) => (attr(tag, 'action') || '').startsWith('https://auth.robokassa.ru/'))[0]
	return form ? { action: attr(form.tag, 'action') as string, fields: formFields(form.inner) } : null
}

/** Ключ запроса пересчёта оформления (update_order_review) — в настройках скрипта страницы /checkout/ */
export const reviewNonce = (html: string) => html.match(/"update_order_review_nonce":"([^"]+)"/)?.[1]

/** Ответ update_order_review → разметка всех кусков страницы одной строкой */
export const reviewHtml = (body: string) => {
	const fragments = parseJson(body)?.fragments
	return fragments && typeof fragments === 'object' ? Object.values(fragments).join('\n') : ''
}

/** Ссылка выбора пункта Яндекс Доставки (виджет Boxberry): токен виджета магазина и его склад отправки */
export function boxberryButton(html: string) {
	const tag = [...openTags(html, 'a')].find((t) => classOf(t.tag) === 'bxbbutton')?.tag
	const token = tag && attr(tag, 'data-boxberry-token')
	if (!token) return null
	return {
		token,
		targetStart: attr(tag, 'data-boxberry-target-start') || '',
		city: attr(tag, 'data-boxberry-city') || '',
		weight: attr(tag, 'data-boxberry-weight') || '0',
		ordersum: attr(tag, 'data-ordersum') || '0',
		api: attr(tag, 'data-api-url') || 'https://api.boxberry.ru/json.php',
	}
}

/**
 * Ссылка на документ заказа (плагин PDF-счетов, «Счет» на странице заказа) с нужным видом документа: invoice — счёт,
 * packing-slip — упаковочный лист. В ссылке ключ доступа: наружу её не отдавать. null — ссылки этого заказа нет.
 */
export function docLink(html: string, orderId: number, documentType: string) {
	for (const href of hrefs(html)) {
		if (!href.includes('action=generate_wpo_wcpdf')) continue
		const url = decode(href)
		if (!url.startsWith(LITNA + '/')) continue
		const link = new URL(url)
		if (link.searchParams.get('order_ids') !== String(orderId) || !link.searchParams.get('access_key')) continue
		link.searchParams.set('document_type', documentType)
		return link.toString()
	}
	return null
}

/** Ссылка отмены заказа из списка заказов кабинета */
export function cancelLink(html: string, orderId: number) {
	for (const href of hrefs(html)) {
		if (!href.includes('cancel_order=true')) continue
		const url = decode(href)
		if (url.startsWith(LITNA + '/') && url.match(/[?&]order_id=(\d+)/)?.[1] === String(orderId)) return url
	}
	return null
}

// сообщение кабинета «заказов нет»; обёртка у тем разная (на сайте: «Заказов ещё не создано.»), поэтому ищем по тексту блока кабинета
const noOrders = (html: string) => {
	// только начало блока кабинета: дальше подвал и скрипты страницы, похожая фраза в них дала бы ложное «заказов нет»
	const block = html.slice(classAt(html, 'woocommerce-MyAccount-content')).split(/<(?:script|style|footer)\b/i)[0].slice(0, 4000)
	return /no order|заказ\S*\s+(?:пока\s+|ещё\s+|еще\s+)?(?:нет|не\s)|нет\s+(?:ни\s+одного\s+)?заказ/i.test(text(block))
}

/**
 * Первая страница списка заказов кабинета: номер, статус (по классу строки), сумма, ключ из ссылки оплаты (есть только
 * у ожидающих оплаты); more — есть следующая страница. Дату не берём: сайт пишет её со сдвигом.
 * null — страница не разобрана (не вошли, нет ни таблицы, ни сообщения «заказов нет»).
 */
export function accountOrders(html: string) {
	// классы ищем в тегах: в стилях страницы они тоже встречаются
	if (!isLoggedIn(html) || classAt(html, 'woocommerce-MyAccount-content') < 0) return null
	const table = elements(html, 'table', (tag) => /(^|\s)woocommerce-orders-table(\s|$)/.test(classOf(tag)))[0]?.outer
	if (!table) return noOrders(html) ? { orders: [], more: false } : null
	const rows = elements(table, 'tr', withClass('woocommerce-orders-table__row')).map(({ outer: row }) => {
		const pay = hrefs(row).find((h) => /\/checkout\/order-pay\/\d+\//.test(h))
		const amount = text(elements(row, 'td', withClass('cell-order-total'))[0]?.inner || '').match(/\d[\d\s,]*\.\d{2}/)?.[0]
		return {
			orderId: Number(row.match(/view-order\/(\d+)/)?.[1] || row.match(/order-pay\/(\d+)/)?.[1]) || 0,
			status: row.match(/woocommerce-orders-table__row--status-([\w-]+)/)?.[1] || '',
			total: amount ? Number(amount.replace(/[\s,]/g, '')) : NaN,
			orderKey: decode(pay || '').match(/[?&]key=(wc_order_\w+)/)?.[1] || null,
		}
	})
	// строка без номера или статуса — разметка сменилась, такому списку верить нельзя
	if (!rows.every((r) => r.orderId && r.status)) return null
	return { orders: rows, more: classAt(html, 'woocommerce-button--next') >= 0 }
}

/** Текст таблицы заказа со страницы заказа (в ней и примечание покупателя); null — не вошли или это не страница заказа */
export function orderText(html: string) {
	const table = isLoggedIn(html) && elements(html, 'table', withClass('woocommerce-table--order-details'))[0]
	return table ? text(table.outer) : null
}

// «Отменён» для нас — только эти; failed WooCommerce даёт оплатить заново, он — как ожидающий оплаты
const CANCELLED = new Set(['cancelled', 'refunded', 'trash'])
export const isCancelled = (status: string) => CANCELLED.has(status)
// «Доставка» (delivery) — свой статус магазина: заказ отправлен. Оплаченным считается и он — даже если сайт в ответе проверки paid для него не ставит
const SHIPPED = new Set(['delivery'])
export const isShipped = (status: string) => SHIPPED.has(status)
export const isPaidStatus = (status: string) => status === 'processing' || status === 'completed' || SHIPPED.has(status)

const parseJson = (body: string) => {
	try {
		return JSON.parse(body)
	} catch {
		return null
	}
}

/**
 * Ответ оформления: { result:'success', order_id, redirect:'https://lit-na.ru/…/order-pay/ID/?key=wc_order_…' }.
 * error — сайт отказал явно, заказа нет; unknown — заказ мог появиться (успех без ключа, ответ не разобран).
 */
export function checkoutResult(body: string): { orderId: number; orderKey: string } | { error: string } | { unknown: string } {
	const json = parseJson(body)
	if (json?.result === 'failure') return { error: text(json.messages || '') || 'Сайт не принял заказ' }
	if (json?.result !== 'success') return { unknown: 'ответ сайта на оформление не разобран' }
	const redirect = String(json.redirect || '')
	const orderId = Number(json.order_id) || Number(redirect.match(/order-pay\/(\d+)/)?.[1])
	const orderKey = redirect.match(/[?&]key=(wc_order_\w+)/)?.[1]
	if (!redirect.startsWith(LITNA + '/') || !orderId || !orderKey) return { unknown: 'сайт оформил заказ, но не вернул его ключ' }
	return { orderId, orderKey }
}

/** Ответ проверки оплаты: { success:true, data:{ paid, status } }. Оплачен — paid и статус «в обработке» или «выполнен»; «доставка» — оплачен и без paid.
 * Заказа с таким ключом нет (success:false, invalid_order) — как отменённый (missing). Заглушка хостинга, «0» и прочее — null. */
export function orderStatus(body: string): { paid: boolean; status: string; missing?: boolean } | null {
	const json = parseJson(body)
	const data = json?.data
	if (json?.success === false && data?.message === 'invalid_order') return { paid: false, status: 'cancelled', missing: true }
	if (json?.success !== true || typeof data?.paid !== 'boolean') return null
	const status = String(data.status || '')
	return { paid: (data.paid === true && isPaidStatus(status)) || SHIPPED.has(status), status }
}

/** Ответ вида { success:true } (сохранение пункта CDEK) */
export const isSuccess = (body: string) => parseJson(body)?.success === true

/** Ответ пакета на добавление в корзину: null — положено; stock — не хватает остатка (или количество сверх допустимого); gone — товара нет; error — сбой сайта */
export function addResult(r: any): null | 'stock' | 'gone' | 'error' {
	if (r?.status >= 200 && r?.status < 300) return null
	const code = String(r?.body?.code || '')
	return /out_of_stock|quantity/.test(code) ? 'stock' : /invalid_product/.test(code) ? 'gone' : 'error'
}

/** Уведомления WooCommerce со страницы (ошибки, сведения, сообщения) — одной строкой, без повторов */
const NOTICE = (tag: string) => /woocommerce-(error|info|message)(?![\w])/.test(classOf(tag))
export const notices = (html: string) =>
	[
		...new Set(
			[...elements(String(html), 'ul', NOTICE), ...elements(String(html), 'div', NOTICE)]
				.sort((a, b) => a.start - b.start)
				.map((e) => text(e.inner))
				.filter(Boolean)
		),
	].join(' ')

/**
 * image — есть ли у товара картинка; imageSrc и thumbSrc — адреса картинки и миниатюры (наружу не отдаются: картинки
 * берёт сервер, /litna/image и /litna/thumb). category — первая категория, кроме общей «Товары».
 */
export type SiteProduct = {
	id: number
	sku: string
	name: string
	price: number
	stock: number
	inStock: boolean
	category: string
	image: boolean
	imageSrc: string | null
	thumbSrc: string | null
}

/** Вариант картинки из srcset («адрес 300w, адрес 600w»), ширина которого ближе всего к нужной */
export function srcsetPick(srcset: string, width: number) {
	const options = String(srcset || '')
		.split(',')
		.map((e) => e.trim().match(/^(\S+)\s+(\d+)w$/))
		.filter(Boolean)
		.map((m) => ({ src: m[1], w: Number(m[2]) }))
	return options.sort((a, b) => Math.abs(a.w - width) - Math.abs(b.w - width))[0]?.src || null
}

const minor = (value: any, unit: any) => Number(value) / 10 ** (unit ?? 2)

/** Товар открытого интерфейса магазина: цена в копейках, остаток — наибольшее количество для корзины */
export function siteProduct(p: any): SiteProduct {
	const inStock = !!p.is_in_stock
	return {
		id: p.id,
		sku: p.sku || '',
		name: decode(p.name),
		price: minor(p.prices?.price, p.prices?.currency_minor_unit),
		// у товара без наличия сайт тоже пишет maximum (9999), остаток у него — ноль
		stock: inStock ? Number(p.add_to_cart?.maximum) || 0 : 0,
		inStock,
		category: (p.categories || []).map((c: any) => decode(c?.name || '')).find((n: string) => n && n !== 'Товары') || '',
		image: !!p.images?.[0]?.src,
		imageSrc: p.images?.[0]?.src || null,
		thumbSrc: srcsetPick(p.images?.[0]?.thumbnail_srcset, 300) || p.images?.[0]?.thumbnail || null,
	}
}

export type Rate = { id: string; kind: string; title: string; price: number }

// Номера экземпляров способов (official_cdek:138 и т. п.) магазин может сменить — узнаём способ по method_id и названию
const rateKind = (method: string, title: string) =>
	method === 'free_shipping' ? 'free'
		: method === 'boxberry_self' ? 'yandex_pvz'
		: method === 'boxberry_courier' ? 'yandex_door'
		: method !== 'official_cdek' ? ''
		: /дверь-склад/i.test(title) ? 'cdek_pvz'
		: /дверь-дверь/i.test(title) ? 'cdek_door'
		: ''

/** Способы доставки корзины (после cart/update-customer) */
export const shippingRates = (cart: any): Rate[] =>
	(cart?.shipping_rates || [])
		.flatMap((pkg: any) => pkg?.shipping_rates || [])
		.map((r: any) => {
			const title = text(r.name)
			return { id: String(r.rate_id), kind: rateKind(r.method_id, title), title, price: minor(r.price, r.currency_minor_unit) }
		})

/** От 15 000 ₽ сайт даёт единственный способ — бесплатный; иначе — выбранный в аккаунте */
export const pickRate = (rates: Rate[], kind: string) => rates.find((r) => r.kind === 'free') || rates.find((r) => r.kind === kind)

/** Цены строк корзины: { товар сайта → цена } */
export const cartPrices = (cart: any) =>
	new Map<number, number>((cart?.items || []).map((i: any) => [i.id, minor(i.prices?.price, i.prices?.currency_minor_unit)]))

/** Пункты CDEK города: приходят в корзине JSON-строкой */
export function cdekPoints(cart: any) {
	const raw = cart?.extensions?.official_cdek?.points
	const list = typeof raw === 'string' ? parseJson(raw) : raw
	return (Array.isArray(list) ? list : []).map((p: any) => ({
		code: String(p.code),
		name: decode(p.name || ''),
		address: decode(p.location?.address_full || p.location?.address || ''),
		hours: decode(p.work_time || ''),
		city: decode(p.location?.city || ''),
		postcode: String(p.location?.postal_code || ''),
	}))
}

export type YandexPoint = { pointid: string; cityname: string; Address: string; WorkSchedule: string; zip: string }

// пунктов сейчас ~17 тысяч по ~1 КБ; больше — ответ не тот
const POINTS_MAX = 60_000
const POINT_MAX = 64 * 1024

/**
 * Пункты Яндекс Доставки всей страны (ответ points.boxberry.ru, ~15 МБ — массив [{"type":"Feature",…,"properties":{…}}]) по кускам:
 * границы элементов массива ищутся по скобкам вне строк, разбирается каждый элемент отдельно, от него — только нужное для списка.
 * end() — пункты; не массив, обрыв, битый элемент или слишком много — [] (как и раньше у ответа, который не разобрался).
 */
export function yandexPoints(max = POINTS_MAX) {
	const decoder = new TextDecoder()
	const points: YandexPoint[] = []
	let state: 'start' | 'array' | 'done' | 'bad' = 'start'
	let depth = 0
	let inString = false
	let escaped = false
	// начало элемента, не законченного в прошлых кусках
	let piece = ''
	// false — ответ не верен: битый элемент или пунктов слишком много
	const take = (json: string) => {
		const f = parseJson(json)
		if (!f) return false
		const p = f.properties
		if (!p?.pointid) return true
		if (points.length >= max) return false
		points.push({ pointid: String(p.pointid), cityname: String(p.cityname || ''), Address: String(p.Address || ''), WorkSchedule: String(p.WorkSchedule || ''), zip: String(p.zip || '') })
		return true
	}
	const push = (text: string) => {
		let from = 0
		for (let i = 0; i < text.length; i++) {
			const c = text[i]
			if (state !== 'array') {
				if (state === 'start' && c === '[') state = 'array'
				else if (state === 'bad' || !/\s/.test(c)) return void (state = 'bad')
				continue
			}
			if (inString) {
				if (escaped) escaped = false
				else if (c === '\\') escaped = true
				else if (c === '"') inString = false
			} else if (c === '"') inString = true
			else if (c === '{' || c === '[') {
				if (depth++ === 0) from = i
			} else if (c === '}' || c === ']') {
				if (depth === 0) state = c === ']' ? 'done' : 'bad'
				else if (--depth === 0) {
					const ok = take(piece + text.slice(from, i + 1))
					piece = ''
					if (!ok) return void (state = 'bad')
				}
			}
		}
		if (depth > 0 && state === 'array') {
			piece += text.slice(from)
			if (piece.length > POINT_MAX) state = 'bad'
		}
	}
	return {
		write: (chunk: Uint8Array) => push(decoder.decode(chunk, { stream: true })),
		end: (): YandexPoint[] => (push(decoder.decode()), state === 'done' ? points : []),
	}
}

/** Куки из ответа в банку: просроченная или «deleted» — удаляется. Путь и домен не различаем: сайт один. */
export function keepCookies(jar: Map<string, string>, setCookie: string[], now = Date.now()) {
	for (const line of setCookie) {
		const [pair, ...rest] = line.split(';')
		const eq = pair.indexOf('=')
		if (eq < 1) continue
		const name = pair.slice(0, eq).trim()
		const value = pair.slice(eq + 1).trim()
		const attrs = Object.fromEntries(rest.map((a) => [a.split('=')[0].trim().toLowerCase(), a.slice(a.indexOf('=') + 1).trim()]))
		const gone = value === 'deleted' || ('max-age' in attrs ? Number(attrs['max-age']) <= 0 : 'expires' in attrs && Date.parse(attrs.expires) <= now)
		if (gone) jar.delete(name)
		else jar.set(name, value)
	}
}

const STREET = /^(ул|улица|пр|пр-т|просп|проспект|пер|переулок|ш|шоссе|пл|площадь|наб|набережная|бульвар|б-р|мкр|микрорайон|кв)(\.|\s|$)/i
// «д.» — дом, только перед номером; «д. Ивановка» — деревня
const HOUSE = /^(д|дом)\.?\s*\d/i
const REGION = new Set(['обл', 'область', 'край', 'респ', 'республика', 'округ', 'ао'])
const COUNTRY = /^(россия|рф|российская федерация|russia)$/i

/**
 * Город, индекс и область из адреса одной строкой («Саратов, ул. Московская, 1»): части через запятую;
 * 6 цифр — индекс; часть со словом «обл», «край», «респ», «округ», «АО» — область; страна пропускается; первая из остальных — город
 * (без «г.», «город»). Улица на месте города — города нет: сайт считает доставку по городу.
 */
export function parseAddress(address: string) {
	const parts = String(address || '').split(',').map((p) => p.trim()).filter(Boolean)
	const postcode = parts.find((p) => /^\d{6}$/.test(p)) || ''
	const state = parts.find((p) => p.split(/[\s.]+/).some((w) => REGION.has(w.toLowerCase()))) || ''
	const first = parts.find((p) => p !== postcode && p !== state && !COUNTRY.test(p)) || ''
	const city = first.replace(/^(г\.\s*|г\s+|город\s+)/i, '').trim()
	// с цифрами или длиннее четырёх слов — это не город (улица, дом, приписка), сайту такой не отдаём
	const plausible = city && !STREET.test(city) && !HOUSE.test(city) && !/\d/.test(city) && city.split(/\s+/).length <= 4
	return { city: plausible ? city : '', postcode, state }
}

/** Название для сравнения: регистр, кавычки, «ё», лишние пробелы */
export const norm = (s: string) =>
	String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/["'«»„“”‘’`]/g, '').replace(/\s+/g, ' ').trim()

/**
 * Тип обложки вида для категорий сайта (типы — те, что рисует клиент, skladanclient/src/domain/covers.js COVERS).
 * Категории, которых здесь нет, получают обложку по умолчанию у клиента.
 */
export const SITE_KIND_COVERS: Record<string, string> = {
	Книги: 'book',
	'Сувенирные книги': 'book',
	'Литература БУ': 'book',
	'Служебная литература': 'book',
	Буклеты: 'booklet',
	'Информ. проспекты': 'leaflet',
	'Служебные проспекты': 'brochure',
	Брелоки: 'keytag',
	'Медали титановые': 'medal',
	'Медали цветные': 'medal',
	Сувениры: 'box',
	Разное: 'box',
}

// длина названия товара — как в CreateProductDto
const NAME_MAX = 200

/**
 * Товары сайта для засева новой местности: только с категорией (служебные «Доставка…», «Тест» идут без неё) и с ценой.
 * Названия уникальны: совпало — с артикулом (или номером товара сайта) в скобках.
 */
export function siteSeed(site: SiteProduct[]) {
	const taken = new Set<string>()
	// хвост с артикулом — после обрезки до предела: иначе у длинного названия он отрезался бы и повтор терялся
	const unique = (name: string, tail: string) => {
		for (const v of tail ? [name.slice(0, NAME_MAX), `${name.slice(0, NAME_MAX - tail.length - 3)} (${tail})`] : [name.slice(0, NAME_MAX)]) {
			if (v && !taken.has(v.toLowerCase())) return taken.add(v.toLowerCase()), v
		}
		return null
	}
	return site
		.filter((p) => p.name.trim() && p.category && p.price > 0)
		.flatMap((p) => {
			const name = unique(p.name.trim(), p.sku) || unique(p.name.trim(), String(p.id))
			return name ? [{ name, category: p.category, price: p.price, targetQty: 0, litnaId: p.id }] : []
		})
}

/** Обложки видов для засеянных категорий (только известные — по таблице SITE_KIND_COVERS) */
export const seedKindCovers = (products: { category: string }[]) =>
	[...new Set(products.map((p) => p.category))].filter((c) => SITE_KIND_COVERS[c]).map((category) => ({ category, cover: SITE_KIND_COVERS[category] }))

/**
 * Подсказка пар «наш товар → товар сайта»: только точное совпадение названия (после нормализации); samePrice — и равная
 * цена (товары местности). По вхождению — нет: такие подсказки сохраняли скопом и привязывали не то.
 */
export function suggestPairs(products: { _id: any; name: string; price?: number }[], site: SiteProduct[], samePrice = false) {
	const out: Record<string, number> = {}
	for (const p of products) {
		const n = norm(p.name)
		const hit = n && site.find((s) => norm(s.name) === n && (!samePrice || Math.round(s.price * 100) === Math.round((p.price || 0) * 100)))
		if (hit) out[String(p._id)] = hit.id
	}
	return out
}
