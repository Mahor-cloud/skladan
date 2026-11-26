/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { Logger } from '@nestjs/common'
import { buildSchema } from '@typegoose/typegoose'
import { LitnaSession } from './litna.client'
import { LitnaController } from './litna.controller'
import { LitnaOrder } from './litna.model'
import { createCipheriv, createHash, randomBytes } from 'crypto'
import { seal, unseal } from '../common/seal'
import { PHOTO_QUOTA } from '../products/products.service'
import { LitnaService, orderNote } from './litna.service'

// своя копия шифрования, что была в litna.service.ts до перехода на common/seal: сохранённое ею должно читаться
function oldSeal(text: string, secret: string) {
	const iv = randomBytes(12)
	const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), iv, { authTagLength: 16 })
	const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
	return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.')
}

// Сайт подменён: fetch отвечает как lit-na.ru по образцам исследования. Настоящий сайт тесты не трогают.

// who — вошли под аккаунтом или гость; cart — чья корзина: аккаунта или гостевой сессии (кука wp_woocommerce_session)
type Call = { method: string; url: string; path: string; body: string; headers: Record<string, string>; who: string; cart: string }
type SiteOrder = { key: string; status: string; paid: boolean; total: number; note?: string; guest?: boolean; email?: string }

const CATALOG = [
	{
		id: 11,
		sku: 'A',
		name: 'Книга А',
		prices: { price: '100000', currency_minor_unit: 2 },
		is_in_stock: true,
		add_to_cart: { maximum: 50 },
		categories: [{ name: 'Товары' }, { name: 'Книги' }],
		images: [{ src: 'https://lit-na.ru/wp-content/uploads/a.jpg', thumbnail: 'https://lit-na.ru/wp-content/uploads/a-600x400.jpg', thumbnail_srcset: 'https://lit-na.ru/wp-content/uploads/a-300x200.jpg 300w' }],
	},
	{ id: 12, sku: 'B', name: 'Книга Б', prices: { price: '50000', currency_minor_unit: 2 }, is_in_stock: true, add_to_cart: { maximum: 3 }, categories: [{ name: 'Товары' }] },
	{ id: 13, sku: 'C', name: 'Нет в наличии', prices: { price: '20000', currency_minor_unit: 2 }, is_in_stock: false, add_to_cart: { maximum: 9999 } },
]
const rate = (rate_id: string, method_id: string, name: string, price: number) => ({ rate_id, method_id, name, price: String(price), currency_minor_unit: 2 })
const rub = (kop: number) => (kop / 100).toFixed(2)
const money = (kop: number) => rub(kop).replace(/\B(?=(\d{3})+\.)/g, ',')

function fakeSite() {
	const state = {
		calls: [] as Call[],
		carts: { guest: new Map<number, number>(), account: new Map<number, number>([[99, 1]]) } as Record<string, Map<number, number>>,
		// гостевые сессии: номер последней и ожидающий оплаты заказ сессии (как order_awaiting_payment у WooCommerce)
		sessions: 0,
		awaiting: new Map<string, number>(),
		nextId: 501,
		docsOnReceived: false,
		orders: new Map<number, SiteOrder>(),
		guestStatus: true,
		// ok | failure (заказа нет) | failure-created (отказ, но заказ создан) | nokey (создан, ключа в ответе нет)
		// | lost (создан, ответ потерян) | lost-empty (ответ потерян, заказа нет)
		checkoutMode: 'ok',
		// цена товара на сайте, коп.; bump — сменить цену товара 11, когда его кладут в корзину аккаунта
		price: new Map<number, number>(),
		bump: false,
		// во время оформления кто-то оформил на этом же аккаунте свой заказ (без нашего кода)
		foreignDuring: false,
		ordersBroken: false,
		viewBroken: false,
		pointsBroken: false,
		// адрес в пакете: ok — принят; refused — подзапрос отклонён; rejected — пакет с ним не принят целиком
		batchCustomer: 'ok',
		cancelWorks: true,
		noComments: false,
		// гостевые страницы заказа просят подтвердить почту (заказ старше ~10 минут)
		askEmail: false,
		// сайт лежит: на вход отвечает 503
		down: false,
		// раздел «Адрес» кабинета: что записано, что приложение туда отправляло, принимает ли сайт запись
		profile: { billing_first_name: 'Анна', billing_last_name: 'Сайтова', billing_country: 'RU', billing_address_1: 'ул. Рабочая, 7', billing_city: 'Саратов', billing_state: 'Саратовская область', billing_postcode: '410000', billing_phone: '+79111111111', billing_email: 'site@example.org' } as Record<string, string>,
		addressSaves: [] as Record<string, string>[],
		addressRefused: false,
		// документы заказа (счёт, упаковочный лист): есть ли ссылка на странице заказа и что отдаёт сайт по ней
		docs: true,
		pdfBroken: false,
		// заказов в кабинете больше, чем на первой странице
		morePages: false,
		outSum: null as string | null,
		// номер заказа в форме Robokassa, если не тот (сайт перепутал сессии)
		invId: null as string | null,
		cdekOk: true,
		bxbOk: true,
		reject: new Map<number, string>(),
		catalogBroken: false,
		checkout: null as URLSearchParams | null,
		checkouts: [] as URLSearchParams[],
	}
	const json = (body: any, headers: [string, string][] = [], status = 200) => ({ body: JSON.stringify(body), headers, status })
	const rates = (goods: number) =>
		goods >= 1_500_000
			? [rate('free_shipping:10', 'free_shipping', 'Бесплатная доставка', 0)]
			: [
				rate('official_cdek:139', 'official_cdek', 'CDEK: Посылка дверь-дверь, (2-3 дн.)', 105600),
				rate('official_cdek:138', 'official_cdek', 'CDEK: Посылка дверь-склад, (2-3 дн.)', 62500),
				rate('boxberry_self:11', 'boxberry_self', 'Яндекс Доставка до ПВЗ', 34459),
			]
	const priceOf = (id: number) => state.price.get(id) ?? Number(CATALOG.find((p) => p.id === id)?.prices.price || 0)
	const bag = (who: string) => (state.carts[who] ??= new Map())
	const goodsOf = (who: string) => [...bag(who).entries()].reduce((s, [id, q]) => s + priceOf(id) * q, 0)
	const cart = (who: string) => {
		const items = [...bag(who).entries()].map(([id, quantity]) => ({ id, quantity, prices: { price: String(priceOf(id)), currency_minor_unit: 2 } }))
		return {
			items,
			shipping_rates: items.length ? [{ shipping_rates: rates(goodsOf(who)) }] : [],
			extensions: { official_cdek: { points: JSON.stringify([{ code: 'SAR6', name: 'SAR6, Саратов, ул. Тестовая', work_time: 'Пн-Пт', location: { address_full: 'Россия, Саратов, ул. Тестовая, 1' } }]) } },
		}
	}
	const add = (who: string, { id, quantity }: any) => {
		const p = CATALOG.find((x) => x.id === id)
		const code = state.reject.get(id) || (!p ? 'woocommerce_rest_cart_invalid_product' : !p.is_in_stock ? 'woocommerce_rest_product_out_of_stock' : quantity > p.add_to_cart.maximum ? 'woocommerce_rest_product_partially_out_of_stock' : '')
		if (code) return { status: 400, body: { code, message: 'нет' } }
		bag(who).set(id, (bag(who).get(id) || 0) + quantity)
		return { status: 201, body: cart(who) }
	}
	// заказ сайта: у сессии уже есть ожидающий оплаты — он и возвращается (WooCommerce так сводит повтор к одному заказу)
	const place = (form: URLSearchParams, c: Call) => {
		const waiting = state.awaiting.get(c.cart)
		if (waiting && state.orders.get(waiting)?.status === 'pending') return waiting
		const shipping = rates(goodsOf(c.cart)).find((r) => r.rate_id === form.get('shipping_method[0]'))
		const total = goodsOf(c.cart) + Number(shipping.price)
		const id = state.nextId++
		state.orders.set(id, { key: id === 501 ? 'wc_order_K' : `wc_order_${id}`, status: 'pending', paid: false, total, note: form.get('order_comments') || '', guest: c.who !== 'account', email: form.get('billing_email') })
		state.awaiting.set(c.cart, id)
		// WooCommerce переносит адрес заказа в кабинет покупателя
		if (c.who === 'account') for (const [k, v] of form) if (k.startsWith('billing_')) state.profile[k] = v
		if (state.foreignDuring) state.orders.set(state.nextId++, { key: 'wc_order_F', status: 'pending', paid: false, total, note: '' })
		return id
	}
	const page = (who: string, inner = '') => `<html>${who === 'account' ? '<a href="/my-account/customer-logout/">Выйти</a>' : ''}${inner}</html>`
	const loginForm = '<form class="login"><input type="hidden" name="woocommerce-login-nonce" value="ln1" /></form>'
	const account = (inner: string) => `<div class="woocommerce-MyAccount-content wd-grid-col">${inner}</div>`
	const verifyForm = (path: string) =>
		`<form name="checkout" method="post" class="woocommerce-form woocommerce-verify-email" action="https://lit-na.ru${path.replace(/&/g, '&#038;')}">
		<p>Чтобы просмотреть эту страницу, вам необходимо либо войти, либо подтвердить адрес электронной почты, связанный с заказом.</p>
		<input type="email" name="email" value="" /><input type="hidden" name="check_submission" value="vs1" /><input type="hidden" name="_wp_http_referer" value="${path}" />
		<button type="submit" name="verify" value="1">Подтвердить</button></form>`
	const docA = (id: string | number) => `<a href="https://lit-na.ru/wp-admin/admin-ajax.php?action=generate_wpo_wcpdf&#038;document_type=invoice&#038;order_ids=${id}&#038;access_key=SECRETKEY&#038;my-account=true">Счет</a>`
	const ordersPage = () =>
		state.ordersBroken
			? account('<p>что-то новое</p>')
			: !state.orders.size
			? account('<div class="woocommerce-message woocommerce-message--info woocommerce-info">Заказов пока нет. <a class="button" href="/shop/">В магазин</a></div>')
			: account(`<table class="woocommerce-orders-table woocommerce-MyAccount-orders"><thead><tr><th>Заказ</th></tr></thead><tbody>${rows()}</tbody></table>${state.morePages ? '<a class="woocommerce-button woocommerce-button--next button" href="/my-account/orders/2/">Далее</a>' : ''}`)
	const rows = () =>
		[...state.orders.entries()]
			.sort(([a], [b]) => b - a)
			.map(
				([id, o]) => `<tr class="woocommerce-orders-table__row woocommerce-orders-table__row--status-${o.status} order">
				<th><a href="https://lit-na.ru/my-account/view-order/${id}/">№${id}</a></th>
				<td class="woocommerce-orders-table__cell-order-total"><bdi>${money(o.total)}&nbsp;₽</bdi> за 4 товара</td>
				<td>${['pending', 'failed'].includes(o.status) ? `<a href="https://lit-na.ru/checkout/order-pay/${id}/?pay_for_order=true&#038;key=${o.key}">Оплатить</a><a href="https://lit-na.ru/cart/?cancel_order=true&#038;order=${o.key}&#038;order_id=${id}&#038;_wpnonce=z">Отмена</a>` : ''}</td>
			</tr>`
			)
			.join('')

	function route(c: Call): { status?: number; body?: string; headers?: [string, string][]; fail?: boolean } {
		const form = new URLSearchParams(c.body)
		const store = c.path.startsWith('/wp-json/wc/store/v1/')
		if (store && c.method !== 'GET' && c.headers.Nonce !== `n-${c.who}`) return json({ code: 'woocommerce_rest_missing_nonce' }, [], 401)
		if (c.path.startsWith('/wp-json/wc/store/v1/products')) {
			if (state.catalogBroken) return json({ code: 'oops' }, [], 500)
			return json(c.path.includes('page=1') ? CATALOG.map((p) => ({ ...p, prices: { ...p.prices, price: String(priceOf(p.id)) } })) : [])
		}
		if (c.path === '/wp-json/wc/store/v1/cart') return json(cart(c.cart), [['Nonce', `n-${c.who}`]])
		if (c.path === '/wp-json/wc/store/v1/cart/items' && c.method === 'DELETE') return bag(c.cart).clear(), json([])
		if (c.path === '/wp-json/wc/store/v1/batch') {
			const { requests } = JSON.parse(c.body)
			const customer = requests.some((r: any) => r.path === '/wc/store/v1/cart/update-customer')
			if (customer && state.batchCustomer === 'rejected') return json({ code: 'rest_batch_not_allowed' }, [], 400)
			if (state.bump && c.who === 'account') state.price.set(11, 110000)
			const one = (r: any) =>
				r.headers.Nonce !== `n-${c.who}`
					? { status: 401, body: { code: 'woocommerce_rest_missing_nonce' } }
					: r.path === '/wc/store/v1/cart/add-item'
					? add(c.cart, r.body)
					: r.path === '/wc/store/v1/cart/update-customer' && state.batchCustomer === 'ok'
					? { status: 200, body: cart(c.cart) }
					: { status: 400, body: { code: 'rest_no_route' } }
			return json({ responses: requests.map(one) }, [], 207)
		}
		if (c.path === '/wp-json/wc/store/v1/cart/update-customer') return json(cart(c.cart))
		if (c.path.startsWith('/my-account/') && state.down) return { status: 503, body: '<html>Service Unavailable</html>' }
		if (c.path === '/my-account/' && c.method === 'GET') return { body: page(c.who, c.who === 'account' ? '' : loginForm) }
		if (c.path === '/my-account/' && c.method === 'POST') {
			const ok = form.get('password') === 'secret' && form.get('woocommerce-login-nonce') === 'ln1' && c.headers.Origin && c.headers.Referer
			return ok ? { status: 302, headers: [['Location', 'https://lit-na.ru/my-account/'], ['Set-Cookie', 'wordpress_logged_in_x=u1; path=/; HttpOnly']] } : { body: page('guest', loginForm) }
		}
		if (c.path === '/my-account/orders/') return { body: page(c.who, c.who === 'account' ? ordersPage() : loginForm) }
		if (c.path === '/my-account/edit-address/') return { body: page(c.who, c.who === 'account' ? account('<p>Адрес успешно изменён.</p>') : loginForm) }
		if (c.path === '/my-account/edit-address/billing/') {
			if (c.who !== 'account') return { body: page(c.who, loginForm) }
			const inputs = Object.entries(state.profile).map(([k, v]) => `<input type="text" name="${k}" value="${v}" />`).join('')
			const shown = { body: page(c.who, account(`<form method="post" novalidate>${inputs}<input type="hidden" name="woocommerce-edit-address-nonce" value="an1" /><input type="hidden" name="action" value="edit_address" /></form>`)) }
			if (c.method === 'GET') return shown
			const sent = Object.fromEntries(form)
			state.addressSaves.push(sent)
			if (state.addressRefused || sent['woocommerce-edit-address-nonce'] !== 'an1' || !c.headers.Origin || !c.headers.Referer || !sent.save_address) return shown
			for (const k of Object.keys(state.profile)) state.profile[k] = sent[k] ?? ''
			return { status: 302, headers: [['Location', 'https://lit-na.ru/my-account/edit-address/']] }
		}
		const view = c.path.match(/^\/my-account\/view-order\/(\d+)\/$/)
		if (view) {
			const o = state.orders.get(Number(view[1]))
			if (c.who !== 'account' || !o || state.viewBroken) return { body: page(c.who, c.who === 'account' ? account('<p>нет</p>') : loginForm) }
			const note = o.note ? `<tr><th>Примечание:</th><td> ${o.note} </td></tr>` : ''
			const doc = state.docs ? `<a href="https://lit-na.ru/wp-admin/admin-ajax.php?action=generate_wpo_wcpdf&#038;document_type=invoice&#038;order_ids=${view[1]}&#038;access_key=SECRETKEY&#038;my-account=true">Счет</a>` : ''
			return { body: page(c.who, account(`<table class="woocommerce-table woocommerce-table--order-details shop_table order_details"><tfoot><tr><th scope="row">Итого:</th><td>${money(o.total)}</td></tr>${note}</tfoot></table>${doc}`)) }
		}
		if (c.path === '/checkout/') {
			// сайт пускает к оформлению только от 3000 ₽ — так сейчас настроен магазин
			if (goodsOf(c.cart) < 300000) {
				return { body: page(c.who, `<ul class="woocommerce-error" role="alert"><li>Для размещения заказа в нём должно быть товаров минимум на 3,000.00&nbsp;&#8381;, а сейчас — ${money(goodsOf(c.cart))}&nbsp;&#8381;.</li></ul>`) }
			}
			return {
				body: page(c.who, `<script>{"update_order_review_nonce":"rv1"}</script><form name="checkout"><input name="billing_first_name" value="" /><input name="billing_address_2" value="" />
				<select name="woo_pek_doc"><option value="p">П</option></select>${state.noComments ? '' : '<textarea name="order_comments"></textarea>'}
				<input type="hidden" name="woocommerce-process-checkout-nonce" value="cn1" /></form>`),
			}
		}
		if (c.path === '/?wc-ajax=official_cdek_save-office') return json({ success: state.cdekOk })
		if (c.path === '/?wc-ajax=checkout') {
			// гостю — только с почтой и телефоном, и корзина должна быть (у умершей сессии её нет)
			const guestBad = c.who !== 'account' && (!form.get('billing_email') || !form.get('billing_phone'))
			if (guestBad || !bag(c.cart).size || form.get('woocommerce-process-checkout-nonce') !== 'cn1' || form.get('privacy_policy_checkbox') !== 'on') {
				return json({ result: 'failure', messages: '<ul class="woocommerce-error"><li>Ошибка</li></ul>' })
			}
			state.checkout = form
			state.checkouts.push(form)
			if (state.checkoutMode === 'failure') return json({ result: 'failure', messages: '<ul class="woocommerce-error"><li>Нет в наличии</li></ul>' })
			if (state.checkoutMode === 'lost-empty') return { fail: true }
			const id = place(form, c)
			const key = state.orders.get(id).key
			if (state.checkoutMode === 'failure-created') return json({ result: 'failure', messages: '<ul class="woocommerce-error"><li>Ошибка платёжного шлюза</li></ul>' })
			// сбой шлюза один раз: заказ создан, повтор проходит
			if (state.checkoutMode === 'failure-created-once') {
				state.checkoutMode = 'ok'
				return json({ result: 'failure', messages: '<ul class="woocommerce-error"><li>Ошибка платёжного шлюза</li></ul>' })
			}
			if (state.checkoutMode === 'lost') return { fail: true }
			if (state.checkoutMode === 'nokey') return json({ result: 'success', redirect: `https://lit-na.ru/checkout/order-received/${id}/`, order_id: id })
			return json({ result: 'success', redirect: `https://lit-na.ru/checkout/order-pay/${id}/?key=${key}`, order_id: id })
		}
		if (c.path === '/?wc-ajax=update_order_review') {
			return json({ fragments: { '.t': `<a class="bxbbutton" data-boxberry-token="1$tok" data-boxberry-target-start="ts" data-boxberry-city="МОСКВА" data-boxberry-weight="500" data-ordersum="1000">x</a>` } })
		}
		if (c.path === '/wp-admin/admin-ajax.php') {
			if (!/beget=begetok/.test(c.headers.Cookie || '')) return { body: "<script>document.cookie='beget=begetok'</script>" }
			if (form.get('action') === 'boxberry_update') {
				const cookies: [string, string][] = state.bxbOk ? [['Set-Cookie', `bxb_code=${form.get('code')}; path=/`], ['Set-Cookie', 'bxb_address=x; path=/']] : []
				return { body: '0', headers: cookies }
			}
			const o = state.orders.get(Number(form.get('orderId')))
			if (c.who === 'guest' && !state.guestStatus) return { body: '0' }
			if (!o || form.get('orderKey') !== o.key) return json({ success: false, data: { message: 'invalid_order' } })
			return json({ success: true, data: { paid: o.paid, status: o.status } })
		}
		const pay = c.path.match(/^\/checkout\/order-pay\/(\d+)\/\?(pay_for_order=true&)?key=(\w+)$/)
		if (pay) {
			const o = state.orders.get(Number(pay[1]))
			// заказ аккаунта — только со входом; гостевой — по ключу и без входа
			if (o?.key !== pay[3] || (!o.guest && c.who !== 'account')) return { body: page(c.who, loginForm) }
			// как на сайте: ссылки отмены на странице оплаты нет — она на странице «заказ получен»
			const guestLinks = o.guest && state.docs && !state.docsOnReceived ? docA(pay[1]) : ''
			const payPage = { body: page(c.who, `<form id="order_review"><input type="hidden" name="woocommerce-pay-nonce" value="pn1" /></form>${guestLinks}`) }
			const robokassa = { body: page(c.who, `<form action="https://auth.robokassa.ru/Merchant/Index.aspx" method="POST"><input type="hidden" name="InvId" value="${state.invId ?? pay[1]}"><input type="hidden" name="OutSum" value="${state.outSum ?? rub(o.total)}"></form>`) }
			// подтверждение почты: верная почта — настоящая страница прямо в ответе
			if (c.method === 'POST' && form.get('verify') === '1') {
				if (form.get('email') !== o.email || form.get('check_submission') !== 'vs1') return { body: page(c.who, verifyForm(c.path)) }
				return pay[2] ? payPage : robokassa
			}
			if (o.guest && state.askEmail && c.method === 'GET') return { body: page(c.who, verifyForm(c.path)) }
			return pay[2] ? payPage : robokassa
		}
		const received = c.path.match(/^\/checkout\/order-received\/(\d+)\/\?key=(\w+)$/)
		if (received) {
			const o = state.orders.get(Number(received[1]))
			if (o?.key !== received[2]) return { body: page(c.who, '<p>Спасибо</p>') }
			const confirming = c.method === 'POST' && form.get('verify') === '1'
			if (confirming && form.get('email') !== o.email) return { body: page(c.who, verifyForm(c.path)) }
			if (!confirming && o.guest && state.askEmail) return { body: page(c.who, verifyForm(c.path)) }
			const cancelA = ['pending', 'failed'].includes(o.status) ? `<a href="https://lit-na.ru/cart/?cancel_order=true&#038;order=${o.key}&#038;order_id=${received[1]}&#038;_wpnonce=z" class="button cancel">Отмена</a>` : ''
			return { body: page(c.who, `<p>Спасибо</p>${cancelA}${state.docs && state.docsOnReceived ? docA(received[1]) : ''}`) }
		}
		const cancel = c.path.match(/^\/cart\/\?cancel_order=true&order=(\w+)&order_id=(\d+)/)
		if (cancel && (c.who === 'account' || state.orders.get(Number(cancel[2]))?.guest)) {
			if (state.cancelWorks) state.orders.get(Number(cancel[2])).status = 'cancelled'
			return { body: page(c.who) }
		}
		if (c.path.startsWith('/wp-admin/admin-ajax.php?action=generate_wpo_wcpdf')) {
			const q = new URL(c.url).searchParams
			const guestDoc = state.orders.get(Number(q.get('order_ids')))?.guest
			if ((c.who !== 'account' && !guestDoc) || q.get('access_key') !== 'SECRETKEY' || !/beget=begetok/.test(c.headers.Cookie || '')) return { body: '<html>нет доступа</html>' }
			return { body: state.pdfBroken ? '<html>ошибка плагина</html>' : `%PDF-1.7 ${q.get('document_type')} ${q.get('order_ids')}`, headers: [['Content-Type', 'application/pdf']] }
		}
		if (c.url === 'https://points.boxberry.ru/map/index.php') {
			if (state.pointsBroken) return json({ err: 'Неверный токен' })
			return json([
				{ properties: { pointid: 'y1', cityname: 'Саратов', Address: '410000, Саратов, ул. Первая', WorkSchedule: 'пн-вс', zip: '410000' } },
				{ properties: { pointid: 'y2', cityname: 'Казань', Address: '420000, Казань, ул. Вторая', WorkSchedule: 'пн-пт', zip: '420000' } },
			])
		}
		return { status: 404, body: '' }
	}

	global.fetch = jest.fn(async (url: any, init: any = {}) => {
		const u = new URL(String(url))
		const headers = init.headers || {}
		const who = /wordpress_logged_in/.test(headers.Cookie || '') ? 'account' : 'guest'
		// гостю сайт заводит сессию на первом обращении к корзине; без куки — новая (пустая) сессия
		let session = (headers.Cookie || '').match(/wp_woocommerce_session_x=([^;]+)/)?.[1]
		const opened = !session && who === 'guest' && u.pathname.startsWith('/wp-json/wc/store/v1/') && !u.pathname.endsWith('/products')
		if (opened) session = `g${++state.sessions}`
		const c: Call = { method: init.method || 'GET', url: String(url), path: u.pathname + u.search, body: init.body || '', headers, who, cart: who === 'account' ? 'account' : session || 'guest' }
		state.calls.push(c)
		await new Promise((r) => setImmediate(r))
		const r = route(c)
		if (r.fail) throw new TypeError('fetch failed')
		return new Response(r.body ?? '', { status: r.status || 200, headers: [...(r.headers || []), ...(opened ? ([['Set-Cookie', `wp_woocommerce_session_x=${session}; path=/`]] as [string, string][]) : [])] })
	}) as any
	return state
}

