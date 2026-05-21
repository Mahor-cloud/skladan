import { IsString, MinLength, MaxLength } from 'class-validator'

export class ChangeAdminPasswordDto {
	@IsString()
	@MinLength(4)
	@MaxLength(120)
	password!: string
}
