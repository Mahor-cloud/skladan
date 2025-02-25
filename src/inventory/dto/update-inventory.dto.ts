export class UpdateInventoryDto {
	isCompleted?: boolean
	startDate?: number
	createdBy?: string
	items?: { product: string; newQuantity: number; quantity: number }[]
	comment?: string
}