// сбои сайта пишутся в журнал: в тестах — без вывода, но проверяемо
let warn: jest.SpyInstance
let log: jest.SpyInstance
beforeEach(() => {
	warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
	log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
})
afterEach(() => {
	warn.mockRestore()
	log.mockRestore()
})

const q = (v: any) => {
	const o: any = { exec: async () => v, lean: () => o, select: () => o, populate: () => o }
	return o
}
const SECRET = 'litna:jwt'
const P1 = 'a'.repeat(24)
const P2 = 'b'.repeat(24)
const P3 = 'c'.repeat(24)
const USER: any = { _id: 'u1', company: 'c1', name: 'Казначей', isAdmin: true }
const checkouts = (site: ReturnType<typeof fakeSite>) => site.calls.filter((c) => c.path === '/?wc-ajax=checkout').length

function setup(over: { account?: any; purchase?: any; placed?: any; known?: number[]; products?: any[]; seed?: any; env?: Record<string, string> } = {}) {
	const db: any = {
		account: over.account === null ? null : {
			company: 'c1',
			login: 'na@example.org',
			password: seal('secret', SECRET),
			firstName: 'Иван',
			lastName: 'Петров',
			phone: '+79000000000',
			email: 'na@example.org',
			address: '',
			delivery: { kind: 'cdek_pvz', code: 'SAR6', title: 'SAR6, Саратов, ул. Тестовая', city: 'Саратов' },
			...over.account,
		},
		purchase: {
			_id: 'pu1',
			company: 'c1',
			purchaseNumber: 31,
			isCreated: false,
			isPaid: false,
			items: [
				{ product: P1, quantity: 2, confirmedQuantity: 0, price: 900 },
				{ product: P2, quantity: 2, confirmedQuantity: 0, price: 400 },
				{ product: P3, quantity: 0, confirmedQuantity: 0 },
			],
			...over.purchase,
		},
		// копия: тесты меняют запись, общие заготовки должны оставаться прежними
		placed: over.placed ? { ...over.placed } : null,
		// пары — в самих товарах: у Брелка пару ещё не выбирали
		products: over.products ?? [
			{ _id: P1, name: 'Книга А', litnaId: 11 },
			{ _id: P2, name: 'Книга Б', litnaId: 12 },
			{ _id: P3, name: 'Брелок' },
		],
		seed: over.seed ?? null,
		photos: [] as any[],
		// уже занятый объём фото местности сверх записанных тестом
		photoBase: 0,
		photoSet: [] as any[],
		emitted: [] as any[],
		known: (over.known || []).map((orderId) => ({ orderId })),
		writes: [] as string[],
		history: [] as any[],
	}
	const purchases = {
		update: jest.fn(async (id: string, dto: any) => (db.writes.push(dto.isPaid ? 'paid' : 'created'), { _id: id, ...db.purchase, ...dto })),
		remove: jest.fn(async (id: string) => (db.writes.push('removed'), { _id: id })),
		// как сервис закупок: только созданная, неоплаченная и без принятого
		toDraft: jest.fn(async (id: string, _user: any, description: string) => {
			const p = db.purchase
			if (!p.isCreated || p.isPaid || (p.items || []).some((i: any) => i.confirmedQuantity > 0)) return null
			db.writes.push('draft')
			db.drafted = description
			const { litna, ...rest } = p
			return (db.purchase = { ...rest, _id: id, isCreated: false })
		}),
	}
	const svc = new LitnaService(
		{
			findOne: () => q(db.account),
			updateOne: (f: any, u: any) => {
				db.accountUpdate = [f, u]
				if (db.account) Object.assign(db.account, u.$set || u)
				return q({})
			},
		} as any,
		{
			findOne: () => q(db.placed?.deletedAt ? null : db.placed),
			find: () => q([...db.known, ...(db.placed?.orderId ? [{ orderId: db.placed.orderId }] : [])]),
			create: async (doc: any) => (db.writes.push('intent'), (db.placed = { _id: 'o1', ...doc })),
			updateOne: (f: any, u: any) => {
				if (f.missingAt === null && db.placed?.missingAt) return q({ modifiedCount: 0 })
				db.writes.push(u.orderId ? 'bind' : u.deletedAt ? 'deleted' : u.startedAt ? 'sent' : u.missingAt ? 'missing' : 'payer')
				const { $unset, ...set } = u
				db.placed = { ...db.placed, ...set }
				for (const k of Object.keys($unset || {})) delete db.placed[k]
				return q({ modifiedCount: 1 })
			},
			// условная запись: «не закрыта» и «форму не выдавали последние 30 минут» — как в Mongo
			findOneAndUpdate: (f: any, u: any) => {
				const p = db.placed
				const open = p && !p.deletedAt
				const payOk = !f.$or || !p?.payAt || f.$or.some((c: any) => c.payAt?.$lt !== undefined && p.payAt < c.payAt.$lt)
				if (!open || !payOk) return q(null)
				db.writes.push(u.deletedAt ? 'closed' : 'payer')
				db.placed = { ...p, ...u }
				return q(db.placed)
			},
			deleteOne: () => (db.writes.push('drop'), (db.placed = null), q({})),
		} as any,
		{
			findById: () => q(db.purchase),
			updateOne: (f: any, u: any) => {
				if (f.isCreated === false && db.purchase.isCreated) return q({ matchedCount: 0 })
				if (u['litna.status']) {
					db.writes.push(`status:${u['litna.status']}`)
					db.purchase = { ...db.purchase, litna: { ...db.purchase.litna, status: u['litna.status'], ...(u['litna.paidAt'] && { paidAt: u['litna.paidAt'] }) } }
				} else if (u.$unset) {
					db.writes.push('unset')
					const { litna, ...rest } = db.purchase
					db.purchase = rest
				} else {
					db.writes.push(u.items ? 'purchase' : `litna:${u.litna.status}`)
					db.purchase = { ...db.purchase, ...u }
				}
				return q({ matchedCount: 1 })
			},
			findByIdAndUpdate: (id: any, u: any) => ((db.purchase = { ...db.purchase, litna: { ...db.purchase.litna, status: u['litna.status'] } }), q(db.purchase)),
		} as any,
		{
			find: () => q(db.products),
			bulkWrite: async (ops: any[]) => ((db.bulk = ops), { modifiedCount: ops.length }),
			updateOne: (f: any, u: any) => (db.photoSet.push([f, u]), q({ matchedCount: 1 })),
		} as any,
		{ findById: () => q({ _id: 'payer', name: 'Платил' }) } as any,
		{ findOne: () => q(db.seed) } as any,
		{
			create: async (doc: any) => db.photos.push(doc),
			deleteOne: (f: any) => ((db.photos = db.photos.filter((p: any) => p.token !== f.token)), q({})),
			aggregate: () => q([{ bytes: db.photos.reduce((n: number, p: any) => n + p.data.length, db.photoBase) }]),
		} as any,
		purchases as any,
		{ createChangeHistory: async (h: any, opts?: any) => db.history.push(opts ? { ...h, opts } : h) } as any,
		{ get: (k: string) => ({ JWT_SECRET: 'jwt', ...over.env })[k] } as any,
		{ emit: (company: string, type: string) => db.emitted.push([company, type]) } as any
	)
	return { svc, db, purchases }
}

const idle = () => new Promise((r) => setTimeout(r, 20))

describe('пароль сайта', () => {
	it('шифруется: в записи нет пароля, расшифровка — только тем же ключом и с полной меткой', () => {
		const sealed = seal('пароль-1', SECRET)
		expect(sealed).not.toContain('пароль')
		expect(sealed.split('.')).toHaveLength(3)
		expect(unseal(sealed, SECRET)).toBe('пароль-1')
		expect(() => unseal(sealed, 'другой')).toThrow()
		const [iv, tag, data] = sealed.split('.')
		const short = Buffer.from(tag, 'base64').subarray(0, 4).toString('base64')
		expect(() => unseal([iv, short, data].join('.'), SECRET)).toThrow('формат')
	})

	it('пароль, сохранённый прежней копией шифрования (метка litna, секрет JWT), читается сервисом', async () => {
		const site = fakeSite()
		const { svc } = setup({ account: { password: oldSeal('secret', 'litna:jwt') } })
		await svc.order('pu1', 3625, USER)
		expect(site.calls.some((c) => c.path === '/my-account/' && c.method === 'POST' && new URLSearchParams(c.body).get('password') === 'secret')).toBe(true)
	})

	it('наружу не отдаётся; PUT — только получатель и доставка; смена — в историю без значений', async () => {
		fakeSite()
		const { svc, db } = setup()
		const a: any = await svc.account()
		expect(a).toMatchObject({ configured: true, login: 'na@example.org', loginFailed: false })
		expect(a).not.toHaveProperty('hasPassword')
		expect(a).not.toHaveProperty('links')
		expect(JSON.stringify(a)).not.toContain(db.account.password)
		fakeSite()
		await svc.saveAccount({ firstName: 'Пётр', street: ' ул.  Тельмана,\n5 ', city: 'Энгельс', state: '', postcode: '413100' } as any, USER)
		expect(db.accountUpdate).toEqual([{ company: 'c1' }, { $set: { firstName: 'Пётр', street: 'ул. Тельмана, 5', city: 'Энгельс', state: '', postcode: '413100' } }])
		expect(db.history).toEqual([expect.objectContaining({ user: 'u1', changeType: 'litna-account-updated', description: 'Аккаунт lit-na.ru изменён' })])
		expect(JSON.stringify(db.history)).not.toContain('Энгельс')
	})

	it('вход: проверяется сейчас, удачный сохраняется (пароль шифрованным); неудачный — 400 и ничего не сохраняется', async () => {
		const site = fakeSite()
		const { svc, db } = setup({ account: { login: '', password: '' } })
		expect((await svc.account()).login).toBeNull()
		await expect(svc.login({ login: 'na@example.org', password: 'неверный' }, USER)).rejects.toThrow('Не удалось войти — проверьте почту и пароль')
		expect(db.account.login).toBe('')
		expect(db.history).toHaveLength(0)
		const a = await svc.login({ login: 'na@example.org', password: 'secret' }, USER)
		expect(a).toMatchObject({ login: 'na@example.org', loginFailed: false })
		expect(unseal(db.account.password, SECRET)).toBe('secret')
		expect(db.history).toHaveLength(1)
		// сессия входа сохранена: заказ не входит второй раз
		const logins = () => site.calls.filter((c) => c.path === '/my-account/' && c.method === 'POST').length
		const before = logins()
		await svc.order('pu1', 3625, USER)
		expect(logins()).toBe(before)
	})

	it('в бою без LITNA_KEY пароль не сохраняется и на сайт не входим; сохранённый прежде — читается', async () => {
		const site = fakeSite()
		const { svc, db } = setup({ account: { login: '', password: '' }, env: { NODE_ENV: 'production' } })
		await expect(svc.login({ login: 'na@example.org', password: 'secret' }, USER)).rejects.toThrow('Не задан ключ LITNA_KEY')
		expect(site.calls).toHaveLength(0)
		expect(db.account.password).toBe('')
		const old = setup({ env: { NODE_ENV: 'production' } })
		await old.svc.order('pu1', 3625, USER)
		expect(site.calls.some((c) => c.path === '/my-account/' && c.method === 'POST' && new URLSearchParams(c.body).get('password') === 'secret')).toBe(true)
	})

	it('выход: снова гость — логин и пароль убраны, в историю', async () => {
		fakeSite()
		const { svc, db } = setup()
		expect(await svc.logout(USER)).toMatchObject({ login: null, loginFailed: false, configured: true })
		expect(db.account).toMatchObject({ login: '', password: '' })
		expect(db.history).toHaveLength(1)
	})
})

describe('каталог', () => {
	it('товары сайта (с признаком картинки) и подсказка пар: пару не выбирали, то же название и та же цена', async () => {
		fakeSite()
		const products = [
			{ _id: P1, name: 'Книга А', litnaId: 11, price: 1000 },
			{ _id: P2, name: 'Книга Б', price: 500 },
			{ _id: P3, name: 'Нет в наличии', litnaId: null, price: 200 },
			// то же название, другая цена — без подсказки; вхождение названия — тоже нет
			{ _id: 'd'.repeat(24), name: 'КНИГА «А»', price: 999 },
			{ _id: 'e'.repeat(24), name: 'Книга', price: 500 },
		]
		const res = await setup({ products }).svc.catalog()
		expect(res.items).toEqual([
			{ id: 11, sku: 'A', name: 'Книга А', price: 1000, stock: 50, inStock: true, category: 'Книги', image: true },
			{ id: 12, sku: 'B', name: 'Книга Б', price: 500, stock: 3, inStock: true, category: '', image: false },
			{ id: 13, sku: 'C', name: 'Нет в наличии', price: 200, stock: 0, inStock: false, category: '', image: false },
		])
		// адрес картинки наружу не уходит
		expect(JSON.stringify(res)).not.toContain('wp-content')
		expect(res.suggest).toEqual({ [P2]: 12 })
	})

	it('«Семена»: подсказка по товарам шаблона, ключ — название; только точное название, цену не сверяем', async () => {
		fakeSite()
		const seed = { products: [{ name: 'Книга Б', price: 1 }, { name: 'Книга А', litnaId: 11 }, { name: 'Нет в наличии', litnaId: null }, { name: 'Книга' }] }
		expect((await setup({ seed }).svc.catalog(true)).suggest).toEqual({ 'Книга Б': 12 })
	})

	it('массовая правка пар: litnaId — в перечисленные товары своей местности, null — намеренно без пары; одна запись в историю без push', async () => {
		fakeSite()
		const { svc, db } = setup()
		expect(await svc.saveLinks([{ product: P1.toUpperCase(), siteId: 11 }, { product: P1, siteId: 12 }, { product: P3, siteId: null }] as any, USER)).toEqual({ ok: true })
		expect(db.bulk).toEqual([
			{ updateOne: { filter: { _id: P1, company: 'c1', litnaId: { $ne: 12 } }, update: { $set: { litnaId: 12 } } } },
			{ updateOne: { filter: { _id: P3, company: 'c1', litnaId: { $not: { $type: 'null' } } }, update: { $set: { litnaId: null } } } },
		])
		expect(db.history).toEqual([expect.objectContaining({ changeType: 'litna-links-updated', description: 'Привязка к lit-na.ru изменена: 2 товара', opts: { push: false } })])
	})

	it('картинка товара сайта: байты с lit-na.ru, только картинка, чужой адрес и не-картинка — 502', async () => {
		const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)])
		const svc = setup().svc
		const answer = (body: Buffer | string, src = 'https://lit-na.ru/wp-content/uploads/a.jpg') =>
			(global.fetch = jest.fn(async (url: any) =>
				String(url).includes('/wp-json/') ? new Response(JSON.stringify([{ ...CATALOG[0], images: [{ src }] }])) : new Response(body)
			) as any)
		answer(jpeg)
		expect(await svc.image(11)).toEqual({ contentType: 'image/jpeg', bytes: jpeg })
		await expect(svc.image(12)).rejects.toThrow('нет картинки')
		answer('<html>не картинка</html>')
		await expect(setup().svc.image(11)).rejects.toThrow('не отдал картинку')
		answer(jpeg, 'https://evil.example/a.jpg')
		await expect(setup().svc.image(11)).rejects.toThrow('не отвечает')
	})

	it('сбой страницы каталога — 502, в кэш не попадает; минуту без новых попыток; прежний каталог отдаётся при сбое', async () => {
		const site = fakeSite()
		site.catalogBroken = true
		const { svc } = setup()
		await expect(svc.siteCatalog()).rejects.toThrow('каталог')
		site.catalogBroken = false
		const asked = () => site.calls.filter((c) => c.path.startsWith('/wp-json/wc/store/v1/products')).length
		const before = asked()
		await expect(svc.siteCatalog()).rejects.toThrow('каталог')
		expect(asked()).toBe(before)
		;(svc as any).catalogFailedAt -= 61_000
		expect(await svc.siteCatalog()).toHaveLength(3)
		// каталог устарел, сайт снова сбоит — отдаётся прежний
		;(svc as any).catalogCache.at -= 11 * 60_000
		site.catalogBroken = true
		expect(await svc.siteCatalog()).toHaveLength(3)
	})

	it('одна загрузка каталога и одна загрузка миниатюры на всех ждущих; миниатюра живёт сутки', async () => {
		const site = fakeSite()
		const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)])
		const real = global.fetch as jest.Mock
		global.fetch = jest.fn(async (url: any, init: any) => (String(url).includes('/uploads/') ? new Response(png) : real(url, init))) as any
		const { svc } = setup()
		await Promise.all([svc.thumb(11), svc.thumb(11), svc.siteCatalog(), svc.thumb(11)])
		const calls = (global.fetch as jest.Mock).mock.calls.map((c) => String(c[0]))
		expect(calls.filter((u) => u.includes('/products?')).length).toBe(1)
		expect(calls.filter((u) => u.includes('/uploads/')).length).toBe(1)
		;(svc as any).thumbs.get(11).at -= 25 * 3600_000
		await svc.thumb(11)
		expect((global.fetch as jest.Mock).mock.calls.filter((c) => String(c[0]).includes('/uploads/')).length).toBe(2)
		expect(site).toBeDefined()
	})
})

