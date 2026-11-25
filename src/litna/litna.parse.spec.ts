/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import {
	accountOrders,
	addResult,
	boxberryButton,
	cancelLink,
	cartPrices,
	cdekPoints,
	docLink,
	checkoutForm,
	checkoutResult,
	decode,
	inputValue,
	isCancelled,
	isLoggedIn,
	isSuccess,
	keepCookies,
	norm,
	notices,
	orderStatus,
	parseAddress,
	srcsetPick,
	orderText,
	pickRate,
	reviewHtml,
	verifyForm,
	seedKindCovers,
	siteSeed,
	SITE_KIND_COVERS,
	reviewNonce,
	robokassaForm,
	shippingRates,
	siteProduct,
	suggestPairs,
	yandexPoints,
} from './litna.parse'

// Образцы придуманы по устройству страниц сайта: настоящие страницы содержат почту и подписи платежа

const points = (chunks: string[]) => {
	const parser = yandexPoints()
	for (const c of chunks) parser.write(Buffer.from(c))
	return parser.end()
}

describe('разметка и формы', () => {
	it('сущности HTML: числовые, шестнадцатеричные и именованные', () => {
		expect(decode('Книга &#171;Текст&#187; &amp; &laquo;ещё&raquo; &#x2014;&nbsp;x &unknown;')).toBe('Книга «Текст» & «ещё» — x &unknown;')
		// недопустимый номер символа — как есть, а не падение
		expect(decode('a &#99999999; &#x110000; b')).toBe('a &#99999999; &#x110000; b')
	})

	it('форма оформления: все поля как у браузера — отмеченный способ, выбранный пункт списка, текст', () => {
		const html = `<div><input name="s" value="поиск"></div>
			<form name="checkout" method="post" class="checkout">
				<input type="text" class="input-text" value="Саратовская область" name="billing_state" />
				<input type="text" name="billing_first_name" value="Иван &amp; Ко" />
				<input type="radio" name="shipping_method[0]" value="official_cdek:139" checked='checked' />
				<input type="radio" name="shipping_method[0]" value="official_cdek:138" />
				<input type="checkbox" name="privacy_policy_checkbox" value="1" />
				<input type="hidden" id="woocommerce-process-checkout-nonce" name="woocommerce-process-checkout-nonce" value="abc123" />
				<select name="billing_country"><option value="KZ">Казахстан</option><option value="RU" selected="selected">Россия</option></select>
				<select name="doc_type"><option value="passport">Паспорт</option><option value="other">Другое</option></select>
				<textarea name="order_comments">строка</textarea>
			</form>`
		expect(checkoutForm(html)).toEqual({
			billing_state: 'Саратовская область',
			billing_first_name: 'Иван & Ко',
			'shipping_method[0]': 'official_cdek:139',
			'woocommerce-process-checkout-nonce': 'abc123',
			billing_country: 'RU',
			doc_type: 'passport',
			order_comments: 'строка',
		})
		expect(checkoutForm('<form name="login"></form>')).toBeNull()
	})

	it('форма «подтвердите почту заказа»: адрес и поля (без кнопки)', () => {
		const html = `<form name="checkout" method="post" class="woocommerce-form woocommerce-verify-email" action="https://lit-na.ru/checkout/order-received/501/?key=wc_order_K&#038;x=1">
			<input type="email" name="email" value="" /><input type="hidden" name="check_submission" value="n1" /><input type="hidden" name="_wp_http_referer" value="/checkout/order-received/501/" />
			<button type="submit" name="verify" value="1">Подтвердить</button></form>`
		expect(verifyForm(html)).toEqual({
			action: 'https://lit-na.ru/checkout/order-received/501/?key=wc_order_K&x=1',
			fields: { email: '', check_submission: 'n1', _wp_http_referer: '/checkout/order-received/501/' },
		})
		expect(verifyForm('<form name="checkout" class="checkout woocommerce-checkout"></form>')).toBeNull()
	})

	it('вход: ключ формы и признак входа', () => {
		const page = '<form class="login"><input type="hidden" id="woocommerce-login-nonce" name="woocommerce-login-nonce" value="9f00aa" /></form>'
		expect(inputValue(page, 'woocommerce-login-nonce')).toBe('9f00aa')
		expect(isLoggedIn(page)).toBe(false)
		expect(isLoggedIn('<a href="https://lit-na.ru/my-account/customer-logout/?_wpnonce=1">Выйти</a>')).toBe(true)
	})

	it('форма Robokassa: адрес и поля как есть (теги без закрывающей черты, значения со сущностями)', () => {
		const html = `<form class="search" action="/"><input name="s" value=""></form>
			<form action="https://auth.robokassa.ru/Merchant/Index.aspx" method="POST" id="robokassa-payment-form-1">
				<input type="hidden" name="MrchLogin" value="shop">
				<input type="hidden" name="OutSum" value="3450.00">
				<input type="hidden" name="InvId" value="10">
				<input type="hidden" name="Receipt" value="{&quot;items&quot;:[]}">
				<input type="hidden" name="SignatureValue" value="sig">
			</form>`
		expect(robokassaForm(html)).toEqual({
			action: 'https://auth.robokassa.ru/Merchant/Index.aspx',
			fields: { MrchLogin: 'shop', OutSum: '3450.00', InvId: '10', Receipt: '{"items":[]}', SignatureValue: 'sig' },
		})
		expect(robokassaForm('<form action="https://evil.example/"></form>')).toBeNull()
	})

	it('отмена: ссылка именно этого заказа из списка', () => {
		const html = `<a href="https://lit-na.ru/cart/?cancel_order=true&#038;order=wc_order_A&#038;order_id=1001&#038;_wpnonce=x" class="button cancel">Отмена</a>
			<a href="https://lit-na.ru/cart/?cancel_order=true&#038;order=wc_order_B&#038;order_id=100&#038;_wpnonce=y" class="button cancel">Отмена</a>`
		expect(cancelLink(html, 100)).toBe('https://lit-na.ru/cart/?cancel_order=true&order=wc_order_B&order_id=100&_wpnonce=y')
		expect(cancelLink(html, 10)).toBeNull()
		expect(cancelLink('<a href="https://evil.example/cart/?cancel_order=true&#038;order_id=100">x</a>', 100)).toBeNull()
	})

	it('список заказов кабинета: номер, статус, сумма, ключ из ссылки оплаты; неразобранная страница — null', () => {
		const shell = (inner: string, logged = true) =>
			`<html>${logged ? '<a href="/my-account/customer-logout/">Выйти</a>' : ''}<div class="woocommerce-MyAccount-content wd-grid-col">${inner}</div></html>`
		const table = `<table class="woocommerce-orders-table woocommerce-MyAccount-orders shop_table"><thead><tr><th>Заказ</th></tr></thead><tbody>
			<tr class="woocommerce-orders-table__row woocommerce-orders-table__row--status-pending order">
				<th class="woocommerce-orders-table__cell-order-number"><a href="https://lit-na.ru/my-account/view-order/501/">№501</a></th>
				<td class="woocommerce-orders-table__cell-order-date"><time datetime="2026-11-24T18:37:24+00:00">24.11.2026</time></td>
				<td class="woocommerce-orders-table__cell woocommerce-orders-table__cell-order-total" data-title="Итого">
					<span class="woocommerce-Price-amount amount"><bdi>5,750.00&nbsp;<span>&#8381;</span></bdi></span> за 31 товар</td>
				<td><a href="https://lit-na.ru/checkout/order-pay/501/?pay_for_order=true&#038;key=wc_order_Ab1" class="button pay">Оплатить</a></td>
			</tr>
			<tr class="woocommerce-orders-table__row woocommerce-orders-table__row--status-cancelled order">
				<th><a href="https://lit-na.ru/my-account/view-order/400/">№400</a></th>
				<td class="woocommerce-orders-table__cell-order-total"><bdi>950.00</bdi></td>
			</tr>
		</tbody></table>`
		expect(accountOrders(shell(table))).toEqual({
			orders: [
				{ orderId: 501, status: 'pending', total: 5750, orderKey: 'wc_order_Ab1' },
				{ orderId: 400, status: 'cancelled', total: 950, orderKey: null },
			],
			more: false,
		})
		expect(accountOrders(shell(table + '<a class="woocommerce-button woocommerce-button--next button" href="/my-account/orders/2/">Далее</a>')).more).toBe(true)
		// не вошли, разметка сменилась — верить нельзя; «заказов нет» — доказанно пусто
		expect(accountOrders(shell(table, false))).toBeNull()
		expect(accountOrders(shell('<p>новая страница</p>'))).toBeNull()
		expect(accountOrders(shell(table.replace('--status-cancelled', '')))).toBeNull()
		expect(accountOrders(shell('<div class="woocommerce-message woocommerce-info">Заказов пока нет. <a href="/shop/">В магазин</a></div>'))).toEqual({ orders: [], more: false })
		expect(accountOrders(shell('<div class="woocommerce-info">No order has been made yet.</div>'))).toEqual({ orders: [], more: false })
		expect(accountOrders(shell('<p>Заказов ещё не создано. <a href="/shop/">Просмотр товаров</a></p>'))).toEqual({ orders: [], more: false })
		expect(accountOrders(shell('<div class="woocommerce-info">В вашей учётной записи используется временный пароль</div>'))).toBeNull()
	})

	it('страница заказа: текст таблицы заказа (с примечанием под любой подписью); не страница заказа или не вошли — null', () => {
		const page = (inner: string, logged = true) =>
			`<html>${logged ? '<a href="/my-account/customer-logout/">Выйти</a>' : ''}<table class="woocommerce-table woocommerce-table--order-details shop_table order_details"><tfoot>${inner}</tfoot></table></html>`
		expect(orderText(page('<tr><th scope="row">Итого:</th><td>5,750.00</td></tr><tr> <th>Примечание покупателя:</th> <td> K7Q2X9PM · Skladan · закупка №31 </td> </tr>'))).toContain('K7Q2X9PM')
		expect(orderText(page('<tr><th>Примечание:</th><td>x</td></tr>', false))).toBeNull()
		expect(orderText('<html><a href="/my-account/customer-logout/">Выйти</a><p>Заказ не найден</p></html>')).toBeNull()
		// класс таблицы встречается и в стилях страницы — это не страница заказа
		expect(orderText('<html><a href="/my-account/customer-logout/">Выйти</a><style>.woocommerce-table--order-details th{}</style></html>')).toBeNull()
	})

	it('«отменён» — cancelled, refunded, trash; failed — нет (его оплачивают заново)', () => {
		expect(['cancelled', 'refunded', 'trash', 'failed', 'pending'].map(isCancelled)).toEqual([true, true, true, false, false])
	})

	it('документ заказа: ссылка этого заказа с ключом доступа, вид документа подставляется; чужой адрес и чужой заказ — нет', () => {
		const html = `<a href="https://lit-na.ru/wp-admin/admin-ajax.php?action=generate_wpo_wcpdf&#038;document_type=invoice&#038;order_ids=400&#038;access_key=k400&#038;my-account=true">Счет</a>
			<a href="https://lit-na.ru/wp-admin/admin-ajax.php?action=generate_wpo_wcpdf&#038;document_type=invoice&#038;order_ids=501&#038;access_key=k501&#038;my-account=true" class="button invoice">Счет</a>`
		expect(docLink(html, 501, 'packing-slip')).toBe('https://lit-na.ru/wp-admin/admin-ajax.php?action=generate_wpo_wcpdf&document_type=packing-slip&order_ids=501&access_key=k501&my-account=true')
		expect(docLink(html, 501, 'invoice')).toContain('document_type=invoice&order_ids=501')
		expect(docLink(html, 13, 'invoice')).toBeNull()
		expect(docLink('<a href="https://evil.example/wp-admin/admin-ajax.php?action=generate_wpo_wcpdf&#038;order_ids=501&#038;access_key=k">x</a>', 501, 'invoice')).toBeNull()
		expect(docLink('<a href="https://lit-na.ru/wp-admin/admin-ajax.php?action=generate_wpo_wcpdf&#038;order_ids=501">x</a>', 501, 'invoice')).toBeNull()
	})

	it('уведомления WooCommerce текстом: ошибки, сведения, сообщения — без повторов', () => {
		expect(notices('<div class="woocommerce-info">Минимум 3,000.00&nbsp;₽</div><ul class="woocommerce-error"><li>Мало</li></ul><div class="woocommerce-info">Минимум 3,000.00 ₽</div>')).toBe('Минимум 3,000.00 ₽ Мало')
	})

	it('ошибки WooCommerce текстом', () => {
		expect(notices('<ul class="woocommerce-error" role="alert"><li> Поле <strong>Телефон</strong> обязательно </li></ul>')).toBe('Поле Телефон обязательно')
	})

	it('2 МБ незакрытых тегов разбираются быстро в каждой функции', () => {
		const mb2 = (s: string) => s.repeat(Math.ceil((2 << 20) / s.length))
		const logged = '<a class="woocommerce-MyAccount-navigation-link--customer-logout"></a><div class="woocommerce-MyAccount-content">'
		const cases: [string, () => unknown][] = [
			['notices', () => notices(mb2('<div class="woocommerce-error"><ul class="woocommerce-info"><li>x'))],
			['notices <', () => notices('<div class="woocommerce-error">' + mb2('<') + '</div>')],
			['checkoutForm', () => checkoutForm(mb2('<form name="checkout"><input name="a" value="b">'))],
			['verifyForm', () => verifyForm(mb2('<form class="woocommerce-verify-email" action="x">'))],
			['robokassaForm', () => robokassaForm(mb2('<form action="https://auth.robokassa.ru/x">'))],
			['formFields', () => checkoutForm('<form name="checkout">' + mb2('<select name="a"><option value="1"><textarea name="b">') + '</form>')],
			['inputValue', () => inputValue(mb2('<input name="a" value="b" '), 'b')],
			['boxberryButton', () => boxberryButton(mb2('<a class="bxbbutton" '))],
			['docLink', () => docLink(mb2('<a href="https://lit-na.ru/?action=generate_wpo_wcpdf&order_ids=1'), 1, 'invoice')],
			['cancelLink', () => cancelLink(mb2('<a href="https://lit-na.ru/?cancel_order=true&order_id=1 '), 1)],
			['accountOrders', () => accountOrders(logged + mb2('<table class="woocommerce-orders-table"><tr class="woocommerce-orders-table__row"><td class="cell-order-total">'))],
			['accountOrders tr', () => accountOrders(logged + '<table class="woocommerce-orders-table">' + mb2('<tr class="woocommerce-orders-table__row"><td>') + '</table>')],
			['accountOrders class', () => accountOrders(logged.replace('<div class="woocommerce-MyAccount-content">', '') + mb2('woocommerce-MyAccount-content '))],
			['orderText', () => orderText(logged + mb2('<table class="woocommerce-table--order-details"><tr><td>'))],
		]
		// лучший из трёх прогонов: сборка мусора и соседние наборы тестов не должны делать проверку случайной,
		// а квадратичный разбор медленный в каждом прогоне (на таких страницах — десятки секунд)
		const slow = cases
			.map(([name, run]) => {
				const times = [0, 1, 2].map(() => {
					const started = performance.now()
					run()
					return performance.now() - started
				})
				return [name, Math.round(Math.min(...times))] as const
			})
			.filter(([, ms]) => ms >= 200)
		expect(slow).toEqual([])
		expect(checkoutForm(mb2('<form name="checkout"><input name="a" value="b">'))).toBeNull()
		expect(notices(mb2('<div class="woocommerce-error"><li>x'))).toBe('')
	})
})

