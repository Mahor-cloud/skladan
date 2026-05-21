import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator'

export class UpdateCompanyDto {
	@IsOptional()
	@IsString()
	@MinLength(2)
	@MaxLength(120)
	name?: string

	@IsOptional()
	@IsString()
	@MaxLength(60)
	slug?: string

	@IsOptional()
	@IsBoolean()
	isActive?: boolean
}