describe('расчёт', () => {
	it('в гостевой корзине: способ по виду из аккаунта, пункт в адресе, корзина очищена, корзина аккаунта не тронута', async () => {
		const site = fakeSite()
		const { svc } = setup()
		const quote = await svc.quote('pu1', USER)
		expect(quote).toMatchObject({ goods: 3000, shipping: 625, total: 3625, free: false, problems: [], notice: null, canOrder: true })
		expect(quote.delivery).toEqual({ kind: 'cdek_pvz', title: 'CDEK — пункт выдачи', point: 'SAR6, Саратов, ул. Тестовая' })
		expect(quote.lines).toEqual([
			{ product: P1, name: 'Книга А', quantity: 2, siteId: 11, siteName: 'Книга А', price: 1000, stock: 50, problem: null },
			{ product: P2, name: 'Книга Б', quantity: 2, siteId: 12, siteName: 'Книга Б', price: 500, stock: 3, problem: null },
		])
		// под аккаунтом — только сверка адреса с кабинетом (вход и страница «Адрес»): корзина аккаунта в расчёте не участвует
		const cabinet = (c: any) => c.path.startsWith('/my-account/')
		expect(site.calls.filter((c) => !cabinet(c)).every((c) => c.who === 'guest')).toBe(true)
		expect(site.calls.filter(cabinet).at(-1)).toMatchObject({ method: 'GET', path: '/my-account/edit-address/billing/' })
		// кроме каталога — три запроса: токен, строки с адресом одним пакетом, страница оформления; одноразовую корзину не чистим
		expect(site.calls.filter((c) => !c.path.includes('/products') && !cabinet(c)).map((c) => `${c.method} ${c.path}`)).toEqual([
			'GET /wp-json/wc/store/v1/cart',
			'POST /wp-json/wc/store/v1/batch',
			'GET /checkout/',
		])
		const requests = JSON.parse(site.calls.find((c) => c.path.endsWith('/batch')).body).requests
		expect(requests.map((r: any) => r.path)).toEqual(['/wc/store/v1/cart/add-item', '/wc/store/v1/cart/add-item', '/wc/store/v1/cart/update-customer'])
		const customer = requests[2].body
		expect(customer.shipping_address).toMatchObject({ country: 'RU', city: 'Саратов', address_1: 'ПВЗ CDEK: SAR6, Саратов, ул. Тестовая' })
		expect(customer.billing_address.email).toBe('na@example.org')
		expect([...site.carts.account]).toEqual([[99, 1]])
	})

	it('адрес в пакете не принят — отдельным запросом; пакет не принят целиком — строки заново, адрес отдельно', async () => {
		for (const mode of ['refused', 'rejected']) {
			const site = fakeSite()
			site.batchCustomer = mode
			const quote = await setup().svc.quote('pu1', USER)
			expect(quote).toMatchObject({ total: 3625, canOrder: true })
			expect(site.calls.filter((c) => c.path.endsWith('/update-customer'))).toHaveLength(1)
			// в корзине — ровно по одному набору строк
			const cart = Object.entries(site.carts).find(([k, c]) => k !== 'account' && c.size)[1]
			expect([...cart]).toEqual([[11, 2], [12, 2]])
		}
	})

	it('строки с проблемами: нет на сайте, не хватает, без привязки (и намеренно без пары) — корзину не собирает', async () => {
		const site = fakeSite()
		const { svc } = setup({
			products: [{ _id: P1, name: 'Книга А', litnaId: 404 }, { _id: P2, name: 'Книга Б', litnaId: 12 }, { _id: P3, name: 'Брелок', litnaId: null }],
			purchase: { items: [{ product: P1, quantity: 1 }, { product: P2, quantity: 5 }, { product: P3, quantity: 1 }] },
		})
		const quote = await svc.quote('pu1', USER)
		expect(quote.lines.map((l) => l.problem)).toEqual(['gone', 'stock', 'unlinked'])
		// коды строк — только в строках; в problems — уровня заказа
		expect(quote.problems).toEqual([])
		expect(quote.canOrder).toBe(false)
		expect(site.calls.some((c) => c.path.includes('/cart'))).toBe(false)
	})

	it('отказ сайта при добавлении — по коду: нет товара → gone; непонятная ошибка — 502, а не ложный «мало»', async () => {
		const site = fakeSite()
		site.reject.set(12, 'woocommerce_rest_cart_invalid_product')
		const quote = await setup().svc.quote('pu1', USER)
		expect(quote.lines.map((l) => l.problem)).toEqual([null, 'gone'])
		expect(quote.canOrder).toBe(false)
		site.reject.set(12, 'woocommerce_rest_something_else')
		await expect(setup().svc.quote('pu1', USER)).rejects.toThrow('не отвечает')
	})

	it('аккаунт не заполнен, пункт не выбран, способа нет среди пришедших; сайт не пускает к оформлению — его текст', async () => {
		fakeSite()
		expect((await setup({ account: { phone: '' } }).svc.quote('pu1', USER)).problems).toEqual(['account'])
		expect((await setup({ account: { delivery: { kind: 'yandex_pvz', city: 'Саратов' } } }).svc.quote('pu1', USER)).problems).toEqual(['point'])
		// курьера Яндекса в этот город сайт не предложил
		expect((await setup({ account: { delivery: { kind: 'yandex_door' }, address: 'Саратов, ул. Ленина, 1' } }).svc.quote('pu1', USER)).problems).toEqual(['delivery'])
		// до двери без города в начале адреса — аккаунт не заполнен
		expect((await setup({ account: { delivery: { kind: 'cdek_door' }, address: 'ул. Ленина, 1' } }).svc.quote('pu1', USER)).problems).toEqual(['account'])
		const small = await setup({ purchase: { items: [{ product: P2, quantity: 1 }] } }).svc.quote('pu1', USER)
		expect(small).toMatchObject({ goods: 500, problems: ['site'], canOrder: false })
		expect(small.notice).toBe('Для размещения заказа в нём должно быть товаров минимум на 3,000.00 ₽, а сейчас — 500.00 ₽.')
		expect(small).not.toHaveProperty('min')
		// пустой черновик заказывать нечего
		expect(await setup({ purchase: { items: [] } }).svc.quote('pu1', USER)).toMatchObject({ lines: [], canOrder: false })
	})

	it('от 15 000 ₽ — единственная бесплатная доставка; в примечании заказа — адрес получателя и комментарий', async () => {
		const site = fakeSite()
		const account = { postcode: '410019', city: 'Саратов', street: 'ул. Ручная, 7', comment: 'Терминал на Соколовой', delivery: { kind: 'cdek_pvz', code: 'SAR6', title: 'SAR6, Саратов, ул. Тестовая', city: 'Саратов' } }
		const ctx = setup({ account, purchase: { items: [{ product: P1, quantity: 15 }] } })
		const quote = await ctx.svc.quote('pu1', USER)
		expect(quote).toMatchObject({ goods: 15000, shipping: 0, total: 15000, free: true, canOrder: true })
		expect(quote.delivery).toEqual({ kind: 'cdek_pvz', title: 'CDEK — пункт выдачи', point: 'SAR6, Саратов, ул. Тестовая' })
		await ctx.svc.order('pu1', 15000, USER)
		expect(site.checkout.get('order_comments')).toBe(`СкладАН · закупка №31 (код ${ctx.db.placed.code}) · Адрес: 410019, Саратов, ул. Ручная, 7 · Терминал на Соколовой`)
	})

	it('у созданной закупки расчёта нет', async () => {
		fakeSite()
		await expect(setup({ purchase: { isCreated: true } }).svc.quote('pu1', USER)).rejects.toThrow('уже создана')
	})
})

describe('заказ', () => {
	it('другая сумма — 409 с новым расчётом; ни намерения, ни входа', async () => {
		const site = fakeSite()
		const { svc, db } = setup()
		const err: any = await svc.order('pu1', 3600, USER).catch((e) => e)
		expect(err.status).toBe(409)
		// тело 409 — сам расчёт, без обёртки
		expect(err.response).toMatchObject({ total: 3625, canOrder: true, problems: [] })
		expect(db.writes).toEqual([])
		expect(site.calls.some((c) => c.who === 'account' || c.path === '/my-account/')).toBe(false)
	})

	it('оформляет: намерение с кодом и пометка закупки до отправки формы, код — в примечании заказа, сверка суммы, «создана»', async () => {
		const site = fakeSite()
		const { svc, db, purchases } = setup()
		await svc.order('pu1', 3625, USER)
		const login = site.calls.find((c) => c.path === '/my-account/' && c.method === 'POST')
		expect(login.headers).toMatchObject({ Origin: 'https://lit-na.ru', Referer: 'https://lit-na.ru/my-account/' })
		expect(site.calls.find((c) => c.path === '/?wc-ajax=official_cdek_save-office').body).toBe('code=SAR6')
		const sent = site.checkout
		expect(sent.get('shipping_method[0]')).toBe('official_cdek:138')
		expect(sent.get('office_code')).toBe('SAR6')
		expect(sent.get('payment_method')).toBe('robokassa')
		expect(sent.get('billing_address_1')).toBe('ПВЗ CDEK: SAR6, Саратов, ул. Тестовая')
		expect(sent.get('billing_email')).toBe('na@example.org')
		expect(sent.get('woo_pek_doc')).toBe('p')
		expect(db.placed.code).toMatch(/^[A-Z2-9]{8}$/)
		expect(sent.get('order_comments')).toBe(`СкладАН · закупка №31 (код ${db.placed.code})`)
		// страница оплаты открыта после оформления — сумма сверена
		expect(site.calls.some((c) => c.path === '/checkout/order-pay/501/?key=wc_order_K')).toBe(true)
		// чужая позиция корзины аккаунта убрана до заказа, после заказа корзина пуста
		// очистка корзины аккаунта — фоном, после сверки суммы
		await idle()
		expect(site.carts.account.size).toBe(0)
		expect(db.writes).toEqual(['intent', 'litna:placing', 'sent', 'bind', 'litna:pending', 'purchase', 'created'])
		expect(db.placed).toMatchObject({ company: 'c1', purchase: 'pu1', orderId: 501, orderKey: 'wc_order_K', expected: 3625, seen: 0, login: 'na@example.org', guest: false })
		expect(db.purchase.litna).toEqual({ orderId: 501, status: 'pending', shipping: 625, total: 3625, delivery: expect.any(Object), createdAt: expect.any(Number) })
		expect(JSON.stringify(db.purchase)).not.toContain('wc_order_K')
		expect(db.purchase.items).toEqual([
			{ product: P1, quantity: 2, price: 1000, confirmedQuantity: 0 },
			{ product: P2, quantity: 2, price: 500, confirmedQuantity: 0 },
		])
		expect(db.purchase.totalAmount).toBe(3000)
		expect(purchases.update).toHaveBeenCalledWith('pu1', { isCreated: true }, USER, true)
	})

	it('шаги заказа: видны по своей местности, пока он идёт, и сняты после', async () => {
		fakeSite()
		const { svc } = setup()
		const steps: Map<string, { step: string; at: number }> = (svc as any).steps
		const seen: string[] = []
		const set = steps.set.bind(steps)
		steps.set = (k, v) => {
			seen.push(`${v.at} ${v.step}`)
			set(k, v)
			expect(svc.step('pu1', USER)).toEqual(v)
			expect(svc.step('pu1', { ...USER, company: 'c2' })).toEqual({ step: null, at: 0 })
			return steps
		}
		await svc.order('pu1', 3625, USER)
		// номер шага назад не идёт: заказ без готового расчёта сначала считает (1–3), потом идёт по своим шагам (до 6)
		expect(seen).toEqual([
			'1 Открываем сайт',
			'2 Собираем корзину',
			'3 Считаем доставку',
			'3 Входим в аккаунт',
			'3 Готовим заказ',
			'3 Собираем корзину',
			'4 Вносим адрес',
			'5 Оформляем заказ',
			'6 Сверяем сумму',
		])
		expect(svc.step('pu1', USER)).toEqual({ step: null, at: 0 })
		// расчёт сам по себе тоже снимает шаг
		const again = setup()
		await again.svc.quote('pu1', USER)
		expect((again.svc as any).steps.size).toBe(0)
	})

	it('сайт отказал, заказа с нашим кодом нет (доказано) — намерение снято сразу', async () => {
		const site = fakeSite()
		site.checkoutMode = 'failure'
		const { svc, db } = setup()
		await expect(svc.order('pu1', 3625, USER)).rejects.toThrow('lit-na.ru: Нет в наличии')
		expect(db.placed).toBeNull()
		expect(db.purchase.litna).toBeUndefined()
		expect(db.writes).toEqual(['intent', 'litna:placing', 'sent', 'drop', 'unset'])
	})

	it.each(['lost', 'nokey', 'failure-created'])('ответ оформления %s: свой заказ находится по коду, чужой новый — нет; второй раз не оформляется', async (mode) => {
		const site = fakeSite()
		site.checkoutMode = mode
		site.foreignDuring = true
		// заказы до оформления — за границей, их страницы даже не открываются
		site.orders.set(400, { key: 'wc_order_OLD', status: 'pending', paid: false, total: 362500, note: '' })
		const { svc, db, purchases } = setup()
		await svc.order('pu1', 3625, USER)
		expect(checkouts(site)).toBe(1)
		expect(db.placed).toMatchObject({ orderId: 501, orderKey: 'wc_order_K', seen: 400 })
		expect(site.calls.some((c) => c.path === '/my-account/view-order/502/')).toBe(true)
		expect(site.calls.some((c) => c.path === '/my-account/view-order/400/')).toBe(false)
		expect(site.orders.get(502).status).toBe('pending')
		expect(purchases.update).toHaveBeenCalledWith('pu1', { isCreated: true }, USER, true)
	})

	it('ответ потерян, нашего заказа нет: свежее намерение — ждать без второго оформления; после выдержки — снимается', async () => {
		const site = fakeSite()
		site.checkoutMode = 'lost-empty'
		const { svc, db, purchases } = setup()
		await expect(svc.order('pu1', 3625, USER)).rejects.toThrow('ещё оформляется')
		expect(db.placed).toMatchObject({ expected: 3625 })
		expect(db.purchase.litna.status).toBe('placing')
		await expect(svc.order('pu1', 3625, USER)).rejects.toThrow('ещё оформляется')
		expect(checkouts(site)).toBe(1)
		db.placed.startedAt -= 4 * 60_000
		site.checkoutMode = 'ok'
		await svc.order('pu1', 3625, USER)
		expect(checkouts(site)).toBe(2)
		expect(purchases.update).toHaveBeenCalledWith('pu1', { isCreated: true }, USER, true)
	})

	it('неуверенность (список заказов или страница заказа не разобраны) — намерение остаётся даже старым', async () => {
		const intent = { _id: 'o1', purchase: 'pu1', code: 'K7Q2X9PM', login: 'na@example.org', seen: 0, expected: 3625, startedAt: Date.now() - 10 * 60_000, info: { status: 'placing' }, lines: [] }
		let site = fakeSite()
		site.ordersBroken = true
		let ctx = setup({ placed: intent, purchase: { litna: { status: 'placing' } } })
		await expect(ctx.svc.order('pu1', 3625, USER)).rejects.toThrow('проверьте заказы в кабинете')
		expect(ctx.db.placed).toMatchObject({ code: 'K7Q2X9PM' })
		expect(checkouts(site)).toBe(0)

		site = fakeSite()
		site.orders.set(600, { key: 'wc_order_Z', status: 'pending', paid: false, total: 100, note: '' })
		site.viewBroken = true
		ctx = setup({ placed: intent, purchase: { litna: { status: 'placing' } } })
		await expect(ctx.svc.order('pu1', 3625, USER)).rejects.toThrow('проверьте заказы в кабинете')
		expect(ctx.db.placed).not.toBeNull()
	})

	it('найденный по коду заказ уже оплачен — закупка «создана» и «оплачена»; уже отменён — снова черновик и новый расчёт', async () => {
		const intent = { _id: 'o1', purchase: 'pu1', code: 'K7Q2X9PM', login: 'na@example.org', seen: 0, expected: 3625, startedAt: Date.now() - 10 * 60_000, info: { status: 'placing' }, lines: [{ product: P1, quantity: 2, price: 1000 }] }
		let site = fakeSite()
		site.orders.set(501, { key: 'wc_order_K', status: 'processing', paid: true, total: 362500, note: 'K7Q2X9PM · Skladan · закупка №31' })
		let ctx = setup({ placed: intent, purchase: { litna: { status: 'placing' } } })
		await ctx.svc.order('pu1', 3625, USER)
		expect(ctx.db.placed).toMatchObject({ orderId: 501, orderKey: '' })
		expect(ctx.db.writes).toEqual(['bind', 'litna:processing', 'purchase', 'created', 'status:processing', 'paid'])
		// оплата видна в закупке: статус сайта и время отметки
		expect(ctx.db.purchase.litna).toMatchObject({ status: 'processing', paidAt: expect.any(Number) })
		// оплаченный — без сверки суммы со страницей оплаты
		expect(site.calls.some((c) => c.path.startsWith('/checkout/order-pay/'))).toBe(false)

		site = fakeSite()
		site.orders.set(501, { key: 'wc_order_K', status: 'cancelled', paid: false, total: 362500, note: 'K7Q2X9PM · Skladan · закупка №31' })
		ctx = setup({ placed: intent, purchase: { litna: { status: 'placing' } } })
		const err: any = await ctx.svc.order('pu1', 3625, USER).catch((e) => e)
		expect(err.status).toBe(409)
		expect(err.response).toMatchObject({ total: 3625, message: expect.stringContaining('отменён') })
		expect(ctx.db.placed.deletedAt).toBeInstanceOf(Date)
		expect(ctx.db.purchase.litna).toBeUndefined()
	})

	it('сумма к оплате на сайте не совпала с расчётом — заказ отменён (проверено статусом), 409 с расчётом и текстом', async () => {
		const site = fakeSite()
		site.outSum = '3700.00'
		const { svc, db, purchases } = setup()
		const err: any = await svc.order('pu1', 3625, USER).catch((e) => e)
		expect(err.status).toBe(409)
		expect(err.response).toMatchObject({ total: 3625, message: expect.stringContaining('3700') })
		expect(site.orders.get(501).status).toBe('cancelled')
		expect(db.placed.deletedAt).toBeInstanceOf(Date)
		expect(db.purchase.litna).toBeUndefined()
		expect(purchases.update).not.toHaveBeenCalled()
	})

	it('сумма не совпала, а отмена не прошла — 400 с номером заказа, запись остаётся', async () => {
		const site = fakeSite()
		site.outSum = '3700.00'
		site.cancelWorks = false
		const { svc, db } = setup()
		await expect(svc.order('pu1', 3625, USER)).rejects.toThrow('отменить заказ №501 не удалось')
		expect(db.placed).toMatchObject({ orderId: 501 })
	})

	it('цены на сайте сменились между расчётом и корзиной аккаунта — 409 со свежим пересчётом', async () => {
		const site = fakeSite()
		site.bump = true
		const { svc, db } = setup()
		const err: any = await svc.order('pu1', 3625, USER).catch((e) => e)
		expect(err.status).toBe(409)
		expect(err.response).toMatchObject({ goods: 3200, total: 3825 })
		expect(checkouts(site)).toBe(0)
		expect(db.placed).toBeNull()
	})

	it('пункт не принят сайтом — отказ до отправки формы, намерение снято', async () => {
		let site = fakeSite()
		site.cdekOk = false
		let ctx = setup()
		await expect(ctx.svc.order('pu1', 3625, USER)).rejects.toThrow('не принял пункт CDEK')
		expect(checkouts(site)).toBe(0)
		expect(ctx.db.placed).toBeNull()

		site = fakeSite()
		site.bxbOk = false
		ctx = setup({ account: { delivery: { kind: 'yandex_pvz', code: 'y1', title: 'Саратов (410000, Саратов, ул. Первая)', city: 'Саратов' } } })
		await expect(ctx.svc.order('pu1', 3344.59, USER)).rejects.toThrow('не принял пункт Яндекс')
		expect(checkouts(site)).toBe(0)
	})

	it('пункт Яндекса — выбором через admin-ajax (успех — по кукам); при бесплатной доставке пункт только в адресе', async () => {
		let site = fakeSite()
		await setup({ account: { delivery: { kind: 'yandex_pvz', code: 'y1', title: 'Саратов (410000, Саратов, ул. Первая)', city: 'Саратов' } } }).svc.order('pu1', 3344.59, USER)
		const chosen = new URLSearchParams(site.calls.find((c) => c.body.includes('boxberry_update')).body)
		expect(Object.fromEntries(chosen)).toEqual({ action: 'boxberry_update', method: 'boxberry_self', code: 'y1', address: 'Саратов (410000, Саратов, ул. Первая)' })
		expect(site.checkout.get('shipping_method[0]')).toBe('boxberry_self:11')

		site = fakeSite()
		await setup({ purchase: { items: [{ product: P1, quantity: 15 }] } }).svc.order('pu1', 15000, USER)
		expect(site.checkout.get('shipping_method[0]')).toBe('free_shipping:10')
		expect(site.checkout.get('office_code')).toBeNull()
		expect(site.checkout.get('billing_address_1')).toBe('ПВЗ CDEK: SAR6, Саратов, ул. Тестовая')
		expect(site.calls.some((c) => c.path.includes('save-office'))).toBe(false)
	})

	it('повтор после сбоя: заказ на сайте уже привязан — сверка суммы и «создана» без нового оформления; сумма — до копеек', async () => {
		const site = fakeSite()
		site.orders.set(501, { key: 'wc_order_K', status: 'pending', paid: false, total: 30 })
		const placed = { _id: 'o1', purchase: 'pu1', orderId: 501, orderKey: 'wc_order_K', login: 'na@example.org', expected: 0.3, startedAt: Date.now(), info: { orderId: 501, status: 'pending' }, lines: [{ product: P1, quantity: 3, price: 0.1 }] }
		const { svc, db, purchases } = setup({ placed })
		await svc.order('pu1', 1, USER)
		expect(checkouts(site)).toBe(0)
		expect(db.purchase.items).toEqual([{ product: P1, quantity: 3, price: 0.1, confirmedQuantity: 0 }])
		// 3 × 0.1 в плавающей точке — 0.30000000000000004
		expect(db.purchase.totalAmount).toBe(0.3)
		expect(purchases.update).toHaveBeenCalledWith('pu1', { isCreated: true }, USER, true)
	})

	it('по местности — одно оформление или удаление за раз', async () => {
		fakeSite()
		const { svc } = setup()
		const first = svc.order('pu1', 3625, USER)
		await expect(svc.order('pu1', 3625, USER)).rejects.toThrow('ещё оформляется')
		await expect(svc.remove('pu1', USER)).rejects.toThrow('ещё оформляется')
		await first
	})

	it('сохранённый вход перестал работать — 400 «зайдите заново», «вход сломан» в аккаунте, намерения нет, на сайт ничего не ушло', async () => {
		const site = fakeSite()
		const { svc, db } = setup({ account: { password: seal('другой', SECRET) } })
		const err: any = await svc.order('pu1', 3625, USER).catch((e) => e)
		expect(err.status).toBe(400)
		// машинный признак — клиент отличает отказ входа от прочих 400
		expect(err.response).toEqual({ code: 'LOGIN_FAILED', message: 'Не удалось войти на lit-na.ru — зайдите заново' })
		expect(db.placed).toBeNull()
		expect(db.purchase.litna).toBeUndefined()
		expect(await svc.account()).toMatchObject({ login: 'na@example.org', loginFailed: true })
		// расчёт идёт в гостевой корзине; от имени аккаунта — ни корзины, ни оформления
		expect(checkouts(site)).toBe(0)
		expect(site.calls.some((c) => c.who === 'account')).toBe(false)
	})
})