describe('ответы сайта', () => {
	it('оформление: номер и ключ заказа из ответа; ошибка — текстом сообщений', () => {
		expect(checkoutResult('{"result":"success","redirect":"https:\\/\\/lit-na.ru\\/checkout\\/order-pay\\/77\\/?key=wc_order_Ab1","order_id":77}')).toEqual({ orderId: 77, orderKey: 'wc_order_Ab1' })
		expect(checkoutResult('{"result":"failure","messages":"<ul class=\\"woocommerce-error\\"><li>Нет в наличии<\\/li><\\/ul>"}')).toEqual({ error: 'Нет в наличии' })
		// заказ мог появиться: не «сайт не принял», а «неизвестно»
		expect(checkoutResult('<html>заглушка</html>')).toHaveProperty('unknown')
		expect(checkoutResult('{"result":"success","redirect":"https:\\/\\/lit-na.ru\\/checkout\\/order-received\\/77\\/","order_id":77}')).toEqual({ unknown: 'сайт оформил заказ, но не вернул его ключ' })
		expect(checkoutResult('{"result":"success","redirect":"https:\\/\\/evil.example\\/order-pay\\/77\\/?key=wc_order_X","order_id":77}')).toHaveProperty('unknown')
	})

	it('статус оплаты: оплачен — только paid и «в обработке»/«выполнен»; заглушка, «0» и не success — null', () => {
		expect(orderStatus('{"success":true,"data":{"paid":false,"status":"pending"}}')).toEqual({ paid: false, status: 'pending' })
		expect(orderStatus('{"success":true,"data":{"paid":true,"status":"processing"}}')).toEqual({ paid: true, status: 'processing' })
		expect(orderStatus('{"success":true,"data":{"paid":true,"status":"completed"}}')).toEqual({ paid: true, status: 'completed' })
		// «Доставка» — свой статус магазина (заказ отправлен): оплачен, даже если сайт paid для него не поставил
		expect(orderStatus('{"success":true,"data":{"paid":false,"status":"delivery"}}')).toEqual({ paid: true, status: 'delivery' })
		expect(orderStatus('{"success":true,"data":{"paid":true,"status":"delivery"}}')).toEqual({ paid: true, status: 'delivery' })
		expect(orderStatus('{"success":true,"data":{"paid":true,"status":"pending"}}')).toEqual({ paid: false, status: 'pending' })
		expect(orderStatus('{"success":false,"data":{"paid":true,"status":"processing"}}')).toBeNull()
		// заказа с таким ключом нет — как отменённый
		expect(orderStatus('{"success":false,"data":{"message":"invalid_order"}}')).toEqual({ paid: false, status: 'cancelled', missing: true })
		expect(orderStatus("<html><script>document.cookie='beget=begetok'</script></html>")).toBeNull()
		expect(orderStatus('0')).toBeNull()
	})

	it('товар каталога: цена из копеек, у товара без наличия остаток ноль', () => {
		const p = (over: any) => ({ id: 5, sku: 'B1', name: 'Книга &#171;Ж&#187;', prices: { price: '45050', currency_minor_unit: 2 }, is_in_stock: true, add_to_cart: { maximum: 12 }, ...over })
		expect(siteProduct(p({}))).toEqual({ id: 5, sku: 'B1', name: 'Книга «Ж»', price: 450.5, stock: 12, inStock: true, category: '', image: false, imageSrc: null, thumbSrc: null })
		expect(
			siteProduct(
				p({
					categories: [{ name: 'Товары' }, { name: 'Сувенирные книги' }, { name: 'Книги' }],
					images: [{ src: 'https://lit-na.ru/u/x.jpg', thumbnail: 'https://lit-na.ru/u/x-600x400.jpg', thumbnail_srcset: 'https://lit-na.ru/u/x-600x400.jpg 600w, https://lit-na.ru/u/x-300x200.jpg 300w, https://lit-na.ru/u/x-150x100.jpg 150w' }],
				})
			)
		).toMatchObject({ category: 'Сувенирные книги', image: true, imageSrc: 'https://lit-na.ru/u/x.jpg', thumbSrc: 'https://lit-na.ru/u/x-300x200.jpg' })
		// srcset нет — миниатюра как есть; только общая категория — пусто
		expect(siteProduct(p({ categories: [{ name: 'Товары' }], images: [{ src: 'https://lit-na.ru/u/y.jpg', thumbnail: 'https://lit-na.ru/u/y-t.jpg' }] }))).toMatchObject({ category: '', thumbSrc: 'https://lit-na.ru/u/y-t.jpg' })
		expect(siteProduct(p({ is_in_stock: false, add_to_cart: { maximum: 9999 }, sku: '' }))).toMatchObject({ stock: 0, inStock: false, sku: '' })
	})

	const cart = {
		items: [{ id: 5, quantity: 2, prices: { price: '120000', currency_minor_unit: 2 } }],
		shipping_rates: [
			{
				shipping_rates: [
					{ rate_id: 'official_cdek:139', method_id: 'official_cdek', name: 'CDEK: Посылка дверь-дверь, (2-3 дн.)', price: '105600', currency_minor_unit: 2 },
					{ rate_id: 'official_cdek:138', method_id: 'official_cdek', name: 'CDEK: Посылка дверь-склад, (2-3 дн.)', price: '62500', currency_minor_unit: 2 },
					{ rate_id: 'boxberry_self:11', method_id: 'boxberry_self', name: 'Яндекс Доставка до ПВЗ', price: '34459', currency_minor_unit: 2 },
					{ rate_id: 'boxberry_courier:13', method_id: 'boxberry_courier', name: 'Яндекс Доставка до дома', price: '56364', currency_minor_unit: 2 },
				],
			},
		],
		extensions: {
			official_cdek: {
				points: JSON.stringify([{ code: 'SAR1', name: 'SAR1, Саратов, ул. Тестовая', work_time: 'Пн-Пт 10:00-20:00', location: { address_full: 'Россия, Саратов, ул. Тестовая, 1', city: 'Саратов', postal_code: '410012' } }]),
			},
		},
	}

	it('способы доставки: вид по method_id и названию, номера экземпляров не важны', () => {
		const rates = shippingRates(cart)
		expect(rates.map((r) => [r.id, r.kind, r.price])).toEqual([
			['official_cdek:139', 'cdek_door', 1056],
			['official_cdek:138', 'cdek_pvz', 625],
			['boxberry_self:11', 'yandex_pvz', 344.59],
			['boxberry_courier:13', 'yandex_door', 563.64],
		])
		expect(pickRate(rates, 'yandex_pvz')?.id).toBe('boxberry_self:11')
		expect(pickRate(rates.filter((r) => r.kind !== 'cdek_pvz'), 'cdek_pvz')).toBeUndefined()
		// от 15 000 ₽ сайт даёт единственный бесплатный — он и выбирается
		const free = shippingRates({ shipping_rates: [{ shipping_rates: [{ rate_id: 'free_shipping:10', method_id: 'free_shipping', name: 'Бесплатная доставка', price: '0' }] }] })
		expect(pickRate(free, 'cdek_pvz')).toMatchObject({ id: 'free_shipping:10', kind: 'free', price: 0 })
	})

	it('пакетное добавление в корзину: ошибки различаются по коду', () => {
		expect(addResult({ status: 201, body: { items: [] } })).toBeNull()
		expect(addResult({ status: 400, body: { code: 'woocommerce_rest_product_partially_out_of_stock' } })).toBe('stock')
		expect(addResult({ status: 400, body: { code: 'woocommerce_rest_product_out_of_stock' } })).toBe('stock')
		expect(addResult({ status: 400, body: { code: 'woocommerce_rest_cart_invalid_product' } })).toBe('gone')
		expect(addResult({ status: 400, body: { code: 'woocommerce_store_api_invalid_quantity' } })).toBe('stock')
		expect(addResult({ status: 403, body: { code: 'woocommerce_rest_missing_nonce' } })).toBe('error')
		expect(addResult(undefined)).toBe('error')
	})

	it('сохранение пункта CDEK: успех — только success:true', () => {
		expect(isSuccess('{"success":true}')).toBe(true)
		expect(isSuccess('{"success":false}')).toBe(false)
		expect(isSuccess('0')).toBe(false)
	})

	it('вариант картинки из srcset — ближайший по ширине', () => {
		expect(srcsetPick('a.jpg 402w, b-150x150.jpg 150w, c-300x300.jpg 300w', 300)).toBe('c-300x300.jpg')
		expect(srcsetPick('a.jpg 1024w, b.jpg 768w', 300)).toBe('b.jpg')
		expect(srcsetPick('', 300)).toBeNull()
	})

	it('адрес одной строкой: город, индекс и область по частям через запятую', () => {
		expect(parseAddress('Саратов, ул. Московская, 1')).toEqual({ city: 'Саратов', postcode: '', state: '' })
		expect(parseAddress('410000, Саратовская обл., г. Энгельс, ул. Тельмана, 5')).toEqual({ city: 'Энгельс', postcode: '410000', state: 'Саратовская обл.' })
		expect(parseAddress('Краснодарский край, город Сочи, Курортный пр-т, 10')).toMatchObject({ city: 'Сочи', state: 'Краснодарский край' })
		expect(parseAddress('Ханты-Мансийский АО, г.Сургут, ул. Ленина, 1')).toMatchObject({ city: 'Сургут', state: 'Ханты-Мансийский АО' })
		// страна пропускается
		expect(parseAddress('410019, Россия, Саратовская область, Саратов, ул. им. Маяковского, д. 1')).toEqual({ city: 'Саратов', postcode: '410019', state: 'Саратовская область' })
		expect(parseAddress('РФ, г. Энгельс, ул. Тельмана, 5').city).toBe('Энгельс')
		// город с цифрами или длиннее четырёх слов — не город; «д.» без номера — деревня, а не дом
		expect(parseAddress('Саратов 2, ул. Ленина, 1').city).toBe('')
		expect(parseAddress('доставить пожалуйста на склад завтра утром, ул. Ленина, 1').city).toBe('')
		expect(parseAddress('д. 5, ул. Ленина').city).toBe('')
		expect(parseAddress('д. Ивановка, ул. Лесная, 3').city).toBe('д. Ивановка')
		// улица на месте города, пусто — города нет
		expect(parseAddress('ул. Крайняя, 1, Саратов').city).toBe('')
		expect(parseAddress('').city).toBe('')
	})

	it('цены строк корзины и пункты CDEK (JSON-строкой в корзине)', () => {
		expect(cartPrices(cart).get(5)).toBe(1200)
		expect(cdekPoints(cart)).toEqual([{ code: 'SAR1', name: 'SAR1, Саратов, ул. Тестовая', address: 'Россия, Саратов, ул. Тестовая, 1', hours: 'Пн-Пт 10:00-20:00', city: 'Саратов', postcode: '410012' }])
		expect(cdekPoints({ extensions: { official_cdek: { points: '[]' } } })).toEqual([])
	})

	it('Яндекс Доставка: ключ пересчёта, атрибуты ссылки выбора пункта, список пунктов', () => {
		expect(reviewNonce('<script>var x = {"ajax_url":"/","update_order_review_nonce":"e1f2","apply":"z"};</script>')).toBe('e1f2')
		const review = JSON.stringify({
			result: 'success',
			fragments: {
				'.woocommerce-checkout-review-order-table': `<a class="bxbbutton" id="boxberry_self:11" href="#"
					data-surch =" 1" data-boxberry-open="true" data-method="boxberry_self"
					data-boxberry-target-start="t-start" data-boxberry-token="1$tok" data-boxberry-city="Саратовская область САРАТОВ"
					data-boxberry-weight="1100" data-paymentsum="0" data-ordersum="3600" data-api-url="https://api.example/json.php">Выбрать</a>`,
			},
		})
		expect(boxberryButton(reviewHtml(review))).toEqual({
			token: '1$tok',
			targetStart: 't-start',
			city: 'Саратовская область САРАТОВ',
			weight: '1100',
			ordersum: '3600',
			api: 'https://api.example/json.php',
		})
		expect(boxberryButton(reviewHtml('{"fragments":{}}'))).toBeNull()
		const body = JSON.stringify([
			{ type: 'Feature', properties: { pointid: 'p1', cityname: 'Саратов', Address: '410000, Саратов, ул. Первая, д.1', WorkSchedule: 'пн-вс: 09.00-21.00', zip: '410000', Phone: '+7', balloonContentBody: '<p>много</p>' } },
			{ type: 'Feature', properties: {} },
		])
		expect(points([body])).toEqual([{ pointid: 'p1', cityname: 'Саратов', Address: '410000, Саратов, ул. Первая, д.1', WorkSchedule: 'пн-вс: 09.00-21.00', zip: '410000' }])
		expect(points(['null'])).toEqual([])
	})

	it('пункты Яндекса по кускам: границы кусков посреди элемента, строки и многобайтного символа', () => {
		const n = 3000
		const list = Array.from({ length: n }, (_, i) => ({
			type: 'Feature',
			id: i,
			geometry: { type: 'Point', coordinates: ['51.5', '46.0'] },
			// скобки и кавычки внутри строк — не границы элементов
			properties: { Address: `410000, Саратов, ул. «Первая» {${i}}, д.[1]`, Phone: '+7', WorkSchedule: 'пн-вс', cityname: i % 2 ? 'Саратов' : 'Энгельс', pointid: `p${i}`, zip: '410000', balloonContentBody: '<p class=\"x\">ё</p>'.repeat(5) },
			options: { preset: 'islands#icon' },
		}))
		const bytes = Buffer.from(' ' + JSON.stringify(list) + '\n')
		const want = list.map((f) => ({ pointid: f.properties.pointid, cityname: f.properties.cityname, Address: f.properties.Address, WorkSchedule: 'пн-вс', zip: '410000' }))
		for (const size of [1, 7, 1000, 4096]) {
			const parser = yandexPoints()
			for (let i = 0; i < bytes.length; i += size) parser.write(bytes.subarray(i, i + size))
			expect(parser.end()).toEqual(want)
		}
		// не массив, обрыв, битый элемент, сверх предела — пусто (502 у клиента), как у неразобранного ответа
		expect(points(['{"err":"Неверный токен"}'])).toEqual([])
		expect(points([JSON.stringify(list).slice(0, 5000)])).toEqual([])
		expect(points(['[{"properties":{"pointid":"a"}},{"properties":{"pointid":}]'])).toEqual([])
		const few = yandexPoints(10)
		few.write(bytes)
		expect(few.end()).toEqual([])
	})
})

