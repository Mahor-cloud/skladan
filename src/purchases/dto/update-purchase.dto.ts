export class UpdatePurchaseDto {
	user?: string
	items?: { product: string; quantity: number }[]
	status?: string
	isPaid?: boolean
	partialCompleted?: boolean
	isCompleted?: boolean
	isCreated?: boolean
	purchaseDate?: number
	comment?: string
}
