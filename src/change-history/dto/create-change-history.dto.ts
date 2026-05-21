import { mongoose } from '@typegoose/typegoose'
import { IsInt, IsMongoId, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator'

export class CreateChangeHistoryDto {
	@IsOptional()
	@IsMongoId()
	user?: mongoose.Types.ObjectId | string

	@IsNotEmpty()
	@IsString()
	@MaxLength(200)
	changeType: string

	@IsNotEmpty()
	@IsString()
	@MaxLength(1000)
	description: string

	@IsOptional()
	@IsInt()
	@Min(0)
	changeDate?: number

	@IsOptional()
	@IsMongoId()
	relatedUser?: any
}
