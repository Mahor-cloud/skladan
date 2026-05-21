import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator'

export class ChangeOwnPasswordDto {
	@IsNotEmpty()
	@IsString()
	@MaxLength(128)
	currentPassword: string

	@IsNotEmpty()
	@IsString()
	@MinLength(4)
	@MaxLength(128)
	newPassword: string
}
