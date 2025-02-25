export class CreatePurchaseDto {
	user: string
	items: { product: string; quantity: number }[]
	status: string
	isPaid?: boolean
	isCompleted?: boolean
	purchaseDate?: number
	comment?: string
}