describe('оплата, проверка, удаление', () => {
	const placed = { _id: 'o1', purchase: 'pu1', orderId: 501, orderKey: 'wc_order_K', login: 'na@example.org', expected: 3625, startedAt: Date.now(), info: { orderId: 501, status: 'pending', total: 3625 }, lines: [{ product: P1, quantity: 2, price: 1000 }] }
	const created = { isCreated: true, litna: { orderId: 501, status: 'pending', total: 3625 } }
	const withOrder = (over: Partial<SiteOrder> = {}) => {
		const site = fakeSite()
		site.orders.set(501, { key: 'wc_order_K', status: 'pending', paid: false, total: 362500, ...over })
		return site
	}

	it('оплата: форма Robokassa сразу со страницы оплаты, способ на сайте не меняется; сумма сверена, плательщик запомнен; вход — один, даже для двух сразу', async () => {
		const site = withOrder()
		const { svc, db } = setup({ placed, purchase: created })
		const [form] = await Promise.all([svc.pay('pu1', USER), svc.pay('pu1', USER)])
		expect(form).toEqual({ action: 'https://auth.robokassa.ru/Merchant/Index.aspx', fields: { InvId: '501', OutSum: '3625.00' } })
		expect(site.calls.some((c) => c.path.includes('pay_for_order') || (c.method === 'POST' && c.path.startsWith('/checkout/order-pay/')))).toBe(false)
		expect(db.placed.payer).toBe('u1')
		// одна выдача формы: статус и страница с формой
		const before = site.calls.length
		await svc.pay('pu1', USER)
		expect(site.calls.slice(before).map((c) => `${c.method} ${c.path}`)).toEqual(['POST /wp-admin/admin-ajax.php', 'GET /checkout/order-pay/501/?key=wc_order_K'])
		expect(site.calls.filter((c) => c.path === '/my-account/' && c.method === 'POST')).toHaveLength(1)
	})

	it('форма оплаты другого заказа — 502, формы нет; при доведении черновика заказ не отменяется', async () => {
		const site = withOrder()
		site.invId = '777'
		const err: any = await setup({ placed, purchase: created }).svc.pay('pu1', USER).catch((e) => e)
		expect([err.status, err.message]).toEqual([502, 'Форма оплаты сайта не соответствует заказу'])
		const draft = setup({ placed })
		await expect(draft.svc.order('pu1', 3625, USER)).rejects.toThrow('Форма оплаты сайта не соответствует заказу')
		expect(site.calls.some((c) => c.path.includes('cancel_order'))).toBe(false)
		expect(draft.db.purchase.isCreated).toBe(false)
		expect(draft.db.placed).not.toBeNull()
	})

	it('оплата: сумма на сайте другая — 409 с обеими суммами; уже оплачен — отметка; failed — оплачивается заново', async () => {
		let site = withOrder()
		site.outSum = '3700.00'
		const err: any = await setup({ placed, purchase: created }).svc.pay('pu1', USER).catch((e) => e)
		expect(err.status).toBe(409)
		expect(err.response).toMatchObject({ site: 3700, expected: 3625 })

		withOrder({ paid: true, status: 'processing' })
		const paid = setup({ placed: { ...placed, payer: 'payer' }, purchase: created })
		expect(await paid.svc.pay('pu1', USER)).toMatchObject({ paid: true })
		expect(paid.purchases.update).toHaveBeenCalledWith('pu1', { isPaid: true }, { _id: 'payer', name: 'Платил' }, true)

		site = withOrder({ status: 'failed' })
		expect(await setup({ placed, purchase: created }).svc.pay('pu1', USER)).toHaveProperty('action')
	})

	it('оплата: заказ отменён, а форму оплаты выдавали недавно — закупку не трогаем: статус записан, 400; у черновика — снова черновик', async () => {
		let site = withOrder({ status: 'cancelled' })
		let ctx = setup({ placed: { ...placed, payAt: Date.now() - 5 * 60_000 }, purchase: created })
		await expect(ctx.svc.pay('pu1', USER)).rejects.toThrow('отменён на сайте')
		expect(ctx.db.purchase.litna.status).toBe('cancelled')
		expect(ctx.purchases.toDraft).not.toHaveBeenCalled()
		expect(site.calls.some((c) => c.method === 'POST' && c.path.startsWith('/checkout/order-pay/'))).toBe(false)

		site = withOrder({ status: 'cancelled' })
		ctx = setup({ placed, purchase: { isCreated: false, litna: { orderId: 501, status: 'pending' } } })
		await expect(ctx.svc.pay('pu1', USER)).rejects.toThrow('отменён на сайте')
		expect(ctx.db.placed.deletedAt).toBeInstanceOf(Date)
		expect(ctx.db.purchase.litna).toBeUndefined()
	})

	it('оплата черновика с заказом (оформление прервалось после ответа сайта) — сначала закупка «создана»', async () => {
		withOrder()
		const { svc, db } = setup({ placed, purchase: { isCreated: false, litna: { orderId: 501, status: 'pending', total: 3625 } } })
		expect(await svc.pay('pu1', USER)).toHaveProperty('action')
		expect(db.writes.slice(0, 2)).toEqual(['purchase', 'created'])
	})

	it('проверка: не оплачен — только статус; оплачен — закупка оплачивается от имени плательщика; без входа', async () => {
		const site = withOrder()
		const { svc, purchases } = setup({ placed: { ...placed, payer: 'payer' }, purchase: created })
		expect(await svc.check('pu1', USER)).toMatchObject({ paid: false, status: 'pending' })
		expect(purchases.update).not.toHaveBeenCalled()
		site.orders.get(501).paid = true
		site.orders.get(501).status = 'processing'
		// ответ сайта держится 5 секунд: повторная проверка сразу на сайт не идёт
		const asked = site.calls.length
		expect(await svc.check('pu1', USER)).toMatchObject({ paid: false })
		expect(site.calls.length).toBe(asked)
		;(svc as any).statusMemo.get('o1').at -= 6_000
		expect(await svc.check('pu1', USER)).toMatchObject({ paid: true, status: 'processing' })
		expect(purchases.update).toHaveBeenCalledWith('pu1', { isPaid: true }, { _id: 'payer', name: 'Платил' }, true)
		expect(site.calls.every((c) => c.who === 'guest')).toBe(true)
	})

	it('фоновая проверка: оплатили прямо на сайте — закупка отмечается оплаченной без открытия приложения; очередь по кругу; сбой сайта не роняет', async () => {
		const site = withOrder()
		const { svc, purchases, db } = setup({ placed: { ...placed, company: 'c1' }, purchase: { ...created, user: 'u7' } })
		const asked: any = {}
		const list = (rows: any[], key: string) => (f: any) => {
			asked[key] = f
			const o: any = { setOptions: () => o, select: () => o, sort: () => o, limit: () => o, lean: () => o, exec: async () => rows }
			return o
		}
		;(svc as any).purchaseModel.find = list([{ _id: 'pu1', user: 'u7', company: 'c1' }], 'purchases')
		;(svc as any).orderModel.find = list([db.placed], 'orders')
		;(svc as any).orderModel.updateMany = (f: any, u: any) => ({ setOptions: () => ({ exec: async () => (asked.turn = [f, u]) }) })
		await svc.pendingCheck()
		expect(asked.purchases).toMatchObject({ isCreated: true, isPaid: { $ne: true }, 'litna.orderId': { $type: 'number' }, deletedAt: null })
		expect(asked.orders).toMatchObject({ purchase: { $in: ['pu1'] }, deletedAt: null })
		expect(asked.turn).toEqual([{ _id: { $in: ['o1'] } }, { lateAt: expect.any(Number) }])
		expect(purchases.update).not.toHaveBeenCalled()
		// оплатили на сайте
		site.orders.get(501).paid = true
		site.orders.get(501).status = 'processing'
		;(svc as any).statusMemo.clear()
		await svc.pendingCheck()
		expect(purchases.update).toHaveBeenCalledWith('pu1', { isPaid: true }, expect.anything(), true)
		// закупку прямо сейчас отвязывают — фон не вмешивается; сайт не отвечает — без ошибки
		purchases.update.mockClear()
		;(svc as any).statusMemo.clear()
		;(svc as any).closing.add('pu1')
		await svc.pendingCheck()
		expect(purchases.update).not.toHaveBeenCalled()
		;(svc as any).closing.clear()
		;(svc as any).statusMemo.clear()
		;(svc as any).siteStatus = async () => {
			throw new Error('нет связи')
		}
		await expect(svc.pendingCheck()).resolves.toBeUndefined()
		expect(purchases.update).not.toHaveBeenCalled()
	})

	it('после оплаты: заказ отправлен («Доставка») — статус в закупке, история и push один раз; отменён после оплаты — в историю; «в обработке» — тишина', async () => {
		const site = withOrder({ paid: true, status: 'processing' })
		const { svc, db } = setup({ placed: { ...placed, company: 'c1' }, purchase: { ...created, isPaid: true, litna: { orderId: 501, status: 'processing', total: 3625 } } })
		const asked: any = {}
		const list = (rows: any[], key: string) => (f: any) => {
			asked[key] = f
			const o: any = { setOptions: () => o, select: () => o, sort: () => o, limit: () => o, lean: () => o, exec: async () => rows }
			return o
		}
		const row = { _id: 'pu1', company: 'c1', purchaseNumber: 31, litna: { status: 'processing' } }
		;(svc as any).purchaseModel.find = list([row], 'purchases')
		;(svc as any).orderModel.find = list([db.placed], 'orders')
		;(svc as any).orderModel.updateMany = () => ({ setOptions: () => ({ exec: async () => ({}) }) })
		const writes: any[] = []
		let stored = 'processing'
		;(svc as any).purchaseModel.updateOne = (f: any, u: any) => ({ exec: async () => (stored === u['litna.status'] ? { modifiedCount: 0 } : (writes.push(u), (stored = u['litna.status']), { modifiedCount: 1 })) })
		await svc.shippedCheck()
		expect(asked.purchases).toMatchObject({ isCreated: true, isPaid: true, isCompleted: { $ne: true }, 'litna.status': { $nin: expect.arrayContaining(['delivery', 'cancelled']) } })
		expect(writes).toEqual([])
		expect(db.history).toEqual([])
		// магазин отправил заказ
		site.orders.get(501).status = 'delivery'
		await svc.shippedCheck()
		expect(writes).toEqual([{ 'litna.status': 'delivery', 'litna.shippedAt': expect.any(Number) }])
		expect(db.history).toEqual([expect.objectContaining({ company: 'c1', changeType: 'litna-shipped', description: 'Заказ №501 на lit-na.ru отправлен — закупка №31' })])
		expect(db.history[0].opts).toBeUndefined()
		// повтор (список ещё со старым статусом): запись условная — второй раз в историю не пишем
		await svc.shippedCheck()
		expect(db.history).toHaveLength(1)
		// заказ отменили после оплаты
		site.orders.get(501).status = 'cancelled'
		site.orders.get(501).paid = false
		await svc.shippedCheck()
		expect(writes.at(-1)).toEqual({ 'litna.status': 'cancelled', 'litna.cancelledAt': expect.any(Number) })
		expect(db.history.at(-1)).toMatchObject({ changeType: 'litna-cancelled-after-paid', description: 'Заказ №501 на lit-na.ru отменён после оплаты — проверьте закупку №31' })
		// сайт не отвечает — без ошибки и без записей
		;(svc as any).siteStatus = async () => {
			throw new Error('нет связи')
		}
		await expect(svc.shippedCheck()).resolves.toBeUndefined()
		expect(db.history).toHaveLength(2)
	})

	it('заказ без ключа (оформлен на самом сайте): статус — из списка заказов кабинета; гостевой без ключа и заказ, которого в списке нет, не трогаются', async () => {
		const site = withOrder({ paid: true, status: 'processing' })
		const keyless = { ...placed, company: 'c1', orderKey: '', info: { orderId: 501, status: 'processing', total: 3625 } }
		const { svc, db } = setup({ placed: keyless, purchase: { ...created, isPaid: true, litna: { orderId: 501, status: 'processing', total: 3625 } } })
		const asked: any = {}
		const list = (rows: () => any[], key: string) => (f: any) => {
			asked[key] = f
			const o: any = { setOptions: () => o, select: () => o, sort: () => o, limit: () => o, lean: () => o, exec: async () => rows() }
			return o
		}
		;(svc as any).purchaseModel.find = list(() => [{ _id: 'pu1', company: 'c1', purchaseNumber: 32, litna: { status: 'processing' } }], 'purchases')
		;(svc as any).orderModel.find = list(() => [db.placed], 'orders')
		;(svc as any).orderModel.updateMany = () => ({ setOptions: () => ({ exec: async () => ({}) }) })
		const writes: any[] = []
		;(svc as any).purchaseModel.updateOne = (_f: any, u: any) => ({ exec: async () => (writes.push(u), { modifiedCount: 1 }) })
		const statusAsked = () => site.calls.filter((c) => c.path === '/wp-admin/admin-ajax.php').length
		await svc.shippedCheck()
		expect(asked.orders.$or).toEqual([{ orderKey: { $nin: [null, ''] } }, { guest: { $ne: true } }])
		expect(writes).toEqual([])
		// магазин отправил заказ: ключа нет — по ключу не спрашиваем, читаем список
		site.orders.get(501).status = 'delivery'
		await svc.shippedCheck()
		expect(statusAsked()).toBe(0)
		expect(writes).toEqual([{ 'litna.status': 'delivery', 'litna.shippedAt': expect.any(Number) }])
		expect(db.placed.info.status).toBe('delivery')
		expect(db.history).toEqual([expect.objectContaining({ changeType: 'litna-shipped', description: 'Заказ №501 на lit-na.ru отправлен — закупка №32' })])
		// в этой сессии сайта сейчас оформляют заказ — не мешаем
		site.orders.get(501).status = 'cancelled'
		;(svc as any).ordering.add('c1')
		await svc.shippedCheck()
		expect(writes).toHaveLength(1)
		;(svc as any).ordering.clear()
		// сохранённый вход не работает — на сайт не ходим; список не разобран — без записей и без ошибки наружу
		const calls = site.calls.length
		db.account.loginFailed = true
		await svc.shippedCheck()
		expect(site.calls.length).toBe(calls)
		db.account.loginFailed = false
		site.ordersBroken = true
		await expect(svc.shippedCheck()).resolves.toBeUndefined()
		expect(site.calls.length).toBeGreaterThan(calls)
		expect(writes).toHaveLength(1)
		site.ordersBroken = false
		// заказа нет на первой странице списка; гостевой без ключа — спросить не у кого
		site.orders.clear()
		site.orders.set(777, { key: 'wc_order_X', status: 'cancelled', paid: false, total: 100 })
		await svc.shippedCheck()
		db.placed.guest = true
		site.orders.set(501, { key: 'wc_order_K', status: 'cancelled', paid: false, total: 100 })
		await svc.shippedCheck()
		expect(writes).toHaveLength(1)
		expect(db.history).toHaveLength(1)
	})

	it('проверка черновика с заказом: оплачен — «создана» и «оплачена»; отменён — снова черновик', async () => {
		withOrder({ paid: true, status: 'completed' })
		let ctx = setup({ placed, purchase: { isCreated: false, litna: { orderId: 501, status: 'pending' } } })
		expect(await ctx.svc.check('pu1', USER)).toMatchObject({ paid: true, status: 'completed' })
		expect(ctx.db.writes).toEqual(['purchase', 'created', 'status:completed', 'paid'])

		withOrder({ status: 'cancelled' })
		ctx = setup({ placed, purchase: { isCreated: false, litna: { orderId: 501, status: 'pending' } } })
		expect(await ctx.svc.check('pu1', USER)).toMatchObject({ paid: false, status: 'cancelled' })
		expect(ctx.db.placed.deletedAt).toBeInstanceOf(Date)
		expect(ctx.db.purchase.litna).toBeUndefined()
	})

	it('проверка: гостю сайт статус не дал — через сессию; отмену магазином пишет в закупку', async () => {
		const site = withOrder({ status: 'cancelled' })
		site.guestStatus = false
		const { svc, db } = setup({ placed: { ...placed, payAt: Date.now() - 5 * 60_000 }, purchase: created })
		expect(await svc.check('pu1', USER)).toMatchObject({ paid: false, status: 'cancelled' })
		expect(db.purchase.litna.status).toBe('cancelled')
		expect(site.calls.some((c) => c.who === 'account')).toBe(true)
	})

	it('удаление неоплаченной: отмена ссылкой из кабинета, статус переспрошен, затем удаление закупки и записи', async () => {
		const site = withOrder()
		const { svc, db, purchases } = setup({ placed, purchase: created })
		await svc.remove('pu1', USER)
		expect(site.orders.get(501).status).toBe('cancelled')
		expect(purchases.remove).toHaveBeenCalledWith('pu1', USER, true)
		// запись не стёрта — помечена: след заказа на сайте остаётся
		expect(db.placed).toMatchObject({ orderId: 501, deletedBy: 'u1', deletedAt: expect.any(Date) })
	})

	it('удаление: ссылка открыта, а заказ не отменился — 400 с номером, запись и закупка остаются', async () => {
		const site = withOrder()
		site.cancelWorks = false
		const { svc, db, purchases } = setup({ placed, purchase: created })
		await expect(svc.remove('pu1', USER)).rejects.toThrow('Не удалось отменить заказ №501')
		expect(purchases.remove).not.toHaveBeenCalled()
		expect(db.placed).not.toBeNull()
	})

	it('удаление: заказ уже оплачен на сайте — отказ, закупка остаётся', async () => {
		withOrder({ paid: true, status: 'processing' })
		const { svc, purchases } = setup({ placed, purchase: created })
		await expect(svc.remove('pu1', USER)).rejects.toThrow('уже оплачен')
		expect(purchases.remove).not.toHaveBeenCalled()
	})

	it('удаление во время оформления: свой заказ по коду — отменяется; доказано, что его нет, — после выдержки удаляется', async () => {
		const intent = { _id: 'o1', purchase: 'pu1', code: 'K7Q2X9PM', login: 'na@example.org', seen: 0, expected: 3625, startedAt: Date.now(), info: { status: 'placing' }, lines: [] }
		let site = fakeSite()
		const fresh = setup({ placed: intent, purchase: { litna: { status: 'placing' } } })
		await expect(fresh.svc.remove('pu1', USER)).rejects.toThrow('ещё оформляется')
		expect(fresh.purchases.remove).not.toHaveBeenCalled()

		const old = setup({ placed: { ...intent, startedAt: Date.now() - 10 * 60_000 }, purchase: { litna: { status: 'placing' } } })
		await old.svc.remove('pu1', USER)
		expect(old.db.writes).toEqual(['drop', 'unset', 'removed'])

		site = fakeSite()
		site.orders.set(501, { key: 'wc_order_K', status: 'pending', paid: false, total: 362500, note: 'K7Q2X9PM · Skladan · закупка №31' })
		const ours = setup({ placed: intent, purchase: { litna: { status: 'placing' } } })
		await ours.svc.remove('pu1', USER)
		expect(site.orders.get(501).status).toBe('cancelled')
		expect(ours.purchases.remove).toHaveBeenCalledWith('pu1', USER, true)
	})
})

describe('пункты выдачи', () => {
	it('CDEK — из гостевой корзины города: токен и один пакет (товар с городом), корзину не чистим', async () => {
		const site = fakeSite()
		expect(await setup().svc.points('cdek', 'Саратов')).toEqual([{ code: 'SAR6', name: 'SAR6, Саратов, ул. Тестовая', address: 'Россия, Саратов, ул. Тестовая, 1', hours: 'Пн-Пт', city: 'Саратов', postcode: '' }])
		expect(site.calls.filter((c) => !c.path.includes('/products')).map((c) => `${c.method} ${c.path}`)).toEqual(['GET /wp-json/wc/store/v1/cart', 'POST /wp-json/wc/store/v1/batch'])
		// к сайту — один только город
		const requests = JSON.parse(site.calls.find((c) => c.path.endsWith('/batch')).body).requests
		expect(requests[1].body.shipping_address).toEqual({ country: 'RU', city: 'Саратов' })
	})

	it('Яндекс — токен с сайта, одна загрузка на всех ждущих, в памяти; клиенту — только город', async () => {
		const site = fakeSite()
		const { svc } = setup()
		const [saratov, kazan] = await Promise.all([svc.points('yandex', 'саратов'), svc.points('yandex', 'Казань')])
		expect(saratov).toEqual([{ code: 'y1', name: 'Саратов (410000, Саратов, ул. Первая)', address: '410000, Саратов, ул. Первая', hours: 'пн-вс', city: 'Саратов', postcode: '410000' }])
		expect(kazan).toHaveLength(1)
		// проба — на сумму, с которой сайт пускает к оформлению (виджет открывается там)
		expect(JSON.parse(site.calls.find((c) => c.path.endsWith('/batch')).body).requests[0].body).toEqual({ id: 11, quantity: 5 })
		const asked = site.calls.filter((c) => c.url.startsWith('https://points.boxberry.ru/'))
		expect(asked).toHaveLength(1)
		const body = new URLSearchParams(asked[0].body)
		expect([body.get('getListPoints'), body.get('input_parameters[api_token]'), body.get('input_parameters[target_start]'), body.get('input_parameters[host]')]).toEqual(['0', '1$tok', 'ts', 'lit-na.ru'])
		expect(asked[0].headers).toMatchObject({ 'X-Requested-With': 'XMLHttpRequest', Origin: 'https://points.boxberry.ru' })
		expect(asked[0].headers.Cookie).toBeUndefined()
		const before = site.calls.length
		expect(await svc.points('yandex', 'Энгельс')).toEqual([])
		expect(site.calls.length).toBe(before)
	})
})

describe('сессия сайта', () => {
	it('переадресация на чужой адрес — 502, туда запрос не уходит', async () => {
		global.fetch = jest.fn(async () => new Response('', { status: 302, headers: [['Location', 'https://evil.example/steal']] })) as any
		await expect(new LitnaSession().request('/checkout/')).rejects.toThrow('не отвечает')
		expect((global.fetch as jest.Mock).mock.calls.map((c) => String(c[0]))).toEqual(['https://lit-na.ru/checkout/'])
	})

	it('ответ больше предела — 502', async () => {
		global.fetch = jest.fn(async () => new Response('x'.repeat(2000))) as any
		await expect(new LitnaSession().request('/', { limit: 1000 })).rejects.toThrow('не отвечает')
		expect((await new LitnaSession().request('/', { limit: 5000 })).text).toHaveLength(2000)
	})

	it('сбой запроса — в журнал предупреждением, адрес без параметров', async () => {
		global.fetch = jest.fn(async () => {
			throw new TypeError('fetch failed')
		}) as any
		await expect(new LitnaSession().request('/checkout/order-pay/501/?key=wc_order_SECRET#x')).rejects.toThrow('не отвечает')
		expect(warn).toHaveBeenCalledWith('Запрос к https://lit-na.ru/checkout/order-pay/501/ не удался: fetch failed')
		expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET')
	})
})