describe('куки', () => {
	it('новые кладутся, просроченные и «deleted» удаляются', () => {
		const jar = new Map([['beget', 'begetok'], ['old', '1'], ['gone', '2']])
		keepCookies(jar, [
			'wordpress_logged_in_x=user%7C1; expires=Fri, 01-Jan-2100 00:00:00 GMT; path=/; secure; HttpOnly',
			'old=; expires=Thu, 01-Jan-1970 00:00:01 GMT; Max-Age=0; path=/',
			'gone=deleted; path=/',
			'wp_woocommerce_session_x=abc; path=/',
		])
		expect([...jar]).toEqual([['beget', 'begetok'], ['wordpress_logged_in_x', 'user%7C1'], ['wp_woocommerce_session_x', 'abc']])
	})
})

describe('подсказка пар по названию', () => {
	const site: any[] = [
		{ id: 1, name: 'Книга «Базовый текст» (6-е издание) твёрдая обложка', price: 900 },
		{ id: 2, name: 'Буклет «Спонсорство»', price: 50 },
		{ id: 3, name: 'Книга «Это работает: как и почему»', price: 700 },
	]
	it('нормализация: регистр, кавычки, ё, пробелы', () => {
		expect(norm('  Книга  «Ёлка» "Х" ')).toBe('книга елка х')
	})
	it('только точное совпадение названия (после нормализации); вхождение — не подсказка', () => {
		const ours = [
			{ _id: 'a', name: 'БУКЛЕТ "Спонсорство"', price: 50 },
			{ _id: 'b', name: 'Базовый текст (6-е издание) твердая обложка', price: 900 },
			{ _id: 'c', name: 'Книга «Это работает: как и почему»', price: 650 },
		]
		expect(suggestPairs(ours, site)).toEqual({ a: 2, c: 3 })
		// товары местности — ещё и с той же ценой
		expect(suggestPairs(ours, site, true)).toEqual({ a: 2 })
	})
})

