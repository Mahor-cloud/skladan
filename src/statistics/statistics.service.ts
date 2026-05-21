import { ForbiddenException, Injectable } from '@nestjs/common'
import { ModelType } from '@typegoose/typegoose/lib/types'
import { Types } from 'mongoose'
import { InjectModel } from 'nestjs-typegoose'
import { UserModel } from '../auth/user.model'
import { ChangeHistory } from '../change-history/change-history.model'
import { getTenantContext } from '../common/tenant-context/tenant-context.storage'
import { Inventory } from '../inventory/inventory.model'
import { Order } from '../orders/order.model'
import { Product } from '../products/product.model'
import { Purchase } from '../purchases/purchase.model'
import { DashboardQueryDto, TimelineQueryDto } from './dto/dashboard-query.dto'

interface Range {
	from: number
	to: number
}

function toObjectIds(arr?: string[]): Types.ObjectId[] | undefined {
	if (!arr || arr.length === 0) return undefined
	return arr.map((s) => new Types.ObjectId(s))
}

function toNum(v: any, fallback: number): number {
	if (v === undefined || v === null || v === '') return fallback
	const n = Number(v)
	return Number.isFinite(n) ? n : fallback
}

function toArr(v: any): string[] | undefined {
	if (!v) return undefined
	if (Array.isArray(v)) return v
	return String(v)
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
}

function periodMatch(range: Range, field: string) {
	return { [field]: { $gte: range.from, $lt: range.to } }
}

@Injectable()
export class StatisticsService {
	constructor(
		@InjectModel(Order) private readonly orderModel: ModelType<Order>,
		@InjectModel(Purchase) private readonly purchaseModel: ModelType<Purchase>,
		@InjectModel(Inventory) private readonly inventoryModel: ModelType<Inventory>,
		@InjectModel(Product) private readonly productModel: ModelType<Product>,
		@InjectModel(ChangeHistory) private readonly changeHistoryModel: ModelType<ChangeHistory>,
		@InjectModel(UserModel) private readonly userModel: ModelType<UserModel>
	) {}