describe('третий круг: поздняя оплата, доказательство отсутствия, ручное снятие', () => {
	const placed = { _id: 'o1', purchase: 'pu1', orderId: 501, orderKey: 'wc_order_K', login: 'na@example.org', expected: 3625, startedAt: Date.now(), info: { orderId: 501, status: 'pending', total: 3625 }, lines: [{ product: P1, quantity: 2, price: 1000 }] }
	const created = { isCreated: true, litna: { orderId: 501, status: 'pending', total: 3625 } }
	const intent = { _id: 'o1', purchase: 'pu1', code: 'K7Q2X9PM', login: 'na@example.org', expected: 3625, startedAt: Date.now() - 10 * 60_000, info: { status: 'placing' }, lines: [] }
	const withOrders = (orders: [number, Partial<SiteOrder>][] = []) => {
		const site = fakeSite()
		for (const [id, o] of orders) site.orders.set(id, { key: `wc_order_${id}`, status: 'pending', paid: false, total: 100, note: '', ...o })
		return site
	}

	it('форма оплаты выдана — 30 минут удалить нельзя (оплата могла начаться), потом можно', async () => {
		withOrders([[501, { key: 'wc_order_K', total: 362500 }]])
		const { svc, db, purchases } = setup({ placed, purchase: created })
		await svc.pay('pu1', USER)
		expect(db.placed.payAt).toEqual(expect.any(Number))
		await expect(svc.remove('pu1', USER)).rejects.toThrow('Оплата могла начаться — удалить можно через 30 мин')
		expect(purchases.remove).not.toHaveBeenCalled()
		db.placed.payAt -= 31 * 60_000
		await svc.remove('pu1', USER)
		expect(purchases.remove).toHaveBeenCalled()
	})

	it('отмена на сайте не окончательна: «отменённый» заказ оплатили — проверка отмечает оплату и статус', async () => {
		withOrders([[501, { key: 'wc_order_K', status: 'processing', paid: true, total: 362500 }]])
		const { svc, db, purchases } = setup({ placed, purchase: { ...created, litna: { ...created.litna, status: 'cancelled' } } })
		expect(await svc.check('pu1', USER)).toMatchObject({ paid: true, status: 'processing' })
		expect(db.purchase.litna.status).toBe('processing')
		expect(purchases.update).toHaveBeenCalledWith('pu1', { isPaid: true }, USER, true)
	})

	it('доказательство отсутствия — только когда видны все заказы новее границы', async () => {
		// граница 500, а на странице только более новые — дальше могут быть ещё: неуверенность
		withOrders([[503, {}], [502, {}], [501, {}]])
		await expect(setup({ placed: { ...intent, seen: 500 }, purchase: { litna: { status: 'placing' } } }).svc.order('pu1', 3625, USER)).rejects.toThrow('проверьте заказы в кабинете')
		// граница 500 и пустой список — неуверенность
		withOrders()
		await expect(setup({ placed: { ...intent, seen: 500 }, purchase: { litna: { status: 'placing' } } }).svc.remove('pu1', USER)).rejects.toThrow('проверьте заказы в кабинете')
		// граница 0: десять строк или ссылка на следующую страницу — неуверенность
		withOrders(Array.from({ length: 10 }, (_, i) => [600 + i, {}] as [number, Partial<SiteOrder>]))
		await expect(setup({ placed: { ...intent, seen: 0 }, purchase: { litna: { status: 'placing' } } }).svc.remove('pu1', USER)).rejects.toThrow('проверьте заказы в кабинете')
		const more = withOrders([[600, {}]])
		more.morePages = true
		await expect(setup({ placed: { ...intent, seen: 0 }, purchase: { litna: { status: 'placing' } } }).svc.remove('pu1', USER)).rejects.toThrow('проверьте заказы в кабинете')
		// граница 500 и на странице есть заказ не новее неё — доказано
		withOrders([[502, {}], [500, {}]])
		const ok = setup({ placed: { ...intent, seen: 500 }, purchase: { litna: { status: 'placing' } } })
		await ok.svc.remove('pu1', USER)
		expect(ok.db.writes).toEqual(['drop', 'unset', 'removed'])
	})

	it('аккаунт сайта сменился после начала оформления — неуверенность, а не «заказа нет»', async () => {
		withOrders()
		const ctx = setup({ placed: { ...intent, seen: 0, login: 'other@example.org' }, purchase: { litna: { status: 'placing' } } })
		await expect(ctx.svc.remove('pu1', USER)).rejects.toThrow('проверьте заказы в кабинете')
		expect(ctx.db.placed).not.toBeNull()
	})

	it('в форме оформления нет поля примечания — оформление останавливается до отправки, намерение снято', async () => {
		const site = fakeSite()
		site.noComments = true
		const { svc, db } = setup()
		await expect(svc.order('pu1', 3625, USER)).rejects.toThrow('нет поля примечания')
		expect(checkouts(site)).toBe(0)
		expect(db.placed).toBeNull()
		expect(db.purchase.litna).toBeUndefined()
	})

	it('ручное снятие: только старое намерение без номера; закупка — обычный черновик, запись в историю', async () => {
		fakeSite()
		await expect(setup({ placed: { ...intent, startedAt: Date.now() }, purchase: { litna: { status: 'placing' } } }).svc.release('pu1', USER)).rejects.toThrow('снять можно через 3 мин')
		await expect(setup({ placed, purchase: created }).svc.release('pu1', USER)).rejects.toThrow('Заказ №501 на lit-na.ru уже оформлен')
		await expect(setup().svc.release('pu1', USER)).rejects.toThrow('не найдено')
		const ctx = setup({ placed: intent, purchase: { litna: { status: 'placing' } } })
		const res: any = await ctx.svc.release('pu1', USER)
		expect(res.released).toBe(true)
		expect(res.purchase.litna).toBeUndefined()
		expect(ctx.db.placed).toBeNull()
		expect(ctx.db.history).toEqual([expect.objectContaining({ user: 'u1', changeType: 'litna-released', description: 'Оформление на lit-na.ru снято вручную (закупка 31)' })])
	})

	it('черновик с заказом проверка и оплата доводят только под замком местности; повторно «создана» не ставится', async () => {
		withOrders([[501, { key: 'wc_order_K', total: 362500 }]])
		const draft = { isCreated: false, litna: { orderId: 501, status: 'pending', total: 3625 } }
		const busy = setup({ placed, purchase: draft })
		const ordering = busy.svc.order('pu1', 3625, USER).catch(() => null)
		await expect(busy.svc.check('pu1', USER)).rejects.toThrow('ещё оформляется')
		await ordering
		// закупку уже довели: строки и «создана» второй раз не пишутся
		const done = setup({ placed, purchase: draft })
		await done.svc.check('pu1', USER)
		done.db.purchase.isCreated = true
		await done.svc.pay('pu1', USER)
		expect(done.db.writes.filter((w) => w === 'created')).toHaveLength(1)
	})

	it('отменённый заказ черновика — запись помечается удалённой (след остаётся), litna снимается', async () => {
		withOrders([[501, { key: 'wc_order_K', status: 'cancelled', total: 362500 }]])
		const intentToBound = { ...placed }
		const { svc, db } = setup({ placed: intentToBound, purchase: { isCreated: false, litna: { orderId: 501, status: 'pending' } } })
		await svc.check('pu1', USER)
		expect(db.purchase.litna).toBeUndefined()
		expect(db.placed.deletedAt).toBeInstanceOf(Date)
	})

	it('один заказ сайта — у одной закупки: уникальность только у живых записей', () => {
		const indexes = buildSchema(LitnaOrder).indexes()
		expect(indexes).toEqual(
			expect.arrayContaining([
				[{ purchase: 1 }, expect.objectContaining({ unique: true, partialFilterExpression: { deletedAt: { $type: 'null' } } })],
				[{ company: 1, orderId: 1 }, expect.objectContaining({ unique: true, partialFilterExpression: { orderId: { $type: 'number' }, deletedAt: { $type: 'null' } } })],
			])
		)
	})

	it('все маршруты /litna — только внутри местности', () => {
		const ctrl = new LitnaController({} as any)
		const nobody: any = { _id: 's1', company: null, isSuperAdmin: true, isAdmin: true, role: { permissions: ['create_purchases', 'approve-payment', 'view_purchases', 'delete_purchases'] } }
		const calls = [
			() => ctrl.quote(P1, nobody),
			() => ctrl.order(P1, { total: 1 }, nobody),
			() => ctrl.pay(P1, { method: 'robokassa' }, nobody),
			() => ctrl.check(P1, nobody),
			() => ctrl.remove(P1, nobody),
			() => ctrl.release(P1, nobody),
			() => ctrl.account(nobody),
			() => ctrl.catalog(nobody),
		]
		for (const call of calls) expect(call).toThrow('только внутри местности')
	})
})

describe('документы заказа: счёт и накладная', () => {
	const placed = { _id: 'o1', purchase: 'pu1', orderId: 501, orderKey: 'wc_order_K', login: 'na@example.org', expected: 3625, startedAt: Date.now(), info: { orderId: 501, status: 'pending' }, lines: [] }
	const withOrder = () => {
		const site = fakeSite()
		site.orders.set(501, { key: 'wc_order_K', status: 'pending', paid: false, total: 362500 })
		return site
	}

	it('счёт и упаковочный лист — PDF по ссылке со страницы заказа, с нужным видом документа; ключ доступа наружу не уходит', async () => {
		const site = withOrder()
		const { svc } = setup({ placed, purchase: { isCreated: true } })
		const invoice = await svc.doc('pu1', 'invoice')
		expect(invoice.name).toBe('schet-501.pdf')
		expect(invoice.bytes.toString()).toBe('%PDF-1.7 invoice 501')
		const packing = await svc.doc('pu1', 'packing')
		expect(packing.name).toBe('nakladnaya-501.pdf')
		expect(packing.bytes.toString()).toBe('%PDF-1.7 packing-slip 501')
		expect(JSON.stringify([invoice.name, packing.name])).not.toContain('SECRETKEY')
		expect(site.calls.filter((c) => c.path.includes('generate_wpo_wcpdf')).every((c) => c.who === 'account')).toBe(true)
	})

	it('вместо PDF пришла страница — 502; ссылки на странице заказа нет — 404; заказа нет — 404', async () => {
		const site = withOrder()
		site.pdfBroken = true
		await expect(setup({ placed, purchase: { isCreated: true } }).svc.doc('pu1', 'invoice')).rejects.toThrow('не отвечает')
		site.pdfBroken = false
		site.docs = false
		await expect(setup({ placed, purchase: { isCreated: true } }).svc.doc('pu1', 'invoice')).rejects.toThrow('Документ на сайте недоступен')
		await expect(setup({ purchase: { isCreated: true } }).svc.doc('pu1', 'invoice')).rejects.toThrow('не найден')
	})
})

describe('адрес одной строкой, права, миниатюры', () => {
	it('аккаунт: адрес получателя — полями сайта; запись старого вида (адрес одной строкой) читается теми же полями', async () => {
		fakeSite()
		const shape = {
			configured: true,
			login: 'na@example.org',
			loginFailed: false,
			firstName: 'Иван',
			lastName: 'Петров',
			phone: '+79000000000',
			email: 'na@example.org',
			street: 'ул. Московская, 1',
			city: 'Саратов',
			state: '',
			postcode: '',
			// одной строкой — для ещё не обновившегося клиента
			address: 'Саратов, ул. Московская, 1',
			comment: '',
			delivery: { kind: 'cdek_door' },
		}
		expect(await setup({ account: { street: 'ул. Московская, 1', city: 'Саратов', delivery: { kind: 'cdek_door' } } }).svc.account()).toEqual(shape)
		expect(await setup({ account: { address: 'Саратов, ул. Московская, 1', delivery: { kind: 'cdek_door' } } }).svc.account()).toEqual(shape)
		// старая запись с пунктом выдачи: строка — адрес пункта, а не получателя; с пометкой «вписан руками» — получателя
		const point = { kind: 'cdek_pvz', code: 'SAR6', title: 'SAR6, Саратов, ул. Тестовая', city: 'Саратов' }
		expect(await setup({ account: { address: '410000, Саратов, ул. Тестовая, 12' } }).svc.account()).toMatchObject({ street: '', city: '', postcode: '', delivery: { ...point, address: '410000, Саратов, ул. Тестовая, 12' } })
		expect(await setup({ account: { address: '410019, Саратов, ул. Ручная, 7', delivery: { ...point, manual: true } } }).svc.account()).toMatchObject({ street: 'ул. Ручная, 7', city: 'Саратов', postcode: '410019' })
	})

	it('примечание к заказу: «СкладАН», закупка и код, затем адрес получателя (при любом способе) и комментарий — одной строкой', () => {
		const door = { city: 'Саратов', street: 'ул. Московская, 1', delivery: { kind: 'cdek_door' } } as any
		expect(orderNote('K7', 31, door)).toBe('СкладАН · закупка №31 (код K7) · Адрес: Саратов, ул. Московская, 1')
		expect(orderNote('K7', 31, { ...door, comment: ' Терминал ПЭК на Соколовой\n звонить за час ' })).toBe('СкладАН · закупка №31 (код K7) · Адрес: Саратов, ул. Московская, 1 · Терминал ПЭК на Соколовой звонить за час')
		expect(orderNote('K7', 31, { address: '', comment: 'только это', delivery: { kind: 'yandex_pvz', title: 'Саратов (ул. Первая)' } } as any)).toBe('СкладАН · закупка №31 (код K7) · только это')
		expect(orderNote('K7', 31, null)).toBe('СкладАН · закупка №31 (код K7)')
	})

	it('адрес в обе стороны: при входе получатель и адрес берутся из кабинета сайта поверх наших; сохранение пишет адрес в кабинет; сверка замечает правку на сайте', async () => {
		// вход: данные сайта — поверх заполненного у нас; пустое с сайта наше не стирает
		let site = fakeSite()
		site.profile.billing_phone = ''
		let ctx = setup({ account: { login: '', password: '', firstName: '', address: 'Энгельс, ул. Старая, 1', delivery: { kind: 'cdek_door' } } })
		const a: any = await ctx.svc.login({ login: 'na@example.org', password: 'secret' }, USER)
		expect(a).toMatchObject({ firstName: 'Анна', lastName: 'Сайтова', phone: '+79000000000', email: 'site@example.org', street: 'ул. Рабочая, 7', city: 'Саратов', state: 'Саратовская область', postcode: '410000' })
		expect(a.address).toBe('410000, Саратовская область, Саратов, ул. Рабочая, 7')
		expect(ctx.db.account.address).toBe('')
		// адрес получателя от способа доставки не зависит: и при выбранном пункте берётся с сайта; строка «ПВЗ …» (её пишет наш заказ без адреса) адресом не считается
		site = fakeSite()
		ctx = setup({ account: { login: '', password: '' } })
		expect(await ctx.svc.login({ login: 'na@example.org', password: 'secret' }, USER)).toMatchObject({ lastName: 'Сайтова', address: '410000, Саратовская область, Саратов, ул. Рабочая, 7' })
		site = fakeSite()
		site.profile.billing_address_1 = 'ПВЗ CDEK: Саратов, ул. Тестовая'
		ctx = setup({ account: { login: '', password: '', address: 'Энгельс, ул. Старая, 1', delivery: { kind: 'cdek_door' } } })
		expect(await ctx.svc.login({ login: 'na@example.org', password: 'secret' }, USER)).toMatchObject({ address: 'Энгельс, ул. Старая, 1' })

		// сверка: на сайте другое — «отличается» и что там записано
		site = fakeSite()
		ctx = setup({ account: { address: 'Саратов, ул. Московская, 1', delivery: { kind: 'cdek_door' } } })
		expect(await ctx.svc.addressCheck()).toEqual({ same: false, site: { name: 'Анна Сайтова', phone: '+79111111111', email: 'site@example.org', address: '410000, Саратовская область, Саратов, ул. Рабочая, 7' } })
		// сохранение: в кабинет уходят те же поля, что с заказом; сверка после него — «совпадает»
		expect(await ctx.svc.saveAccount({ lastName: 'Сидоров' } as any, USER)).toMatchObject({ site: true, lastName: 'Сидоров' })
		expect(site.profile).toMatchObject({ billing_first_name: 'Иван', billing_last_name: 'Сидоров', billing_city: 'Саратов', billing_address_1: 'ул. Московская, 1', billing_phone: '+79000000000', billing_email: 'na@example.org', billing_country: 'RU' })
		expect(site.addressSaves).toHaveLength(1)
		expect(await ctx.svc.addressCheck()).toEqual({ same: true })
		// вход после сохранения адрес не портит: с сайта возвращаются те же поля, сверка — «совпадает»
		expect(await ctx.svc.login({ login: 'na@example.org', password: 'secret' }, USER)).toMatchObject({ street: 'ул. Московская, 1', city: 'Саратов', address: 'Саратов, ул. Московская, 1' })
		expect(await ctx.svc.addressCheck()).toEqual({ same: true })
		// сайт хранит по-своему (пробелы, регистр, знаки в телефоне) — это не отличие, лишней записи нет
		Object.assign(site.profile, { billing_phone: '+7 (900) 000-00-00', billing_email: 'NA@example.org', billing_city: ' Саратов ' })
		expect(await ctx.svc.saveAccount({ lastName: 'Сидоров' } as any, USER)).toMatchObject({ site: true })
		expect(site.addressSaves).toHaveLength(1)
		// на сайте поменяли фамилию: сверка помнит ответ минуту, потом замечает; расчёт закупки несёт тот же признак
		expect((await ctx.svc.addressCheck()).same).toBe(true)
		site.profile.billing_last_name = 'Другая'
		expect((await ctx.svc.addressCheck()).same).toBe(true)
		;(ctx.svc as any).addressMemo.clear()
		expect((await ctx.svc.addressCheck()).same).toBe(false)
		expect(await ctx.svc.quote('pu1', USER)).toMatchObject({ addressDiffers: true })
		// сайт не принял запись — сохранение в приложении всё равно прошло
		site.addressRefused = true
		expect(await ctx.svc.saveAccount({ lastName: 'Кузнецов' } as any, USER)).toMatchObject({ site: false, lastName: 'Кузнецов' })
		expect(site.profile.billing_last_name).toBe('Другая')
		// гость и незаполненный аккаунт — сверять и писать нечего: на сайт не ходим
		const calls = site.calls.length
		const guest = setup({ account: { login: '', password: '' } })
		expect(await guest.svc.saveAccount({ lastName: 'Гость' } as any, USER)).toMatchObject({ site: null })
		expect(await guest.svc.addressCheck()).toEqual({ same: null })
		expect(await setup({ account: { delivery: undefined } }).svc.saveAccount({ lastName: 'Без доставки' } as any, USER)).toMatchObject({ site: null })
		expect(site.calls.length).toBe(calls)
	})

	it('адрес при сохранении не проверяется; нет города — проблема account в расчёте; не обновившийся клиент шлёт адрес строкой', async () => {
		fakeSite()
		const { svc, db } = setup()
		const a = await svc.saveAccount({ street: 'ул. Московская, 1', city: '', delivery: { kind: 'cdek_door' } } as any, USER)
		expect(db.accountUpdate[1].$set).toEqual({ street: 'ул. Московская, 1', city: '', state: '', postcode: '', delivery: { kind: 'cdek_door' } })
		expect(a.configured).toBe(false)
		expect((await svc.quote('pu1', USER)).problems).toEqual(['account'])
		// до двери без улицы — тоже: поле адреса на сайте обязательное, отказ пришёл бы уже при оформлении
		expect((await setup({ account: { city: 'Саратов', delivery: { kind: 'cdek_door' } } }).svc.quote('pu1', USER)).problems).toEqual(['account'])
		// старый клиент: строка раскладывается по полям (страна пропускается) и сама не хранится
		await svc.saveAccount({ address: '410019, Россия, Саратовская область, Саратов, ул. им. Маяковского, д. 1' } as any, USER)
		expect(db.accountUpdate[1].$set).toEqual({ street: 'ул. им. Маяковского, д. 1', city: 'Саратов', state: 'Саратовская область', postcode: '410019' })
		expect((await svc.account()).configured).toBe(true)
		// у него при пункте выдачи без ручной правки строка — адрес пункта: адрес получателя не трогаем; manual не хранится
		const delivery = { kind: 'cdek_pvz', code: 'SAR6', title: 'SAR6, Саратов, ул. Тестовая', city: 'Саратов' }
		await svc.saveAccount({ address: '410000, Саратов, ул. Тестовая, 12', delivery } as any, USER)
		expect(db.accountUpdate[1].$set).toEqual({ delivery })
		await svc.saveAccount({ address: 'Энгельс, ул. Ручная, 7', delivery: { ...delivery, manual: true } } as any, USER)
		expect(db.accountUpdate[1].$set).toEqual({ delivery, street: 'ул. Ручная, 7', city: 'Энгельс', state: '', postcode: '' })
	})

	it('запись старого вида переводится в поля при первой записи адреса: адрес пункта уходит в доставку, строка очищается', async () => {
		fakeSite()
		const point = { kind: 'cdek_pvz', code: 'SAR6', title: 'SAR6, Саратов, ул. Тестовая', city: 'Саратов' }
		let ctx = setup({ account: { address: '410000, Саратов, ул. Тестовая, 12' } })
		await ctx.svc.saveAccount({ street: 'ул. Ручная, 7', city: 'Энгельс', state: '', postcode: '' } as any, USER)
		expect(ctx.db.accountUpdate[1].$set).toEqual({ address: '', delivery: { ...point, address: '410000, Саратов, ул. Тестовая, 12' }, street: 'ул. Ручная, 7', city: 'Энгельс', state: '', postcode: '' })
		// то же при входе: получатель — с сайта, адрес пункта — в доставку
		fakeSite()
		ctx = setup({ account: { address: '410000, Саратов, ул. Тестовая, 12' } })
		await ctx.svc.login({ login: 'na@example.org', password: 'secret' }, USER)
		expect(ctx.db.account).toMatchObject({ address: '', street: 'ул. Рабочая, 7', city: 'Саратов', postcode: '410000', delivery: { ...point, address: '410000, Саратов, ул. Тестовая, 12' } })
		// в кабинете — та же строка целиком (так писала прежняя версия): вход её в поле улицы не тянет, запись остаётся как была
		const stale = fakeSite()
		stale.profile.billing_address_1 = 'Саратов, ул. Московская, 1'
		ctx = setup({ account: { address: 'Саратов, ул. Московская, 1', delivery: { kind: 'cdek_door' } } })
		expect(await ctx.svc.login({ login: 'na@example.org', password: 'secret' }, USER)).toMatchObject({ street: 'ул. Московская, 1', city: 'Саратов' })
		expect(ctx.db.account.address).toBe('Саратов, ул. Московская, 1')
		// неполный запрос к записи до двери: остальные поля берутся разобранными из строки
		ctx = setup({ account: { address: '410012, Саратов, ул. Московская, 1', delivery: { kind: 'cdek_door' } } })
		await ctx.svc.saveAccount({ street: 'ул. Московская, 2' } as any, USER)
		expect(ctx.db.accountUpdate[1].$set).toEqual({ address: '', street: 'ул. Московская, 2', city: 'Саратов', state: '', postcode: '410012' })
		// не обновившийся клиент на записи старого вида выбирает пункт: его строка — адрес этого пункта; прежняя строка (адрес до двери) остаётся получателю
		ctx = setup({ account: { address: 'Энгельс, ул. Домашняя, 3', delivery: { kind: 'cdek_door' } } })
		await ctx.svc.saveAccount({ address: '410000, Саратов, ул. Тестовая, 12', delivery: point } as any, USER)
		expect(ctx.db.accountUpdate[1].$set).toEqual({ address: '', delivery: { ...point, address: '410000, Саратов, ул. Тестовая, 12' }, street: 'ул. Домашняя, 3', city: 'Энгельс', state: '', postcode: '' })
	})

	it('заказ до двери: в форму — улица, город и индекс получателя', async () => {
		const site = fakeSite()
		await setup({ account: { postcode: '410012', city: 'Саратов', street: 'ул. Московская, 1, кв. 5', delivery: { kind: 'cdek_door' } } }).svc.order('pu1', 4056, USER)
		expect(site.checkout.get('billing_address_1')).toBe('ул. Московская, 1, кв. 5')
		expect(site.checkout.get('billing_city')).toBe('Саратов')
		expect(site.checkout.get('billing_postcode')).toBe('410012')
		expect(site.checkout.get('shipping_method[0]')).toBe('official_cdek:139')
		expect(site.checkout.get('order_comments')).toMatch(/^СкладАН · закупка №31 \(код \w+\) · Адрес: 410012, Саратов, ул\. Московская, 1, кв\. 5$/)
	})

	it('пункт выдачи: доставка считается по городу пункта, улица получателя уходит как написана, в расчёте — адрес пункта; в кабинет сайта — адрес получателя', async () => {
		const site = fakeSite()
		const delivery = { kind: 'cdek_pvz', code: 'SAR6', title: 'SAR6, Саратов, ул. Тестовая', address: '410000, Саратов, ул. Тестовая, 12', city: 'Саратов' }
		const ctx = setup({ account: { postcode: '413100', city: 'Энгельс', street: 'ул. Ручная, 7', delivery } })
		expect((await ctx.svc.quote('pu1', USER)).delivery).toEqual({ kind: 'cdek_pvz', title: 'CDEK — пункт выдачи', point: '410000, Саратов, ул. Тестовая, 12' })
		await ctx.svc.order('pu1', 3625, USER)
		// получатель в другом городе — его индекс к городу пункта не приклеивается: индекс — пункта
		expect(site.checkout.get('billing_city')).toBe('Саратов')
		expect(site.checkout.get('billing_postcode')).toBe('410000')
		// заказ оставил в кабинете сайта свой адрес (с городом пункта): это не «адрес отличается», и вход город получателя не подменяет
		expect(site.profile).toMatchObject({ billing_city: 'Саратов', billing_address_1: 'ул. Ручная, 7' })
		;(ctx.svc as any).addressMemo.clear()
		expect(await ctx.svc.addressCheck()).toEqual({ same: true })
		expect(await ctx.svc.login({ login: 'na@example.org', password: 'secret' }, USER)).toMatchObject({ street: 'ул. Ручная, 7', city: 'Энгельс', postcode: '413100' })
		// а правку на сайте вход берёт
		site.profile.billing_address_1 = 'ул. Новая, 3'
		expect(await ctx.svc.login({ login: 'na@example.org', password: 'secret' }, USER)).toMatchObject({ street: 'ул. Новая, 3', city: 'Саратов' })
		expect(site.checkout.get('billing_address_1')).toBe('ул. Ручная, 7')
		expect(site.checkout.get('order_comments')).toMatch(/^СкладАН · закупка №31 \(код \w+\) · Адрес: 413100, Энгельс, ул\. Ручная, 7$/)
		// в кабинете сайта — город получателя, а не пункта: вход его потом не подменит
		const cabinet = fakeSite()
		await setup({ account: { postcode: '413100', city: 'Энгельс', street: 'ул. Ручная, 7', delivery } }).svc.saveAccount({ lastName: 'Сидоров' } as any, USER)
		expect(cabinet.profile).toMatchObject({ billing_city: 'Энгельс', billing_postcode: '413100', billing_address_1: 'ул. Ручная, 7' })
		// тот же город — индекс получателя идёт и в расчёт
		const same = fakeSite()
		await setup({ account: { postcode: '410019', city: 'саратов', street: 'ул. Ручная, 7', delivery } }).svc.order('pu1', 3625, USER)
		expect(same.checkout.get('billing_postcode')).toBe('410019')
	})

	it('пункт выдачи без улицы получателя: в обязательное поле адреса сайта идёт пункт — и у записи старого вида', async () => {
		const delivery = { kind: 'cdek_pvz', code: 'SAR6', title: 'SAR6, Саратов, ул. Тестовая', address: '410000, Саратов, ул. Тестовая, 12', city: 'Саратов' }
		let site = fakeSite()
		const blank = setup({ account: { delivery } })
		await blank.svc.order('pu1', 3625, USER)
		expect(site.checkout.get('billing_address_1')).toBe('ПВЗ CDEK: 410000, Саратов, ул. Тестовая, 12')
		expect(site.checkout.get('order_comments')).toBe(`СкладАН · закупка №31 (код ${blank.db.placed.code})`)
		// адреса пункта нет — строка пункта для сайта; у Яндекса — своё название службы
		site = fakeSite()
		await setup({ account: { delivery: { kind: 'yandex_pvz', code: 'y1', title: 'Саратов (410000, Саратов, ул. Первая)', city: 'Саратов' } } }).svc.order('pu1', 3344.59, USER)
		expect(site.checkout.get('billing_address_1')).toBe('ПВЗ Яндекс Доставки: Саратов (410000, Саратов, ул. Первая)')
		// старая запись: строка адреса — адрес пункта. В заказ — как раньше, адресом получателя она не становится
		site = fakeSite()
		const old = setup({ account: { address: '410000, Саратов, ул. Тестовая, 12' } })
		expect((await old.svc.quote('pu1', USER)).delivery.point).toBe('410000, Саратов, ул. Тестовая, 12')
		await old.svc.order('pu1', 3625, USER)
		expect(site.checkout.get('billing_address_1')).toBe('ПВЗ CDEK: 410000, Саратов, ул. Тестовая, 12')
		expect(site.checkout.get('order_comments')).toBe(`СкладАН · закупка №31 (код ${old.db.placed.code})`)
	})

	it('настройка — только с правом создавать или править закупки; председатель без них — нет', () => {
		const prewarmPoints = jest.fn()
		const ctrl = new LitnaController({ account: (full: boolean) => (full ? 'ok' : 'brief'), release: () => 'ok', saveLinks: () => 'ok', prewarmPoints } as any)
		const user = (permissions: string[], extra: any = {}) => ({ _id: 'u', company: 'c1', role: { permissions }, ...extra })
		expect(ctrl.account(user(['create_purchases']) as any)).toBe('ok')
		expect(ctrl.account(user(['edit_purchases', 'view_purchases']) as any)).toBe('ok')
		expect(ctrl.release('x', user(['edit_purchases']) as any)).toBe('ok')
		expect(() => ctrl.release('x', user([], { isAdmin: true }) as any)).toThrow('нету доступа')
		expect(() => ctrl.links(user(['view_purchases']) as any, { links: [] })).toThrow('нету доступа')
		// видеть аккаунт можно и с правом видеть закупки — кратко; пункты Яндекса заранее — только тем, кто настраивает
		expect(prewarmPoints).toHaveBeenCalledTimes(2)
		expect(ctrl.account(user(['view_purchases']) as any)).toBe('brief')
		expect(prewarmPoints).toHaveBeenCalledTimes(2)
	})

	it('аккаунт тому, кто только видит закупки: без получателя, адреса, пункта выдачи и почты входа', async () => {
		fakeSite()
		const { svc } = setup()
		const brief = await svc.account(false)
		expect(brief).toEqual({ configured: true, login: true, loginFailed: false })
		expect(JSON.stringify(brief)).not.toMatch(/Иван|Петров|79000000000|na@example\.org|SAR6"/)
		expect(await setup({ account: { login: '', password: '' } }).svc.account(false)).toMatchObject({ login: null })
		expect(await setup({ account: null }).svc.account(false)).toEqual({ configured: false, login: null, loginFailed: false })
	})

	it('картинка товара сайта: тому, кто может создавать или править товары, и супер-админу', async () => {
		const send = jest.fn()
		const res: any = { set: () => res, send }
		const ctrl = new LitnaController({ image: async () => ({ contentType: 'image/jpeg', bytes: Buffer.from('x') }) } as any)
		const user = (permissions: string[], extra: any = {}) => ({ _id: 'u', company: 'c1', role: { permissions }, ...extra })
		await ctrl.image(11, user(['edit_products'], { isAdmin: true }) as any, res)
		await ctrl.image(11, user(['create_product'], { isAdmin: true }) as any, res)
		await ctrl.image(11, { _id: 's', company: null, isSuperAdmin: true } as any, res)
		expect(send).toHaveBeenCalledTimes(3)
		// как и правка товаров: право без отметки «служащий» не пускает
		await expect(ctrl.image(11, user(['edit_products']) as any, res)).rejects.toThrow('нету доступа')
		await expect(ctrl.image(11, user(['view_products'], { isAdmin: true }) as any, res)).rejects.toThrow('нету доступа')
	})

	it('миниатюра: вариант ~300 px, проверка по первым байтам, в памяти; нет картинки — 404; чужой адрес — 502', async () => {
		const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)])
		const asked: string[] = []
		const catalog = (thumb: string) =>
			(global.fetch = jest.fn(async (url: any) => {
				asked.push(String(url))
				if (String(url).includes('/wp-json/')) return new Response(JSON.stringify([{ ...CATALOG[0], images: [{ src: thumb, thumbnail: thumb + '-600', thumbnail_srcset: `${thumb}-300 300w, ${thumb}-600 600w` }] }, CATALOG[1]]))
				return new Response(png)
			}) as any)
		catalog('https://lit-na.ru/wp-content/uploads/a.png')
		const { svc } = setup()
		expect(await svc.thumb(11)).toEqual({ contentType: 'image/png', bytes: png })
		expect(asked.filter((u) => u.includes('uploads'))).toEqual(['https://lit-na.ru/wp-content/uploads/a.png-300'])
		await svc.thumb(11)
		expect(asked.filter((u) => u.includes('uploads'))).toHaveLength(1)
		await expect(svc.thumb(12)).rejects.toThrow('нет картинки')
		catalog('https://evil.example/a.png')
		await expect(setup().svc.thumb(11)).rejects.toThrow('не отвечает')
	})

	it('миниатюр в памяти — не больше 500: самая старая уходит', async () => {
		const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)])
		const items = Array.from({ length: 501 }, (_, i) => ({ ...CATALOG[1], id: 1000 + i, images: [{ src: `https://lit-na.ru/u/${i}.png`, thumbnail: `https://lit-na.ru/u/${i}.png` }] }))
		let downloads = 0
		global.fetch = jest.fn(async (url: any) => {
			const u = new URL(String(url))
			if (u.pathname.startsWith('/wp-json/')) {
				const page = Number(u.searchParams.get('page'))
				return new Response(JSON.stringify(items.slice((page - 1) * 100, page * 100)))
			}
			downloads++
			return new Response(png)
		}) as any
		const { svc } = setup()
		for (const item of items) await svc.thumb(item.id)
		expect(downloads).toBe(501)
		await svc.thumb(1500)
		expect(downloads).toBe(501)
		await svc.thumb(1000)
		expect(downloads).toBe(502)
	})
})

