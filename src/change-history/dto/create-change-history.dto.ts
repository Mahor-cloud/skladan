import { mongoose } from '@typegoose/typegoose'

export class CreateChangeHistoryDto {
	user: mongoose.Types.ObjectId
	changeType: string
	description: string
	changeDate: number
}
