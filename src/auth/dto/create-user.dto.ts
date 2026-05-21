import {
	IsBoolean,
	IsMongoId,
	IsNotEmpty,
	IsOptional,
	IsString,
	MaxLength,
	MinLength,
} from 'class-validator'

export class CreateUserDto {
	@IsString()
	@IsNotEmpty()
	@MaxLength(64)
	login: string

	@IsString()
	@IsNotEmpty()
	@MinLength(4)
	@MaxLength(128)
	password: string

	@IsMongoId()
	role: string

	@IsOptional()
	@IsString()
	@MaxLength(100)
	name?: string

	@IsOptional()
	@IsBoolean()
	isAdmin?: boolean
}