describe('засев новой местности с сайта', () => {
	const site = (over: any[]) => over.map((o, i) => ({ id: 100 + i, sku: '', name: 'Товар', price: 100, stock: 1, inStock: true, category: 'Книги', image: false, imageSrc: null, thumbSrc: null, ...o }))

	it('только товары с категорией и ценой; повтор названия — с артикулом (или номером сайта) в скобках', () => {
		const out = siteSeed(
			site([
				{ name: 'Базовый текст', sku: 'BT1', category: 'Книги', price: 450 },
				{ name: 'Доставка СДЭК до пвз', category: '', price: 0 },
				{ name: 'Тест', category: '', price: 100 },
				{ name: 'Бесплатная памятка', category: 'Буклеты', price: 0 },
				{ name: 'Базовый текст', sku: 'BT2', category: 'Сувенирные книги', price: 900 },
				{ name: 'базовый текст', sku: '', category: 'Книги', price: 500 },
				{ name: 'Ж'.repeat(250), category: 'Разное', price: 10 },
			])
		)
		expect(out.map((p) => [p.name.slice(0, 40), p.category, p.price, p.litnaId])).toEqual([
			['Базовый текст', 'Книги', 450, 100],
			['Базовый текст (BT2)', 'Сувенирные книги', 900, 104],
			['базовый текст (105)', 'Книги', 500, 105],
			['Ж'.repeat(40), 'Разное', 10, 106],
		])
		expect(out[3].name).toHaveLength(200)
		expect(out.every((p) => p.targetQty === 0)).toBe(true)
	})

	it('без названия — не берётся; у длинного повтора хвост с артикулом — после обрезки, второй товар не теряется', () => {
		const long = 'Д'.repeat(230)
		const out = siteSeed(site([{ name: '   ' }, { name: long, sku: 'A1' }, { name: long, sku: 'A2' }]))
		expect(out).toHaveLength(2)
		expect(out[1].name.endsWith(' (A2)')).toBe(true)
		expect(out[1].name).toHaveLength(200)
	})

	it('обложки видов по таблице: только известные категории, по одному разу', () => {
		expect(seedKindCovers([{ category: 'Книги' }, { category: 'Медали цветные' }, { category: 'Книги' }, { category: 'Новый вид' }])).toEqual([
			{ category: 'Книги', cover: 'book' },
			{ category: 'Медали цветные', cover: 'medal' },
		])
		// типы — только те, что рисует клиент (skladanclient/src/domain/covers.js)
		const known = ['book', 'hardbook', 'brochure', 'booklet', 'leaflet', 'notebook', 'notepad', 'bookmark', 'pen', 'postcard', 'poster', 'calendar', 'keytag', 'medal', 'badge', 'stickers', 'mug', 'bag', 'candle', 'box', 'cards']
		expect(Object.values(SITE_KIND_COVERS).every((t) => known.includes(t))).toBe(true)
	})
})
