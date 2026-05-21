import {
	IsBoolean,
	IsMongoId,
	IsOptional,
	IsString,
	MaxLength,
	MinLength,
} from 'class-validator'

export class UpdateUserDto {
	@IsOptional()
	@IsString()
	@MaxLength(64)
	login?: string

	@IsOptional()
	@IsString()
	@MinLength(4)
	@MaxLength(128)
	password?: string

	@IsOptional()
	@IsMongoId()
	role?: string

	@IsOptional()
	@IsString()
	@MaxLength(100)
	name?: string

	@IsOptional()
	@IsBoolean()
	isAdmin?: boolean
}
