

type SubscriptionCategory =
	| 'orders'
	| 'purchases'
	| 'inventory'
	| 'products'
	| 'users'
	| 'roles'
	| 'payment'

const EVENT_LABELS_RU: Record<string, string> = {
	'order-created': 'Заказ создан',
	'order-updated': 'Заказ обновлён',
	'order-deleted': 'Заказ удалён',
	'order-surcharge-pending': 'Требуется доплата',
	'order-refund-pending': 'Требуется возврат',
	'purchase-created': 'Закупка создана',
	'purchase-updated': 'Закупка обновлена',
	'purchase-deleted': 'Закупка удалена',
	'inventory-created': 'Инвентаризация начата',
	'inventory-updated': 'Инвентаризация обновлена',
	'inventory-edited-after-completion': 'Завершённая инвентаризация переписана',
	'inventory-deleted': 'Инвентаризация удалена',
	'inventory-deleted-after-completion': 'Завершённая инвентаризация удалена',
	'product-created': 'Товар создан',
	'product-updated': 'Товар обновлён',
	'product-deleted': 'Товар удалён',
	'user-created': 'Пользователь создан',
	'user-updated': 'Пользователь обновлён',
	'user-deleted': 'Пользователь удалён',
	'role-created': 'Роль создана',
	'role-updated': 'Роль обновлена',
	'role-deleted': 'Роль удалена',
}

function formatTitle(changeType: string, count: number): string {
	const ruTitle = EVENT_LABELS_RU[changeType] || changeType
	if (count <= 1) return ruTitle
	return `${ruTitle} (${count} событий)`
}

function categoryForChangeType(changeType: string): SubscriptionCategory {
	if (changeType === 'order-surcharge-pending' || changeType === 'order-refund-pending')
		return 'payment'
	if (changeType.startsWith('order-')) return 'orders'
	if (changeType.startsWith('purchase-')) return 'purchases'
	if (changeType.startsWith('inventory-')) return 'inventory'
	if (changeType.startsWith('product-')) return 'products'
	if (changeType.startsWith('user-')) return 'users'
	if (changeType.startsWith('role-')) return 'roles'
	return 'orders'
}

function permissionForCategory(category: SubscriptionCategory): string | null {
	if (category === 'payment') return 'approve-payment'
	return null
}

describe('EVENT_LABELS_RU completeness', () => {
	const expectedKeys = [
		'order-created',
		'order-updated',
		'order-deleted',
		'order-surcharge-pending',
		'order-refund-pending',
		'purchase-created',
		'purchase-updated',
		'purchase-deleted',
		'inventory-created',
		'inventory-updated',
		'inventory-edited-after-completion',
		'inventory-deleted',
		'inventory-deleted-after-completion',
		'product-created',
		'product-updated',
		'product-deleted',
		'user-created',
		'user-updated',
		'user-deleted',
		'role-created',
		'role-updated',
		'role-deleted',
	]

	it.each(expectedKeys)('has Russian label for "%s"', (key) => {
		expect(EVENT_LABELS_RU[key]).toBeTruthy()
		expect(typeof EVENT_LABELS_RU[key]).toBe('string')
	})

	it('all labels are non-empty strings in Russian (contain Cyrillic)', () => {
		const cyrillicRe = /[а-яёА-ЯЁ]/
		for (const [key, label] of Object.entries(EVENT_LABELS_RU)) {
			expect(cyrillicRe.test(label)).toBe(true)
		}
	})
})

describe('formatTitle', () => {
	it('returns the Russian label for a known changeType when count is 1', () => {
		expect(formatTitle('order-created', 1)).toBe('Заказ создан')
	})

	it('returns the Russian label for a known changeType when count is 0', () => {
		expect(formatTitle('order-updated', 0)).toBe('Заказ обновлён')
	})

	it('appends count badge when count is 2', () => {
		expect(formatTitle('order-created', 2)).toBe('Заказ создан (2 событий)')
	})

	it('appends count badge when count is 10', () => {
		expect(formatTitle('product-deleted', 10)).toBe('Товар удалён (10 событий)')
	})

	it('falls back to changeType string when type is unknown (count=1)', () => {
		expect(formatTitle('some-unknown-type', 1)).toBe('some-unknown-type')
	})

	it('falls back to changeType string with count badge when type is unknown (count=3)', () => {
		expect(formatTitle('some-unknown-type', 3)).toBe('some-unknown-type (3 событий)')
	})

	it('returns correct label for inventory-edited-after-completion', () => {
		expect(formatTitle('inventory-edited-after-completion', 1)).toBe(
			'Завершённая инвентаризация переписана'
		)
	})

	it('returns correct label for order-surcharge-pending', () => {
		expect(formatTitle('order-surcharge-pending', 1)).toBe('Требуется доплата')
	})
})

describe('categoryForChangeType', () => {
	it('maps order-created to "orders"', () => {
		expect(categoryForChangeType('order-created')).toBe('orders')
	})

	it('maps order-updated to "orders"', () => {
		expect(categoryForChangeType('order-updated')).toBe('orders')
	})

	it('maps order-deleted to "orders"', () => {
		expect(categoryForChangeType('order-deleted')).toBe('orders')
	})

	it('maps order-surcharge-pending to "payment" (special case overrides order- prefix)', () => {
		expect(categoryForChangeType('order-surcharge-pending')).toBe('payment')
	})

	it('maps order-refund-pending to "payment" (special case overrides order- prefix)', () => {
		expect(categoryForChangeType('order-refund-pending')).toBe('payment')
	})

	it('maps purchase-created to "purchases"', () => {
		expect(categoryForChangeType('purchase-created')).toBe('purchases')
	})

	it('maps purchase-deleted to "purchases"', () => {
		expect(categoryForChangeType('purchase-deleted')).toBe('purchases')
	})

	it('maps inventory-created to "inventory"', () => {
		expect(categoryForChangeType('inventory-created')).toBe('inventory')
	})

	it('maps inventory-edited-after-completion to "inventory"', () => {
		expect(categoryForChangeType('inventory-edited-after-completion')).toBe('inventory')
	})

	it('maps product-created to "products"', () => {
		expect(categoryForChangeType('product-created')).toBe('products')
	})

	it('maps user-created to "users"', () => {
		expect(categoryForChangeType('user-created')).toBe('users')
	})

	it('maps role-updated to "roles"', () => {
		expect(categoryForChangeType('role-updated')).toBe('roles')
	})

	it('returns "orders" as fallback for unknown changeType', () => {
		expect(categoryForChangeType('completely-unknown')).toBe('orders')
	})
})

describe('permissionForCategory', () => {
	it('returns "approve-payment" for "payment" category', () => {
		expect(permissionForCategory('payment')).toBe('approve-payment')
	})

	it('returns null for "orders" category', () => {
		expect(permissionForCategory('orders')).toBeNull()
	})

	it('returns null for "purchases" category', () => {
		expect(permissionForCategory('purchases')).toBeNull()
	})

	it('returns null for "inventory" category', () => {
		expect(permissionForCategory('inventory')).toBeNull()
	})

	it('returns null for "products" category', () => {
		expect(permissionForCategory('products')).toBeNull()
	})

	it('returns null for "users" category', () => {
		expect(permissionForCategory('users')).toBeNull()
	})

	it('returns null for "roles" category', () => {
		expect(permissionForCategory('roles')).toBeNull()
	})
})
