export class UpdateOrderDto {
	isCompleted?: boolean
	user?: string
	items?: { product: string; quantity: number }[]
	status?: string
	isPaid?: boolean
	confirmedPaid?: boolean
	orderDate?: number
	comment?: string
}