	async getDashboard(query: DashboardQueryDto) {
		const ctx = getTenantContext()
		if (!ctx?.company) {
			throw new ForbiddenException('Statistics доступен только в контексте компании')
		}
		const companyOid = new Types.ObjectId(ctx.company)

		const now = Date.now()
		const range: Range = {
			from: toNum(query.from, now - 30 * 24 * 3600 * 1000),
			to: toNum(query.to, now),
		}
		const userIds = toObjectIds(toArr(query.users))
		const productIds = toObjectIds(toArr(query.products))
		const categories = toArr(query.categories)


		const topLimit = Math.min(Math.max(toNum(query.topLimit, 1000), 1), 1000)


		const ordersMatch: any = { ...periodMatch(range, 'orderDate') }
		if (userIds) ordersMatch.user = { $in: userIds }
		if (productIds) {


			const dualIds: any[] = [
				...productIds,
				...productIds.map((o) => String(o)),
			]
			ordersMatch['items.product'] = { $in: dualIds }
		}


		const ordersAgg = await this.orderModel.aggregate([
			{ $match: ordersMatch },
			{
				$group: {
					_id: null,
					createdCount: { $sum: 1 },
					createdAmount: { $sum: '$totalAmount' },
					completedCount: { $sum: { $cond: ['$isCompleted', 1, 0] } },
					completedAmount: { $sum: { $cond: ['$isCompleted', '$totalAmount', 0] } },
					paidCount: { $sum: { $cond: ['$isPaid', 1, 0] } },
				},
			},
		])
		const o = ordersAgg[0] || { createdCount: 0, createdAmount: 0, completedCount: 0, completedAmount: 0, paidCount: 0 }

		const turnover = o.createdAmount
		const avgOrderValue = o.createdCount > 0 ? Math.round(turnover / o.createdCount) : 0
		const completionRate = o.createdCount > 0 ? Math.round((o.completedCount / o.createdCount) * 100) : 0


		const ordersByDay = productIds
			? await this.orderModel.aggregate([
				{ $match: ordersMatch },
				{ $unwind: '$items' },
				{ $addFields: { 'items.productOid': { $toObjectId: '$items.product' } } },
				{ $match: { 'items.productOid': { $in: productIds } } },
				{
					$lookup: {
						from: 'Products',
						let: { pid: '$items.productOid' },
						pipeline: [
							{
								$match: {
									$expr: {
										$and: [
											{ $eq: ['$_id', '$$pid'] },
											{ $eq: ['$company', companyOid] },
										],
									},
								},
							},
						],
						as: 'product',
					},
				},
				{ $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
				{
					$group: {
						_id: { $dateToString: { format: '%Y-%m-%d', date: { $toDate: '$orderDate' } } },
						amount: { $sum: { $multiply: ['$items.quantity', { $ifNull: ['$product.price', 0] }] } },
						orderIds: { $addToSet: '$_id' },
						completedCount: { $sum: { $cond: ['$isCompleted', 1, 0] } },
					},
				},
				{ $sort: { _id: 1 } },
				{
					$project: {
						_id: 0,
						date: '$_id',
						amount: 1,
						ordersCount: { $size: '$orderIds' },
						completedCount: 1,
					},
				},
			])
			: await this.orderModel.aggregate([
				{ $match: ordersMatch },
				{
					$group: {
						_id: { $dateToString: { format: '%Y-%m-%d', date: { $toDate: '$orderDate' } } },
						amount: { $sum: '$totalAmount' },
						ordersCount: { $sum: 1 },
						completedCount: { $sum: { $cond: ['$isCompleted', 1, 0] } },
					},
				},
				{ $sort: { _id: 1 } },
				{ $project: { _id: 0, date: '$_id', amount: 1, ordersCount: 1, completedCount: 1 } },
			])


		const purchaseMatch: any = {
			...periodMatch(range, 'purchaseDate'),
			$or: [{ partialCompleted: true }, { isCompleted: true }],
		}
		const purchasesByDay = productIds
			? await this.purchaseModel.aggregate([
				{ $match: purchaseMatch },
				{ $unwind: '$items' },

				{ $addFields: { 'items.productOid': { $toObjectId: '$items.product' } } },
				{ $match: { 'items.productOid': { $in: productIds } } },
				{
					$lookup: {
						from: 'Products',
						let: { pid: '$items.productOid' },
						pipeline: [
							{
								$match: {
									$expr: {
										$and: [
											{ $eq: ['$_id', '$$pid'] },
											{ $eq: ['$company', companyOid] },
										],
									},
								},
							},
						],
						as: 'product',
					},
				},
				{ $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
				{
					$group: {
						_id: { $dateToString: { format: '%Y-%m-%d', date: { $toDate: '$purchaseDate' } } },
						amount: { $sum: { $multiply: ['$items.confirmedQuantity', { $ifNull: ['$product.price', 0] }] } },
						purchaseIds: { $addToSet: '$_id' },
						completedCount: { $sum: { $cond: ['$isCompleted', 1, 0] } },
					},
				},
				{ $sort: { _id: 1 } },
				{
					$project: {
						_id: 0,
						date: '$_id',
						amount: 1,
						purchasesCount: { $size: '$purchaseIds' },
						completedCount: 1,
					},
				},
			])
			: await this.purchaseModel.aggregate([
				{ $match: purchaseMatch },
				{
					$group: {
						_id: { $dateToString: { format: '%Y-%m-%d', date: { $toDate: '$purchaseDate' } } },
						amount: { $sum: '$totalConfirmedAmount' },
						purchasesCount: { $sum: 1 },
						completedCount: { $sum: { $cond: ['$isCompleted', 1, 0] } },
					},
				},
				{ $sort: { _id: 1 } },
				{ $project: { _id: 0, date: '$_id', amount: 1, purchasesCount: 1, completedCount: 1 } },
			])


		const purchasedByProduct = await this.purchaseModel.aggregate([
			{ $match: purchaseMatch },
			{ $unwind: '$items' },
			{ $addFields: { 'items.productOid': { $toObjectId: '$items.product' } } },
			...(productIds ? [{ $match: { 'items.productOid': { $in: productIds } } }] : []),
			{
				$group: {
					_id: '$items.productOid',
					received: { $sum: '$items.confirmedQuantity' },
				},
			},
		])
		const receivedMap = new Map<string, number>(
			purchasedByProduct.map((r: any) => [String(r._id), Number(r.received || 0)])
		)



		const topProductsFacet = await this.orderModel.aggregate([
			{ $match: ordersMatch },
			{ $unwind: '$items' },
			{ $addFields: { 'items.productOid': { $toObjectId: '$items.product' } } },
			...(productIds ? [{ $match: { 'items.productOid': { $in: productIds } } }] : []),
			{
				$lookup: {
					from: 'Products',
					let: { pid: '$items.productOid' },
					pipeline: [
						{
							$match: {
								$expr: {
									$and: [
										{ $eq: ['$_id', '$$pid'] },
										{ $eq: ['$company', companyOid] },
									],
								},
							},
						},
					],
					as: 'product',
				},
			},
			{ $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
			...(categories ? [{ $match: { 'product.category': { $in: categories } } }] : []),
			{
				$group: {
					_id: '$items.product',
					name: { $first: '$product.name' },
					category: { $first: '$product.category' },
					quantity: { $sum: '$items.quantity' },
					amount: { $sum: { $multiply: ['$items.quantity', { $ifNull: ['$product.price', 0] }] } },
				},
			},
			{
				$facet: {
					byAmount: [
						{ $sort: { amount: -1 } },
						{ $limit: topLimit },
						{ $project: { _id: 0, productId: '$_id', name: 1, category: 1, quantity: 1, amount: 1 } },
					],
					byQuantity: [
						{ $sort: { quantity: -1 } },
						{ $limit: topLimit },
						{ $project: { _id: 0, productId: '$_id', name: 1, category: 1, quantity: 1, amount: 1 } },
					],
				},
			},
		])
		const topProducts = topProductsFacet[0]?.byAmount || []
		const topProductsByQuantity = topProductsFacet[0]?.byQuantity || []



		const soldMap = new Map<string, number>(
			(topProductsByQuantity || []).map((r: any) => [
				String(r.productId),
				Number(r.quantity || 0),
			])
		)
		const flowProductIdSet = new Set<string>()
		soldMap.forEach((_, k) => flowProductIdSet.add(k))
		receivedMap.forEach((_, k) => flowProductIdSet.add(k))
		const flowProductIds: string[] = Array.from(flowProductIdSet)
		const flowProducts = flowProductIds.length
			? await this.productModel.find({ _id: { $in: flowProductIds } }).exec()
			: []
		const productMeta = new Map<string, { name: string; category?: string }>(
			flowProducts.map((p: any) => [
				String(p._id),
				{ name: p.name, category: p.category },
			])
		)
		const flowByProduct = flowProductIds
			.map((id) => {
				const sold = soldMap.get(id) || 0
				const received = receivedMap.get(id) || 0
				const meta = productMeta.get(id) || { name: '—', category: undefined }
				return {
					productId: id,
					name: meta.name,
					category: meta.category,
					sold,
					received,
					gap: received - sold,
				}
			})
			.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))

		const topUsers = productIds
			? await this.orderModel.aggregate([
				{ $match: ordersMatch },
				{ $unwind: '$items' },
				{ $addFields: { 'items.productOid': { $toObjectId: '$items.product' } } },
				{ $match: { 'items.productOid': { $in: productIds } } },
				{
					$lookup: {
						from: 'Products',
						let: { pid: '$items.productOid' },
						pipeline: [
							{
								$match: {
									$expr: {
										$and: [
											{ $eq: ['$_id', '$$pid'] },
											{ $eq: ['$company', companyOid] },
										],
									},
								},
							},
						],
						as: 'product',
					},
				},
				{ $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
				{ $addFields: { userOid: { $toObjectId: '$user' } } },
				{
					$group: {
						_id: '$userOid',
						amount: { $sum: { $multiply: ['$items.quantity', { $ifNull: ['$product.price', 0] }] } },
						orderIds: { $addToSet: '$_id' },
						completedOrderIds: { $addToSet: { $cond: ['$isCompleted', '$_id', '$$REMOVE'] } },
					},
				},
				{ $sort: { amount: -1 } },
				{ $limit: topLimit },
				{
					$lookup: {
						from: 'Users',
						let: { uid: '$_id' },
						pipeline: [
							{
								$match: {
									$expr: {
										$and: [
											{ $eq: ['$_id', '$$uid'] },
											{ $eq: ['$company', companyOid] },
										],
									},
								},
							},
						],
						as: 'user',
					},
				},
				{ $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
				{
					$project: {
						_id: 0,
						userId: '$_id',
						name: '$user.name',
						amount: 1,
						ordersCount: { $size: '$orderIds' },
						completedCount: { $size: '$completedOrderIds' },
					},
				},
			])
			: await this.orderModel.aggregate([
				{ $match: ordersMatch },
				{ $addFields: { userOid: { $toObjectId: '$user' } } },
				{
					$group: {
						_id: '$userOid',
						amount: { $sum: '$totalAmount' },
						ordersCount: { $sum: 1 },
						completedCount: { $sum: { $cond: ['$isCompleted', 1, 0] } },
					},
				},
				{ $sort: { amount: -1 } },
				{ $limit: topLimit },
				{
					$lookup: {
						from: 'Users',
						let: { uid: '$_id' },
						pipeline: [
							{
								$match: {
									$expr: {
										$and: [
											{ $eq: ['$_id', '$$uid'] },
											{ $eq: ['$company', companyOid] },
										],
									},
								},
							},
						],
						as: 'user',
					},
				},
				{ $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
				{ $project: { _id: 0, userId: '$_id', name: '$user.name', amount: 1, ordersCount: 1, completedCount: 1 } },
			])


		const categoryDistribution = await this.orderModel.aggregate([
			{ $match: ordersMatch },
			{ $unwind: '$items' },
			{ $addFields: { 'items.productOid': { $toObjectId: '$items.product' } } },
			...(productIds ? [{ $match: { 'items.productOid': { $in: productIds } } }] : []),
			{
				$lookup: {
					from: 'Products',
					let: { pid: '$items.productOid' },
					pipeline: [
						{
							$match: {
								$expr: {
									$and: [
										{ $eq: ['$_id', '$$pid'] },
										{ $eq: ['$company', companyOid] },
									],
								},
							},
						},
					],
					as: 'product',
				},
			},
			{ $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
			{
				$group: {
					_id: { $ifNull: ['$product.category', 'Без категории'] },
					amount: { $sum: { $multiply: ['$items.quantity', { $ifNull: ['$product.price', 0] }] } },
				},
			},
			{ $sort: { amount: -1 } },
			{ $project: { _id: 0, category: '$_id', amount: 1 } },
		])
		const totalCat = categoryDistribution.reduce((acc, c) => acc + c.amount, 0)
		const categoryWithPct = categoryDistribution.map((c) => ({
			...c,
			percentage: totalCat > 0 ? Math.round((c.amount / totalCat) * 1000) / 10 : 0,
		}))


		const ordersList = await this.orderModel
			.find(ordersMatch)
			.sort({ orderDate: -1 })
			.limit(200)
			.populate('user', 'name login')
			.select('orderNumber orderDate isCompleted isPaid totalAmount user items')
			.exec()

		return {
			meta: { from: range.from, to: range.to, generatedAt: Date.now() },
			summary: {
				turnover,
				avgOrderValue,
				completionRate,
				ordersCount: {
					created: o.createdCount,
					paid: o.paidCount,
					completed: o.completedCount,
				},
			},
			charts: {
				ordersByDay,
				purchasesByDay,
				flowByProduct,
				topProducts,
				topProductsByQuantity,
				topUsers,
				categoryDistribution: categoryWithPct,
			},
			ordersList,
		}
	}

	async getPeriodBounds(): Promise<{ from: number | null; to: number }> {

		const [oldestOrder, oldestPurchase] = await Promise.all([
			this.orderModel.findOne().sort({ orderDate: 1 }).select('orderDate').exec(),
			this.purchaseModel.findOne().sort({ purchaseDate: 1 }).select('purchaseDate').exec(),
		])
		const dates = [
			(oldestOrder as any)?.orderDate as number | undefined,
			(oldestPurchase as any)?.purchaseDate as number | undefined,
		].filter((d): d is number => typeof d === 'number' && Number.isFinite(d))
		const from = dates.length ? Math.min(...dates) : null
		return { from, to: Date.now() }
	}

	async getTimeline(query: TimelineQueryDto) {
		const range: Range = {
			from: toNum(query.from, 0),
			to: toNum(query.to, Date.now() + 1),
		}
		const limit = Math.min(Math.max(toNum(query.limit, 50), 1), 200)
		const page = Math.max(toNum(query.page, 1), 1)
		const skip = (page - 1) * limit
		const total = await this.changeHistoryModel.countDocuments({ ...periodMatch(range, 'changeDate') })
		const items = await this.changeHistoryModel
			.find({ ...periodMatch(range, 'changeDate') })
			.sort({ changeDate: -1 })
			.skip(skip)
			.limit(limit)
			.populate('user')
			.exec()
		return { total, page, limit, items }
	}

	async exportCsv(query: DashboardQueryDto): Promise<string> {
		const data = await this.getDashboard(query)
		const lines: string[] = []
		const esc = (s: any) => `"${String(s ?? '').replace(/"/g, '""')}"`

		lines.push('# Skladan Statistics Export')
		lines.push(`# Period: ${new Date(data.meta.from).toISOString()} - ${new Date(data.meta.to).toISOString()}`)
		lines.push(`# Generated: ${new Date(data.meta.generatedAt).toISOString()}`)
		lines.push('')
		lines.push('## Summary')
		lines.push('Metric,Value')
		lines.push(`Turnover (rub),${data.summary.turnover}`)
		lines.push(`AvgOrderValue (rub),${data.summary.avgOrderValue}`)
		lines.push(`CompletionRate (%),${data.summary.completionRate}`)
		lines.push(`Orders.Created,${data.summary.ordersCount.created}`)
		lines.push(`Orders.Paid,${data.summary.ordersCount.paid}`)
		lines.push(`Orders.Completed,${data.summary.ordersCount.completed}`)
		lines.push('')
		lines.push('## Orders By Day')
		lines.push('Date,Orders,Completed,Amount')
		for (const d of data.charts.ordersByDay as any[]) {
			lines.push([d.date, d.ordersCount, d.completedCount, d.amount].map(esc).join(','))
		}
		lines.push('')
		lines.push('## Top Products')
		lines.push('Name,Category,Quantity,Amount')
		for (const p of data.charts.topProducts as any[]) {
			lines.push([p.name, p.category, p.quantity, p.amount].map(esc).join(','))
		}
		lines.push('')
		lines.push('## Top Users')
		lines.push('Name,Orders,Completed,Amount')
		for (const u of data.charts.topUsers as any[]) {
			lines.push([u.name, u.ordersCount, u.completedCount, u.amount].map(esc).join(','))
		}
		lines.push('')
		lines.push('## Category Distribution')
		lines.push('Category,Amount,Percentage')
		for (const c of data.charts.categoryDistribution as any[]) {
			lines.push([c.category, c.amount, c.percentage].map(esc).join(','))
		}
		lines.push('')
		lines.push('## Orders List')
		lines.push('OrderNumber,Date,User,Amount,Completed,Paid')
		for (const ord of data.ordersList as any[]) {
			lines.push(
				[
					ord.orderNumber,
					new Date(ord.orderDate).toISOString(),
					ord.user?.name || '',
					ord.totalAmount,
					ord.isCompleted ? 1 : 0,
					ord.isPaid ? 1 : 0,
				]
					.map(esc)
					.join(',')
			)
		}
		return lines.join('\n')
	}
}