describe('заказ гостем', () => {
	const guestAccount = { login: '', password: '' }

	it('без входа: гостевая сессия, почта и телефон получателя, код в пометке; заказ — гостевой', async () => {
		const site = fakeSite()
		const { svc, db, purchases } = setup({ account: guestAccount })
		await svc.order('pu1', 3625, USER)
		expect(site.calls.some((c) => c.who === 'account' || (c.path === '/my-account/' && c.method === 'POST'))).toBe(false)
		expect(site.checkout.get('billing_email')).toBe('na@example.org')
		expect(site.checkout.get('billing_phone')).toBe('+79000000000')
		expect(site.checkout.get('order_comments')).toBe(`СкладАН · закупка №31 (код ${db.placed.code})`)
		expect(db.placed).toMatchObject({ orderId: 501, orderKey: 'wc_order_K', guest: true, login: null })
		// куки сессии и поля формы после привязки не хранятся; почта заказа — хранится
		expect(db.placed.cookies).toBeUndefined()
		expect(db.placed.sent).toBeUndefined()
		expect(db.placed.email).toBe('na@example.org')
		// корзину аккаунта не трогали
		expect([...site.carts.account]).toEqual([[99, 1]])
		expect(purchases.update).toHaveBeenCalledWith('pu1', { isCreated: true }, USER, true)
	})

	it('ответ потерян: после выдержки — та же сессия, корзина не пересобирается, сайт возвращает тот же заказ', async () => {
		const site = fakeSite()
		site.checkoutMode = 'lost'
		const { svc, db } = setup({ account: guestAccount })
		await expect(svc.order('pu1', 3625, USER)).rejects.toThrow('ещё оформляется')
		expect(db.placed.cookies).toEqual(expect.arrayContaining([['wp_woocommerce_session_x', expect.any(String)]]))
		expect(site.orders.size).toBe(1)
		// сразу повтор не отправляется: сайт мог ещё работать
		await expect(svc.order('pu1', 3625, USER)).rejects.toThrow('ещё оформляется')
		db.placed.startedAt -= 4 * 60_000
		site.checkoutMode = 'ok'
		const batches = site.calls.filter((c) => c.path.endsWith('/batch')).length
		await svc.order('pu1', 3625, USER)
		expect(site.calls.filter((c) => c.path.endsWith('/batch')).length).toBe(batches)
		expect(site.orders.size).toBe(1)
		expect(db.placed).toMatchObject({ orderId: 501, guest: true })
		expect(site.checkouts.map((f) => f.get('order_comments'))).toEqual([site.checkouts[0].get('order_comments'), site.checkouts[0].get('order_comments')])
	})

	it('сайт отказал после создания заказа — повтор в той же сессии сводится к тому же заказу; отказ дважды — намерение снято', async () => {
		let site = fakeSite()
		site.checkoutMode = 'failure-created-once'
		let ctx = setup({ account: guestAccount })
		// первый ответ — отказ, но заказ создан; повтор в той же сессии возвращает его же, второго заказа нет
		await ctx.svc.order('pu1', 3625, USER)
		expect(site.checkouts).toHaveLength(2)
		expect(site.orders.size).toBe(1)
		expect(ctx.db.placed).toMatchObject({ orderId: 501, guest: true })

		site = fakeSite()
		site.checkoutMode = 'failure'
		ctx = setup({ account: guestAccount })
		await expect(ctx.svc.order('pu1', 3625, USER)).rejects.toThrow('lit-na.ru: Нет в наличии')
		expect(site.checkouts).toHaveLength(2)
		expect(ctx.db.placed).toBeNull()
	})

	it('сессия умерла (корзины нет) — доказать нельзя: намерение остаётся, «снимите оформление»', async () => {
		fakeSite()
		const intent = { _id: 'o1', purchase: 'pu1', code: 'K7Q2X9PM', guest: true, login: null, cookies: [['wp_woocommerce_session_x', 'g99']], sent: { 'shipping_method[0]': 'official_cdek:138' }, expected: 3625, startedAt: Date.now() - 10 * 60_000, info: { status: 'placing' }, lines: [] }
		const { svc, db } = setup({ account: guestAccount, placed: intent, purchase: { litna: { status: 'placing' } } })
		await expect(svc.order('pu1', 3625, USER)).rejects.toThrow('Не удалось проверить заказ на lit-na.ru — снимите оформление и оформите заново')
		expect(db.placed).toMatchObject({ code: 'K7Q2X9PM' })
	})

	it('удаление закупки с гостевым намерением: оформление не досылается; свежее — ждать, старое — снимается, в историю', async () => {
		const site = fakeSite()
		const intent = { _id: 'o1', purchase: 'pu1', code: 'K7Q2X9PM', guest: true, login: null, cookies: [['wp_woocommerce_session_x', 'g1']], sent: { 'shipping_method[0]': 'official_cdek:138' }, expected: 3625, startedAt: Date.now(), info: { status: 'placing' }, lines: [] }
		const fresh = setup({ account: guestAccount, placed: intent, purchase: { litna: { status: 'placing' } } })
		await expect(fresh.svc.remove('pu1', USER)).rejects.toThrow('ещё оформляется')
		const old = setup({ account: guestAccount, placed: { ...intent, startedAt: Date.now() - 10 * 60_000 }, purchase: { litna: { status: 'placing' } } })
		await old.svc.remove('pu1', USER)
		expect(old.db.writes).toEqual(['drop', 'unset', 'removed'])
		expect(old.db.history).toEqual([expect.objectContaining({ changeType: 'litna-released', description: 'Оформление на lit-na.ru снято при удалении закупки 31' })])
		expect(checkouts(site)).toBe(0)
		expect(site.calls).toEqual([])
	})

	it('повтор после потерянного ответа — с теми же полями, что при первой отправке, а не с нынешними настройками', async () => {
		const site = fakeSite()
		site.checkoutMode = 'lost'
		const { svc, db } = setup({ account: guestAccount })
		await expect(svc.order('pu1', 3625, USER)).rejects.toThrow('ещё оформляется')
		db.placed.startedAt -= 4 * 60_000
		// пока ждали, в аккаунте сменили пункт и способ доставки
		db.account.delivery = { kind: 'yandex_pvz', code: 'y1', title: 'другой', city: 'Саратов' }
		site.checkoutMode = 'ok'
		await svc.order('pu1', 3625, USER)
		const [first, again] = site.checkouts
		expect(again.get('shipping_method[0]')).toBe(first.get('shipping_method[0]'))
		expect(again.get('office_code')).toBe('SAR6')
		expect(again.get('billing_address_1')).toBe(first.get('billing_address_1'))
	})

	it('отказ сайта дважды подряд: намерение снято, в истории и в ответе — код заказа, который мог остаться на сайте', async () => {
		const site = fakeSite()
		site.checkoutMode = 'failure-created'
		const { svc, db } = setup({ account: guestAccount })
		const err: any = await svc.order('pu1', 3625, USER).catch((e) => e)
		// человеку — только текст сайта; про оставшийся заказ — в истории, без push
		expect(err.message).toBe('lit-na.ru: Ошибка платёжного шлюза')
		expect(db.history).toEqual([
			expect.objectContaining({
				changeType: 'litna-released',
				description: expect.stringMatching(/^Оформление на lit-na.ru снято после отказа сайта, закупка 31; на сайте мог остаться неоплаченный заказ с кодом [A-Z2-9]{8}$/),
				opts: { push: false },
			}),
		])
		expect(site.orders.size).toBe(1)
	})

	describe('сайт просит подтвердить почту заказа', () => {
		const guestPlaced = { _id: 'o1', purchase: 'pu1', orderId: 501, orderKey: 'wc_order_K', guest: true, login: null, email: 'zakaz@example.org', expected: 3625, startedAt: Date.now(), info: { orderId: 501, status: 'pending', total: 3625 }, lines: [] }
		const asking = (over: any = {}) => {
			const site = fakeSite()
			site.askEmail = true
			site.orders.set(501, { key: 'wc_order_K', status: 'pending', paid: false, total: 362500, guest: true, email: 'zakaz@example.org', ...over })
			return site
		}
		const created = { isCreated: true, litna: { orderId: 501, total: 3625 } }

		it('оплата: страница оплаты подтверждается почтой заказа, форма Robokassa — из ответа на подтверждение', async () => {
			const site = asking()
			const form = await setup({ account: guestAccount, placed: guestPlaced, purchase: created }).svc.pay('pu1', USER)
			expect(form).toMatchObject({ action: 'https://auth.robokassa.ru/Merchant/Index.aspx', fields: { InvId: '501' } })
			const confirms = site.calls.filter((c) => c.method === 'POST' && new URLSearchParams(c.body).get('verify') === '1')
			expect(confirms.map((c) => new URLSearchParams(c.body).get('email'))).toEqual(['zakaz@example.org'])
			// статус, страница оплаты, подтверждение почты
			expect(site.calls.filter((c) => c.url.startsWith('https://lit-na.ru/'))).toHaveLength(3)
		})

		it('старая запись без почты — почта получателя из аккаунта', async () => {
			asking({ email: 'na@example.org' })
			const { email, ...old } = guestPlaced
			expect(email).toBeDefined()
			expect(await setup({ account: guestAccount, placed: old, purchase: created }).svc.pay('pu1', USER)).toHaveProperty('action')
		})

		it('почта не подошла — понятный отказ', async () => {
			asking({ email: 'other@example.org' })
			await expect(setup({ account: guestAccount, placed: guestPlaced, purchase: created }).svc.pay('pu1', USER)).rejects.toThrow(
				'lit-na.ru просит подтвердить почту заказа — оплатите или отмените заказ на сайте'
			)
		})

		it('отмена и документы гостевого заказа — тоже через подтверждение', async () => {
			let site = asking()
			const ctx = setup({ account: guestAccount, placed: guestPlaced, purchase: created })
			await ctx.svc.remove('pu1', USER)
			expect(site.orders.get(501).status).toBe('cancelled')
			site = asking()
			site.docsOnReceived = true
			expect((await setup({ account: guestAccount, placed: guestPlaced }).svc.doc('pu1', 'invoice')).name).toBe('schet-501.pdf')
		})
	})

	it('сайт недоступен при входе — 502 «недоступен», а не «неверный пароль»; вход не помечается сломанным', async () => {
		const site = fakeSite()
		site.down = true
		const { svc, db } = setup()
		await expect(svc.login({ login: 'na@example.org', password: 'secret' }, USER)).rejects.toThrow('lit-na.ru недоступен')
		await expect(svc.order('pu1', 3625, USER)).rejects.toThrow('lit-na.ru недоступен')
		expect(db.account.loginFailed).toBeFalsy()
	})

	const guestPlaced = { _id: 'o1', purchase: 'pu1', orderId: 501, orderKey: 'wc_order_K', guest: true, login: null, expected: 3625, startedAt: Date.now(), info: { orderId: 501, status: 'pending', total: 3625 }, lines: [] }
	const withGuestOrder = () => {
		const site = fakeSite()
		site.orders.set(501, { key: 'wc_order_K', status: 'pending', paid: false, total: 362500, guest: true })
		return site
	}

	it('оплата гостевого заказа — без входа, по ключу; вход под аккаунтом при этом не нужен', async () => {
		const site = withGuestOrder()
		const { svc } = setup({ account: guestAccount, placed: guestPlaced, purchase: { isCreated: true, litna: { orderId: 501, total: 3625 } } })
		expect(await svc.pay('pu1', USER)).toHaveProperty('action')
		expect(site.calls.every((c) => c.who === 'guest')).toBe(true)
	})

	it('отмена гостевого заказа — ссылкой со страницы «заказ получен», засчитывается по статусу; ссылки нет — «напишите в магазин»', async () => {
		let site = withGuestOrder()
		let ctx = setup({ account: guestAccount, placed: guestPlaced, purchase: { isCreated: true, litna: { orderId: 501 } } })
		await ctx.svc.remove('pu1', USER)
		expect(site.orders.get(501).status).toBe('cancelled')
		expect(ctx.purchases.remove).toHaveBeenCalled()

		site = withGuestOrder()
		site.cancelWorks = false
		ctx = setup({ account: guestAccount, placed: guestPlaced, purchase: { isCreated: true, litna: { orderId: 501 } } })
		await expect(ctx.svc.remove('pu1', USER)).rejects.toThrow('Не удалось отменить заказ №501 на lit-na.ru — напишите в магазин')
		expect(ctx.purchases.remove).not.toHaveBeenCalled()
	})

	it('документы гостевого заказа — со страницы оплаты или «заказ получен»; нигде нет — 404', async () => {
		let site = withGuestOrder()
		expect((await setup({ account: guestAccount, placed: guestPlaced }).svc.doc('pu1', 'packing')).bytes.toString()).toBe('%PDF-1.7 packing-slip 501')
		site = withGuestOrder()
		site.docsOnReceived = true
		expect((await setup({ account: guestAccount, placed: guestPlaced }).svc.doc('pu1', 'invoice')).name).toBe('schet-501.pdf')
		expect(site.calls.some((c) => c.path.startsWith('/checkout/order-received/501/'))).toBe(true)
		site = withGuestOrder()
		site.docs = false
		await expect(setup({ account: guestAccount, placed: guestPlaced }).svc.doc('pu1', 'invoice')).rejects.toThrow('Документ на сайте недоступен')
	})

	it('заказ, оформленный под аккаунтом, после выхода в гостя — понятный отказ «зайдите заново под аккаунтом»', async () => {
		const site = fakeSite()
		site.orders.set(501, { key: 'wc_order_K', status: 'pending', paid: false, total: 362500 })
		const placed = { ...guestPlaced, guest: false, login: 'na@example.org' }
		await expect(setup({ account: guestAccount, placed, purchase: { isCreated: true, litna: { orderId: 501, total: 3625 } } }).svc.pay('pu1', USER)).rejects.toThrow(
			'Заказ оформлен под аккаунтом lit-na.ru na@example.org — зайдите заново под этим аккаунтом'
		)
	})
})

describe('без настроенного аккаунта', () => {
	it('расчёт — строки с ценами и остатками сайта и проблема account, без доставки; каталог и миниатюры работают', async () => {
		fakeSite()
		const { svc } = setup({ account: null })
		const quote = await svc.quote('pu1', USER)
		expect(quote).toMatchObject({ goods: 3000, shipping: 0, problems: ['account'], canOrder: false })
		expect(quote.lines.map((l) => [l.price, l.stock])).toEqual([[1000, 50], [500, 3]])
		expect(await svc.account()).toMatchObject({ configured: false, login: null, loginFailed: false, delivery: null })
		expect((await svc.catalog()).items).toHaveLength(3)
	})
})

describe('вход заранее и заказ гостем по выбору', () => {
	const logins = (site: ReturnType<typeof fakeSite>) => site.calls.filter((c) => c.path === '/my-account/' && c.method === 'POST').length

	it('вход заранее: сессия поднимается один раз, живая — без нового входа; повтор в течение 5 минут — без сайта', async () => {
		const site = fakeSite()
		const { svc } = setup()
		expect(await svc.warm(USER)).toEqual({ login: 'na@example.org', loginFailed: false, up: true })
		expect(logins(site)).toBe(1)
		const calls = site.calls.length
		expect(await svc.warm(USER)).toEqual({ login: 'na@example.org', loginFailed: false, up: true })
		expect(site.calls.length).toBe(calls)
		// заказ идёт в той же сессии — второго входа нет
		await svc.order('pu1', 3625, USER)
		expect(logins(site)).toBe(1)
	})

	it('вход заранее не удался — не ошибка запроса: loginFailed в ответе и в аккаунте; гость — только проверка сайта', async () => {
		let site = fakeSite()
		const { svc, db } = setup({ account: { password: seal('другой', SECRET) } })
		expect(await svc.warm(USER)).toEqual({ login: 'na@example.org', loginFailed: true, up: true })
		expect(db.account.loginFailed).toBe(true)
		site = fakeSite()
		expect(await setup({ account: { login: '', password: '' } }).svc.warm(USER)).toEqual({ login: null, loginFailed: false, up: true })
		expect(site.calls.map((c) => [c.method, c.path])).toEqual([['GET', '/wp-json/wc/store/v1/products?per_page=1']])
	})

	it('сайт не отвечает: up false, вход не пробуется, loginFailed не меняется; проверка одна на всех и помнится минуту', async () => {
		global.fetch = jest.fn(async () => {
			throw new TypeError('fetch failed')
		}) as any
		const { svc, db } = setup({ account: { loginFailed: true } })
		const [a, b] = await Promise.all([svc.warm(USER), svc.warm(USER)])
		expect(a).toEqual({ login: 'na@example.org', loginFailed: true, up: false })
		expect(b).toEqual(a)
		expect(global.fetch).toHaveBeenCalledTimes(1)
		expect(db.account.loginFailed).toBe(true)
		const site = fakeSite()
		expect((await svc.warm(USER)).up).toBe(false)
		expect(site.calls).toEqual([])
		;(svc as any).upCheck.at -= 60_000
		expect(await svc.warm(USER)).toEqual({ login: 'na@example.org', loginFailed: false, up: true })
		expect(logins(site)).toBe(1)
		// гость при лежащем сайте — тоже up: false
		global.fetch = jest.fn(async () => new Response('<html>502 Bad Gateway</html>', { status: 502 })) as any
		expect(await setup({ account: { login: '', password: '' } }).svc.warm(USER)).toEqual({ login: null, loginFailed: false, up: false })
	})

	it('сайт перестал отвечать посреди входа: up false, loginFailed не ставится', async () => {
		fakeSite()
		const site = global.fetch as any
		global.fetch = jest.fn(async (url: any, init: any) => {
			if (String(url).includes('/my-account/')) throw new TypeError('fetch failed')
			return site(url, init)
		}) as any
		const { svc, db } = setup()
		expect(await svc.warm(USER)).toEqual({ login: 'na@example.org', loginFailed: false, up: false })
		expect(db.account.loginFailed).toBeUndefined()
	})

	it('каталог: up false, если обновить не вышло и отдан прежний', async () => {
		fakeSite()
		const { svc } = setup()
		expect((await svc.catalog()).up).toBe(true)
		expect((await svc.catalog(true)).up).toBe(true)
		;(svc as any).catalogCache.at -= 10 * 60_000
		global.fetch = jest.fn(async () => {
			throw new TypeError('fetch failed')
		}) as any
		const stale = await svc.catalog()
		expect(stale.up).toBe(false)
		expect(stale.items.length).toBeGreaterThan(0)
	})

	it('заказ гостем по выбору: вход сохранён, но заказ — гостевой, сохранённый вход не трогается', async () => {
		const site = fakeSite()
		const { svc, db } = setup()
		await svc.order('pu1', 3625, USER, true)
		expect(logins(site)).toBe(0)
		expect(site.calls.some((c) => c.who === 'account')).toBe(false)
		expect(db.placed).toMatchObject({ orderId: 501, guest: true, login: null })
		expect(db.account.login).toBe('na@example.org')
	})
})

describe('засев новой местности с lit-na.ru', () => {
	it('каталог для формы «Семян»: сколько товаров попадёт в засев и по каким видам', async () => {
		fakeSite()
		const res: any = await setup().svc.catalog(true)
		// без категории (только «Товары» или ничего) — не засевается
		expect(res).toMatchObject({ count: 1, categories: [{ name: 'Книги', count: 1 }] })
	})

	it('сайт недоступен или засеять нечего — 502, засева нет', async () => {
		global.fetch = jest.fn(async () => {
			throw new TypeError('fetch failed')
		}) as any
		await expect(setup().svc.siteSeed()).rejects.toThrow('Не удалось получить каталог lit-na.ru — местность не создана')
		global.fetch = jest.fn(async () => new Response(JSON.stringify([{ ...CATALOG[1] }]))) as any
		await expect(setup().svc.siteSeed()).rejects.toThrow('нет товаров для засева')
		fakeSite()
		expect(await setup().svc.siteSeed()).toEqual({
			products: [{ name: 'Книга А', category: 'Книги', price: 1000, targetQty: 0, litnaId: 11 }],
			kindCovers: [{ category: 'Книги', cover: 'book' }],
		})
	})

	it('фото фоном: миниатюра сайта — фото товара в хранилище местности; не больше 3 запросов сразу; сбои пропускаются', async () => {
		const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)])
		const items = Array.from({ length: 8 }, (_, i) => ({ ...CATALOG[1], id: 200 + i, images: [{ src: `https://lit-na.ru/u/${i}.png`, thumbnail: `https://lit-na.ru/u/${i}.png` }] }))
		let now = 0
		let peak = 0
		global.fetch = jest.fn(async (url: any) => {
			const u = new URL(String(url))
			if (u.pathname.startsWith('/wp-json/')) return new Response(JSON.stringify(items))
			peak = Math.max(peak, ++now)
			await new Promise((r) => setTimeout(r, 5))
			now--
			// одна картинка битая — товар просто без фото
			return new Response(u.pathname.endsWith('/3.png') ? '<html>нет</html>' : png)
		}) as any
		const products = items.map((p) => ({ _id: 'p' + p.id, litnaId: p.id }))
		const { svc, db } = setup({ products })
		await svc.seedPhotos('64a0000000000000000000c1')
		expect(peak).toBeLessThanOrEqual(3)
		expect(db.photos).toHaveLength(7)
		expect(db.photos[0]).toMatchObject({ contentType: 'image/png', data: png })
		expect(String(db.photos[0].company)).toBe('64a0000000000000000000c1')
		expect(db.photoSet).toHaveLength(7)
		expect(db.photoSet[0][0]).toMatchObject({ photo: null })
		expect(db.emitted).toEqual([['64a0000000000000000000c1', 'product-updated']])
	})

	it('фото засева сверх квоты местности: запись откатывается, засев фото останавливается', async () => {
		const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)])
		const items = Array.from({ length: 8 }, (_, i) => ({ ...CATALOG[1], id: 200 + i, images: [{ src: `https://lit-na.ru/u/${i}.png`, thumbnail: `https://lit-na.ru/u/${i}.png` }] }))
		let images = 0
		global.fetch = jest.fn(async (url: any) => {
			if (new URL(String(url)).pathname.startsWith('/wp-json/')) return new Response(JSON.stringify(items))
			images++
			return new Response(png)
		}) as any
		const { svc, db } = setup({ products: items.map((p) => ({ _id: 'p' + p.id, litnaId: p.id })) })
		db.photoBase = PHOTO_QUOTA - png.length + 1
		await svc.seedPhotos('64a0000000000000000000c1')
		expect(db.photos).toHaveLength(0)
		expect(db.photoSet).toHaveLength(0)
		expect(images).toBeLessThanOrEqual(3)
	})

	it('сбой фоновой части сервер не роняет', async () => {
		const { svc } = setup()
		;(svc as any).productModel.find = () => {
			throw new Error('база недоступна')
		}
		await expect(svc.seedPhotos('64a0000000000000000000c1')).resolves.toBeUndefined()
	})
})

describe('заказ на сайте отменён или его нет — закупка снова черновик', () => {
	const placed = { _id: 'o1', purchase: 'pu1', orderId: 501, orderKey: 'wc_order_K', login: 'na@example.org', expected: 3625, startedAt: Date.now(), info: { orderId: 501, status: 'pending', total: 3625 }, lines: [] }
	const created = { isCreated: true, purchaseNumber: 31, litna: { orderId: 501, status: 'pending', total: 3625 }, items: [{ product: P1, quantity: 2, confirmedQuantity: 0, price: 1000 }] }
	const withOrder = (over: Partial<SiteOrder> = {}) => {
		const site = fakeSite()
		site.orders.set(501, { key: 'wc_order_K', status: 'pending', paid: false, total: 362500, ...over })
		return site
	}

	it('оплата: отменён — 409 ORDER_CANCELLED с закупкой-черновиком; запись заказа закрыта, в историю', async () => {
		withOrder({ status: 'cancelled' })
		const { svc, db } = setup({ placed, purchase: created })
		const err: any = await svc.pay('pu1', USER).catch((e) => e)
		expect(err.status).toBe(409)
		expect(err.response).toMatchObject({ code: 'ORDER_CANCELLED', message: 'Заказ №501 отменён на lit-na.ru — закупка переведена в черновик', purchase: { isCreated: false } })
		expect(err.response.purchase).not.toHaveProperty('litna')
		expect(db.drafted).toBe('Заказ №501 отменён на lit-na.ru — закупка №31 переведена в черновик')
		expect(db.placed).toMatchObject({ deletedAt: expect.any(Date), deletedBy: 'u1' })
	})

	it('проверка: заказа с таким ключом нет — с первого раза не черновик (сбой сайта), повтор через 5 минут — черновик', async () => {
		withOrder({ key: 'wc_order_OTHER' })
		const { svc, db, purchases } = setup({ placed, purchase: created })
		expect(await svc.check('pu1', USER)).toMatchObject({ paid: false, status: 'pending', purchase: { isCreated: true } })
		expect(db.placed.missingAt).toEqual(expect.any(Number))
		expect(purchases.toDraft).not.toHaveBeenCalled()
		// оплата при таком ответе — отказ «повторите позже», не черновик
		await expect(svc.pay('pu1', USER)).rejects.toThrow('lit-na.ru не нашёл заказ №501 — повторите позже')
		db.placed.missingAt -= 6 * 60_000
		;(svc as any).statusMemo.clear()
		expect(await svc.check('pu1', USER)).toMatchObject({ paid: false, status: 'cancelled', reverted: true, message: 'Заказ №501 отменён на lit-na.ru — закупка переведена в черновик', purchase: { isCreated: false } })
	})

	it('гонка: форму оплаты выдали, пока шёл возврат — возврат не делает ничего; выдача после возврата — ORDER_CANCELLED', async () => {
		withOrder({ status: 'cancelled' })
		const fresh = setup({ placed: { ...placed, payAt: Date.now() - 60_000 }, purchase: created })
		// запись обновилась другой выдачей формы уже после того, как её прочитали
		expect(await (fresh.svc as any).revert(fresh.db.purchase, { ...placed }, USER)).toBeNull()
		expect(fresh.purchases.toDraft).not.toHaveBeenCalled()
		expect(fresh.db.placed.deletedAt).toBeFalsy()

		withOrder()
		const closed = setup({ placed, purchase: created })
		const pay = (closed.svc as any).payPlaced.bind(closed.svc)
		closed.db.placed.deletedAt = new Date()
		// placed() найдёт запись до её закрытия — подставляем прочитанное раньше
		;(closed.svc as any).placed = async () => ({ purchase: closed.db.purchase, placed: { ...placed } })
		const err: any = await pay('pu1', 'robokassa', USER).catch((e: any) => e)
		expect(err.response).toMatchObject({ code: 'ORDER_CANCELLED' })
	})

	it('возврат не удался (закупку успели принять) — запись заказа снова открыта', async () => {
		withOrder({ status: 'cancelled' })
		const ctx = setup({ placed, purchase: { ...created, items: [{ product: P1, quantity: 2, confirmedQuantity: 1 }] } })
		expect(await (ctx.svc as any).revert(created, { ...placed }, USER)).toBeNull()
		expect(ctx.db.placed.deletedAt).toBeNull()
	})

	it('проверка: отменён, но форму оплаты выдавали меньше 30 минут назад — не черновик; позже — черновик', async () => {
		withOrder({ status: 'cancelled' })
		const ctx = setup({ placed: { ...placed, payAt: Date.now() - 10 * 60_000 }, purchase: created })
		expect(await ctx.svc.check('pu1', USER)).toMatchObject({ status: 'cancelled' })
		expect(ctx.db.purchase.isCreated).toBe(true)
		expect(ctx.db.purchase.litna.status).toBe('cancelled')
		ctx.db.placed.payAt -= 25 * 60_000
		expect(await ctx.svc.check('pu1', USER)).toMatchObject({ reverted: true })
	})

	it('оплаченную или с принятым не трогаем', async () => {
		withOrder({ status: 'cancelled' })
		const accepted = setup({ placed, purchase: { ...created, items: [{ product: P1, quantity: 2, confirmedQuantity: 1 }] } })
		const res: any = await accepted.svc.check('pu1', USER)
		expect(res.reverted).toBeUndefined()
		expect(accepted.db.placed.deletedAt).toBeFalsy()
		const paid = setup({ placed, purchase: { ...created, isPaid: true } })
		expect(await paid.svc.check('pu1', USER)).toMatchObject({ paid: true })
		expect(paid.purchases.toDraft).not.toHaveBeenCalled()
	})

	it('сайт недоступен или ответ непонятен — 502, закупка не меняется', async () => {
		withOrder({ status: 'cancelled' })
		global.fetch = jest.fn(async () => new Response('<html>заглушка</html>')) as any
		const { svc, db, purchases } = setup({ placed, purchase: created })
		expect((await svc.check('pu1', USER).catch((e) => e)).status).toBe(502)
		expect((await svc.pay('pu1', USER).catch((e) => e)).status).toBe(502)
		expect(purchases.toDraft).not.toHaveBeenCalled()
		expect(db.purchase.isCreated).toBe(true)
	})
})

describe('права, отказы и одновременные действия', () => {
	const placed = { _id: 'o1', purchase: 'pu1', company: 'c1', orderId: 501, orderKey: 'wc_order_K', login: 'na@example.org', expected: 3625, startedAt: Date.now(), info: { orderId: 501, status: 'pending', total: 3625 }, lines: [] }
	const created = { isCreated: true, purchaseNumber: 31, litna: { orderId: 501, status: 'pending', total: 3625 }, items: [] }

	it('неудача миниатюры запоминается на минуту: повторный запрос на сайт не идёт', async () => {
		const site = fakeSite()
		const { svc } = setup()
		await expect(svc.thumb(12)).rejects.toThrow('нет картинки')
		const asked = site.calls.length
		await expect(svc.thumb(12)).rejects.toThrow('нет картинки')
		expect(site.calls.length).toBe(asked)
	})

	it('пункты CDEK по городу — в памяти 10 минут', async () => {
		const site = fakeSite()
		const { svc } = setup()
		await svc.points('cdek', 'Саратов')
		const asked = site.calls.length
		expect(await svc.points('cdek', ' саратов ')).toHaveLength(1)
		expect(site.calls.length).toBe(asked)
	})

	it('события обновления закупок: привязка заказа, снятие, смена статуса, вход и выход', async () => {
		let site = fakeSite()
		let ctx = setup()
		await ctx.svc.order('pu1', 3625, USER)
		expect(ctx.db.emitted).toContainEqual(['c1', 'purchase-updated'])
		ctx = setup()
		await ctx.svc.logout(USER)
		await ctx.svc.login({ login: 'na@example.org', password: 'secret' }, USER)
		expect(ctx.db.emitted.filter(([, t]: any) => t === 'purchase-updated')).toHaveLength(2)
		site = fakeSite()
		site.orders.set(501, { key: 'wc_order_K', status: 'on-hold', paid: false, total: 362500 })
		ctx = setup({ placed, purchase: created })
		await ctx.svc.check('pu1', USER)
		expect(ctx.db.emitted).toContainEqual(['c1', 'purchase-updated'])
	})

	it('PUT аккаунта: почта и телефон без пробелов по краям', async () => {
		fakeSite()
		const { svc, db } = setup()
		await svc.saveAccount({ email: '  na@example.org ', phone: ' +7 900 ', firstName: ' Иван ' } as any, USER)
		expect(db.accountUpdate[1].$set).toEqual({ email: 'na@example.org', phone: '+7 900', firstName: ' Иван ' })
	})

	it('поздняя оплата закрытого заказа: фоном раз в 30 минут; оплачен — история с push и отметка, закупку не трогаем', async () => {
		const site = fakeSite()
		site.orders.set(501, { key: 'wc_order_K', status: 'processing', paid: true, total: 362500 })
		site.orders.set(502, { key: 'wc_order_502', status: 'cancelled', paid: false, total: 100 })
		const records = [
			{ _id: 'o1', company: 'c1', purchase: 'pu1', orderId: 501, orderKey: 'wc_order_K', payAt: Date.now() - 3600_000, deletedAt: new Date() },
			{ _id: 'o2', company: 'c1', purchase: 'pu2', orderId: 502, orderKey: 'wc_order_502', payAt: Date.now() - 3600_000, deletedAt: new Date() },
		]
		const { svc, db, purchases } = setup()
		const marked: any[] = []
		const om = (svc as any).orderModel
		om.find = (f: any) => ((db.lateFilter = f), { setOptions: () => ({ sort: () => ({ limit: (n: number) => ((db.lateLimit = n), { lean: () => ({ exec: async () => records }) }) }) }) })
		om.updateOne = (f: any, u: any) => ({ setOptions: () => ({ exec: async () => (marked.push([f, u]), { modifiedCount: 1 }) }) })
		const asked: any[] = []
		om.updateMany = (f: any, u: any) => ({ setOptions: () => ({ exec: async () => asked.push([f, u]) }) })
		;(svc as any).purchaseModel.findById = () => ({ setOptions: () => ({ lean: () => ({ exec: async () => ({ purchaseNumber: 31 }) }) }) })
		await svc.lateCheck()
		expect(db.lateFilter).toMatchObject({ deletedAt: { $ne: null }, orderId: { $type: 'number' }, $or: [{ payAt: { $gte: expect.any(Number) } }, expect.anything()], paidLateAt: null })
		expect(db.lateLimit).toBe(20)
		// очередь по кругу: спрошенные получают отметку и уходят в конец
		expect(asked).toEqual([[{ _id: { $in: ['o1', 'o2'] } }, { lateAt: expect.any(Number) }]])
		expect(marked).toEqual([[{ _id: 'o1', paidLateAt: null }, { paidLateAt: expect.any(Number) }]])
		expect(db.history).toEqual([expect.objectContaining({ company: 'c1', changeType: 'litna-paid-after-cancel', description: 'Заказ №501 на lit-na.ru оплачен после отмены — проверьте закупку №31' })])
		expect(db.history[0].opts).toBeUndefined()
		expect(purchases.update).not.toHaveBeenCalled()
		// сайт лежит — молча до следующего раза
		global.fetch = jest.fn(async () => {
			throw new TypeError('fetch failed')
		}) as any
		await expect(svc.lateCheck()).resolves.toBeUndefined()
	})

	const withOrders = (orders: [number, Partial<SiteOrder>][] = []) => {
		const site = fakeSite()
		for (const [id, o] of orders) site.orders.set(id, { key: `wc_order_${id}`, status: 'pending', paid: false, total: 100, note: '', ...o })
		return site
	}
	const detached = (cancelled: boolean) =>
		`Закупка №31 отвязана от заказа №501 lit-na.ru вручную; заказ на сайте ${cancelled ? 'отменён' : 'не отменён — сайт недоступен'}`

	it('без галочки «Служащий» — только свои закупки: чужую не рассчитать, не заказать, не оплатить, не отвязать, не удалить; проверка оплаты открыта', async () => {
		const other = { ...USER, _id: 'u2', isAdmin: false }
		const owner = { ...USER, isAdmin: false }
		const text = 'Чужую закупку меняет только служащий'
		const site = withOrders([[501, { key: 'wc_order_K', total: 362500 }]])
		const draft = () => setup({ purchase: { user: 'u1' } })
		await expect(draft().svc.quote('pu1', other)).rejects.toThrow(text)
		await expect(draft().svc.order('pu1', 3625, other)).rejects.toThrow(text)
		expect(await draft().svc.quote('pu1', owner)).toHaveProperty('lines')
		const ordered = () => setup({ placed, purchase: { ...created, user: 'u1' } })
		for (const run of [(x: any) => x.svc.pay('pu1', other), (x: any) => x.svc.detach('pu1', other), (x: any) => x.svc.remove('pu1', other)]) {
			const ctx = ordered()
			await expect(run(ctx)).rejects.toThrow(text)
			expect(ctx.db.history).toEqual([])
		}
		expect(site.orders.get(501).status).toBe('pending')
		expect(await ordered().svc.check('pu1', other)).toMatchObject({ paid: false })
		expect(await ordered().svc.pay('pu1', owner)).toHaveProperty('action')
	})

	it('отвязка: ждёт оплаты — отменяется ссылкой из кабинета, после подтверждения «отменён»; запись закрыта, в историю с push', async () => {
		const site = withOrders([[501, { key: 'wc_order_K', total: 362500 }]])
		const { svc, db } = setup({ placed, purchase: created })
		const res: any = await svc.detach('pu1', USER)
		expect(res).toEqual({ purchase: expect.objectContaining({ isCreated: true }), cancelled: true })
		expect(res.purchase.litna).toBeUndefined()
		expect(site.orders.get(501).status).toBe('cancelled')
		expect(site.calls.some((c) => c.path.startsWith('/cart/?cancel_order=true'))).toBe(true)
		expect(db.placed).toMatchObject({ deletedAt: expect.any(Date), deletedBy: 'u1' })
		expect(db.placed.detachedAt).toBeUndefined()
		expect(db.history).toEqual([expect.objectContaining({ changeType: 'litna-detached', description: detached(true) })])
		expect(db.history[0].opts).toBeUndefined()
		await expect(setup({ placed, purchase: { ...created, isPaid: true } }).svc.detach('pu1', USER)).rejects.toThrow('уже оплачена')
		await expect(setup({ placed, purchase: { isCreated: true } }).svc.detach('pu1', USER)).rejects.toThrow('не связана')
	})

	it('отвязка: уже отменён или заказа нет — отменять нечего, просто отвязать', async () => {
		for (const orders of [[[501, { key: 'wc_order_K', status: 'cancelled' }]], []] as [number, Partial<SiteOrder>][][]) {
			const site = withOrders(orders)
			const { svc, db } = setup({ placed, purchase: created })
			expect(await svc.detach('pu1', USER)).toMatchObject({ cancelled: true })
			expect(site.calls.some((c) => c.path.includes('cancel_order') || c.path.startsWith('/my-account/'))).toBe(false)
			expect(db.history[0].description).toBe(detached(true))
		}
	})

	it('отвязка: оплачен на сайте — нельзя, закупка отмечается оплаченной', async () => {
		withOrders([[501, { key: 'wc_order_K', status: 'processing', paid: true, total: 362500 }]])
		const { svc, db, purchases } = setup({ placed, purchase: created })
		const err: any = await svc.detach('pu1', USER).catch((e) => e)
		expect([err.status, err.message]).toEqual([400, 'Заказ №501 уже оплачен на lit-na.ru'])
		expect(purchases.update).toHaveBeenCalledWith('pu1', { isPaid: true }, USER, true)
		expect(db.purchase.litna).toMatchObject({ orderId: 501, status: 'processing' })
		expect(db.placed.deletedAt).toBeFalsy()
		expect(db.history.some((h: any) => h.changeType === 'litna-detached')).toBe(false)
	})

	it('отвязка и оплата одной закупки не идут одновременно: кто начал вторым — 400; заказа на сайте нет — запись остаётся под поздней проверкой', async () => {
		withOrders([[501, { key: 'wc_order_K', total: 362500 }]])
		const { svc } = setup({ placed, purchase: created })
		// форма оплаты уже выдаётся — отвязка и удаление ждут
		const paying = svc.pay('pu1', USER)
		await expect(svc.detach('pu1', USER)).rejects.toThrow('открывают оплату')
		await expect(svc.remove('pu1', USER)).rejects.toThrow('открывают оплату')
		await paying
		// отвязка уже идёт — форму оплаты не выдаём
		const other = setup({ placed, purchase: created })
		const detaching = other.svc.detach('pu1', USER)
		await expect(other.svc.pay('PU1', USER)).rejects.toThrow('отвязывают или удаляют')
		await detaching
		expect((other.svc as any).closing.size + (svc as any).paying.size).toBe(0)
		// «заказа нет» мог быть сбоем сайта: отвязали, но запись помечена для поздней проверки оплаты
		withOrders([])
		const gone = setup({ placed, purchase: created })
		expect(await gone.svc.detach('pu1', USER)).toMatchObject({ cancelled: true })
		expect(gone.db.placed).toMatchObject({ deletedAt: expect.any(Date), detachedAt: expect.any(Number) })
	})

	it('отвязка: сайт ответил, но отменить не вышло — 400, закупка не отвязывается', async () => {
		const site = withOrders([[501, { key: 'wc_order_K', total: 362500 }]])
		site.cancelWorks = false
		const { svc, db } = setup({ placed, purchase: created })
		const err: any = await svc.detach('pu1', USER).catch((e) => e)
		expect([err.status, err.message]).toEqual([400, 'Не удалось отменить заказ №501 на lit-na.ru — отмените его в кабинете сайта'])
		expect(db.purchase.litna).toBeDefined()
		expect(db.placed.deletedAt).toBeFalsy()
		expect(db.history).toEqual([])
	})

	it('отвязка: сайт недоступен (сеть или 5xx при отмене) — отвязывается без отмены, поздняя оплата проверяется трое суток', async () => {
		global.fetch = jest.fn(async () => {
			throw new TypeError('fetch failed')
		}) as any
		const offline = setup({ placed, purchase: created })
		expect(await offline.svc.detach('pu1', USER)).toMatchObject({ cancelled: false })
		expect(offline.db.purchase.litna).toBeUndefined()
		expect(offline.db.placed).toMatchObject({ deletedAt: expect.any(Date), detachedAt: expect.any(Number) })
		expect(offline.db.history).toEqual([expect.objectContaining({ changeType: 'litna-detached', description: detached(false) })])
		// статус сайт сказал, а кабинет отвечает 503
		const site = withOrders([[501, { key: 'wc_order_K', total: 362500 }]])
		site.down = true
		const half = setup({ placed, purchase: created })
		expect(await half.svc.detach('pu1', USER)).toMatchObject({ cancelled: false })
		expect(site.orders.get(501).status).toBe('pending')
		expect(half.db.history[0].description).toBe(detached(false))
	})

	it('отвязка: 30 минут после выдачи формы оплаты — нельзя (оплата могла начаться), на сайт не ходим', async () => {
		const site = withOrders([[501, { key: 'wc_order_K', total: 362500 }]])
		const { svc, db } = setup({ placed: { ...placed, payAt: Date.now() - 5 * 60_000 }, purchase: created })
		await expect(svc.detach('pu1', USER)).rejects.toThrow('Оплата могла начаться — отвязать можно через 25 мин')
		expect(site.calls).toEqual([])
		expect(db.purchase.litna).toBeDefined()
	})

	it('отвязка гостевого заказа: отмена со страницы «заказ получен» с подтверждением почты', async () => {
		const site = withOrders([[501, { key: 'wc_order_K', total: 362500, guest: true, email: 'zakaz@example.org' }]])
		site.askEmail = true
		const guest = { ...placed, guest: true, login: null, email: 'zakaz@example.org' }
		const { svc } = setup({ account: { login: '', password: '' }, placed: guest, purchase: created })
		expect(await svc.detach('pu1', USER)).toMatchObject({ cancelled: true })
		expect(site.orders.get(501).status).toBe('cancelled')
		const verify = site.calls.find((c) => c.method === 'POST' && c.path.startsWith('/checkout/order-received/501/'))
		expect(new URLSearchParams(verify.body).get('email')).toBe('zakaz@example.org')
		expect(site.calls.some((c) => c.who === 'account')).toBe(false)
	})

	it('поздняя оплата: и записи, отвязанные без отмены, — трое суток от отвязки', async () => {
		const { svc, db } = setup()
		;(svc as any).orderModel.find = (f: any) => ((db.lateFilter = f), { setOptions: () => ({ sort: () => ({ limit: () => ({ lean: () => ({ exec: async () => [] }) }) }) }) })
		await svc.lateCheck()
		expect(db.lateFilter.$or).toEqual([{ payAt: { $gte: expect.any(Number) } }, { detachedAt: { $gte: expect.any(Number) } }])
		expect(Date.now() - db.lateFilter.$or[1].detachedAt.$gte).toBeGreaterThanOrEqual(3 * 24 * 3600_000 - 1000)
	})

	it('отвязка — по праву редактировать закупки, галочка «Служащий» не нужна', () => {
		expect(Reflect.getMetadata('permissions', LitnaController.prototype.detach)).toEqual(['edit_purchases'])
		expect(Reflect.getMetadata('role', LitnaController.prototype.detach)).toBe('user')
		const ctrl = new LitnaController({ detach: () => 'ok' } as any)
		expect(ctrl.detach(P1, { _id: 'u', company: 'c1', role: { permissions: ['edit_purchases'] } } as any)).toBe('ok')
	})
})

describe('нагрузка на сайт', () => {
	const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)])

	it('частота запросов с одного адреса: вход 5, расчёт, пункты, картинка, документ, заказ и оплата 20, проверка 30 в минуту', () => {
		const limit = (m: keyof LitnaController) => [Reflect.getMetadata('THROTTLER:LIMITdefault', LitnaController.prototype[m]), Reflect.getMetadata('THROTTLER:TTLdefault', LitnaController.prototype[m])]
		expect(limit('login')).toEqual([5, 60_000])
		for (const m of ['quote', 'points', 'image', 'doc', 'order', 'pay'] as const) expect(limit(m)).toEqual([20, 60_000])
		expect(limit('check')).toEqual([30, 60_000])
	})

	it('расчёт того же состава — 30 секунд из памяти; другой состав или другая пара — заново', async () => {
		const site = fakeSite()
		const { svc, db } = setup()
		const first = await svc.quote('pu1', USER)
		const calls = site.calls.length
		expect(await svc.quote('pu1', USER)).toEqual(first)
		expect(site.calls.length).toBe(calls)
		for (const v of (svc as any).quotes.values()) v.at -= 30_000
		await svc.quote('pu1', USER)
		expect(site.calls.length).toBeGreaterThan(calls)
		const was = site.calls.length
		db.purchase.items[1].quantity = 1
		expect((await svc.quote('pu1', USER)).goods).toBe(2500)
		expect(site.calls.length).toBeGreaterThan(was)
		// пара сменилась — расчёт заново, а не прежний из памяти
		db.products[1].litnaId = 13
		expect((await svc.quote('pu1', USER)).lines.find((l: any) => l.product === P2).problem).toBe('stock')
	})

	it('пункты Яндекса не загрузились — минуту тот же ответ без похода на сайт', async () => {
		const site = fakeSite()
		site.pointsBroken = true
		const { svc } = setup()
		await expect(svc.points('yandex', 'Саратов')).rejects.toThrow()
		const calls = site.calls.length
		await expect(svc.points('yandex', 'Саратов')).rejects.toThrow()
		expect(site.calls.length).toBe(calls)
		site.pointsBroken = false
		;(svc as any).yandexFailed.at -= 60_000
		expect(await svc.points('yandex', 'Саратов')).toHaveLength(1)
	})

	it('миниатюра: сбой товара каталога — 10 минут без сайта; больше 200 КБ — сбой; неизвестный номер — 404, не запоминается', async () => {
		let big = true
		const images: string[] = []
		global.fetch = jest.fn(async (url: any) => {
			if (String(url).includes('/wp-json/')) return new Response(JSON.stringify([{ ...CATALOG[0], images: [{ src: 'https://lit-na.ru/u/a.png', thumbnail: 'https://lit-na.ru/u/a.png' }] }]))
			images.push(String(url))
			return new Response(big ? Buffer.concat([png, Buffer.alloc(200 * 1024)]) : png)
		}) as any
		const { svc } = setup()
		await expect(svc.thumb(11)).rejects.toThrow('не отвечает')
		big = false
		;(svc as any).thumbFailed.get(11).at -= 9 * 60_000
		await expect(svc.thumb(11)).rejects.toThrow('не отвечает')
		expect(images).toHaveLength(1)
		;(svc as any).thumbFailed.get(11).at -= 60_000
		expect((await svc.thumb(11)).bytes).toEqual(png)
		await expect(svc.thumb(999)).rejects.toThrow('не найден')
		expect((svc as any).thumbFailed.has(999)).toBe(false)
	})
})

describe('скорость: меньше запросов к сайту', () => {
	const calls = (site: ReturnType<typeof fakeSite>, from = 0) => site.calls.slice(from).map((c) => `${c.method} ${c.path}`)
	// фоновые запросы (очистка корзины) — дождаться

	it('заказ под аккаунтом после расчёта: без нового расчёта, корзина одним пакетом, граница — до сборки корзины, очистка — фоном', async () => {
		const site = fakeSite()
		const { svc, db } = setup()
		await svc.warm(USER)
		await svc.quote('pu1', USER)
		const from = site.calls.length
		await svc.order('pu1', 3625, USER)
		await idle()
		expect(calls(site, from).sort()).toEqual(
			[
				'GET /my-account/',
				'GET /my-account/orders/',
				'GET /wp-json/wc/store/v1/cart',
				// в корзине аккаунта был чужой товар — очистка до сборки; вторая — фоном после заказа
				'DELETE /wp-json/wc/store/v1/cart/items',
				'POST /wp-json/wc/store/v1/batch',
				'POST /?wc-ajax=official_cdek_save-office',
				'GET /checkout/',
				'POST /?wc-ajax=checkout',
				'GET /checkout/order-pay/501/?key=wc_order_K',
				'DELETE /wp-json/wc/store/v1/cart/items',
			].sort()
		)
		// очистка — последним запросом, после сверки суммы на странице оплаты: одновременный запрос вернул бы корзину назад
		expect(calls(site, from).slice(-2)).toEqual(['GET /checkout/order-pay/501/?key=wc_order_K', 'DELETE /wp-json/wc/store/v1/cart/items'])
		expect(site.calls.slice(from).every((c) => c.who === 'account')).toBe(true)
		expect(db.placed).toMatchObject({ orderId: 501, seen: 0 })
		expect(site.carts.account.size).toBe(0)
		expect(log).toHaveBeenCalledWith(expect.stringMatching(/^Заказ lit-na\.ru: \d+\.\d с, запросов к сайту — 10$/))
	})

	it('расчёт и выдача формы — в журнал с длительностью и числом запросов', async () => {
		const site = fakeSite()
		site.orders.set(501, { key: 'wc_order_K', status: 'pending', paid: false, total: 362500 })
		await setup().svc.quote('pu1', USER)
		// каталог, токен, пакет, страница оформления; и сверка адреса с кабинетом: вход (три запроса, без живой сессии) и страница «Адрес»
		expect(log).toHaveBeenCalledWith(expect.stringMatching(/^Расчёт lit-na\.ru: \d+\.\d с, запросов к сайту — 8$/))
		const placed = { _id: 'o1', purchase: 'pu1', orderId: 501, orderKey: 'wc_order_K', login: 'na@example.org', expected: 3625, startedAt: Date.now(), info: { orderId: 501, status: 'pending', total: 3625 }, lines: [] }
		await setup({ placed, purchase: { isCreated: true, litna: { orderId: 501, total: 3625 } } }).svc.pay('pu1', USER)
		// статус; страница оплаты аккаунта — вход и страница заново
		expect(log).toHaveBeenCalledWith(expect.stringMatching(/^Форма оплаты lit-na\.ru: \d+\.\d с, запросов к сайту — \d+$/))
		expect(JSON.stringify(log.mock.calls)).not.toMatch(/wc_order|https?:/)
	})

	it('заказ гостем после расчёта — в сессии расчёта: корзина не пересобирается', async () => {
		const site = fakeSite()
		const { svc, db } = setup({ account: { login: '', password: '' } })
		await svc.quote('pu1', USER)
		const quoted = site.calls.find((c) => c.path.endsWith('/batch')).cart
		const from = site.calls.length
		await svc.order('pu1', 3625, USER)
		expect(calls(site, from)).toEqual(['GET /checkout/', 'POST /?wc-ajax=official_cdek_save-office', 'POST /?wc-ajax=checkout', 'GET /checkout/order-pay/501/?key=wc_order_K'])
		// оформление — в сессии расчёта; страница оплаты — по ключу заказа
		expect(site.calls.slice(from, from + 3).every((c) => c.cart === quoted)).toBe(true)
		expect(db.placed).toMatchObject({ orderId: 501, guest: true })
		// расчёт по сессии забран: второй заказ в ней не оформить
		expect((svc as any).quotes.size).toBe(0)
	})

	it('гость без свежего расчёта — заказ в сессии только что сделанного расчёта', async () => {
		const site = fakeSite()
		await setup({ account: { login: '', password: '' } }).svc.order('pu1', 3625, USER)
		expect(site.calls.filter((c) => c.path.endsWith('/batch'))).toHaveLength(1)
		expect(checkouts(site)).toBe(1)
	})

	it('сессия расчёта умерла (корзина пуста) — корзина собирается заново в новой сессии', async () => {
		const site = fakeSite()
		const { svc, db } = setup({ account: { login: '', password: '' } })
		await svc.quote('pu1', USER)
		const quoted = site.calls.find((c) => c.path.endsWith('/batch')).cart
		site.carts[quoted].clear()
		await svc.order('pu1', 3625, USER)
		expect(site.calls.filter((c) => c.path.endsWith('/batch'))).toHaveLength(2)
		expect(site.calls.find((c) => c.path === '/?wc-ajax=checkout').cart).not.toBe(quoted)
		expect(db.placed).toMatchObject({ orderId: 501 })
	})

	it('расчёт устарел (30 с) — заказ считает заново', async () => {
		const site = fakeSite()
		const { svc } = setup()
		await svc.warm(USER)
		await svc.quote('pu1', USER)
		for (const v of (svc as any).quotes.values()) v.at -= 30_000
		const from = site.calls.length
		await svc.order('pu1', 3625, USER)
		expect(site.calls.slice(from).some((c) => c.who === 'guest' && c.path.endsWith('/batch'))).toBe(true)
	})

	it('намерение аккаунта без границы — форма не уходила: заказа нет, снимается без поиска по кабинету', async () => {
		const site = fakeSite()
		const intent = { _id: 'o1', purchase: 'pu1', code: 'K7Q2X9PM', login: 'na@example.org', seen: null, expected: 3625, startedAt: Date.now() - 10 * 60_000, info: { status: 'placing' }, lines: [] }
		const { svc, db } = setup({ placed: intent })
		site.morePages = true
		await svc.order('pu1', 3625, USER)
		expect(site.calls.some((c) => c.path.startsWith('/my-account/view-order/'))).toBe(false)
		expect(db.placed).toMatchObject({ orderId: 501 })
	})

	it('граница не прочиталась — форма не отправляется, намерение снимается', async () => {
		const site = fakeSite()
		site.ordersBroken = true
		const { svc, db } = setup()
		await expect(svc.order('pu1', 3625, USER)).rejects.toThrow('Не удалось открыть заказы на lit-na.ru')
		expect(checkouts(site)).toBe(0)
		expect(db.placed).toBeNull()
	})

	it('фоновая очистка корзины аккаунта — до следующей сборки корзины этой сессии', async () => {
		const s = new LitnaSession()
		const order: string[] = []
		global.fetch = jest.fn(async (url: any, init: any = {}) => {
			const path = new URL(String(url)).pathname
			order.push(`${init.method || 'GET'} ${path}`)
			if (init.method === 'DELETE') await new Promise((r) => setTimeout(r, 10))
			if (path.endsWith('/batch')) return new Response(JSON.stringify({ responses: [{ status: 201, body: {} }, { status: 200, body: { items: [] } }] }), { headers: [['Nonce', 'n']] })
			return new Response(JSON.stringify({ items: [] }), { headers: [['Nonce', 'n']] })
		}) as any
		s.clearLater()
		await s.fillCart([{ id: 11, quantity: 1 }], { city: 'Саратов' })
		expect(order).toEqual(['DELETE /wp-json/wc/store/v1/cart/items', 'GET /wp-json/wc/store/v1/cart', 'POST /wp-json/wc/store/v1/batch'])
	})

	it('пункты Яндекса заранее: фоном, одна попытка на 10 минут; окно пунктов — из памяти', async () => {
		const site = fakeSite()
		const { svc } = setup()
		svc.prewarmPoints()
		svc.prewarmPoints()
		await new Promise((r) => setTimeout(r, 50))
		const boxberry = () => site.calls.filter((c) => c.url.startsWith('https://points.boxberry.ru/')).length
		expect(boxberry()).toBe(1)
		const from = site.calls.length
		expect(await svc.points('yandex', 'Саратов')).toHaveLength(1)
		expect(site.calls.length).toBe(from)
		// не загрузилось — следующая попытка не раньше чем через 10 минут
		const down = setup()
		global.fetch = jest.fn(async () => {
			throw new TypeError('fetch failed')
		}) as any
		down.svc.prewarmPoints()
		await new Promise((r) => setTimeout(r, 20))
		const tried = (global.fetch as jest.Mock).mock.calls.length
		;(down.svc as any).yandexFailed = null
		down.svc.prewarmPoints()
		await new Promise((r) => setTimeout(r, 20))
		expect((global.fetch as jest.Mock).mock.calls.length).toBe(tried)
	})

	it('вход заранее под аккаунтом — без отдельной проверки сайта: вход сам её показывает', async () => {
		const site = fakeSite()
		expect(await setup().svc.warm(USER)).toMatchObject({ up: true })
		expect(site.calls.some((c) => c.path.includes('per_page=1'))).toBe(false)
	})
})
