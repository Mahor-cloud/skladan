import { IsArray, IsNotEmpty, IsString, MaxLength } from 'class-validator'

export class CreateRoleDto {
	@IsNotEmpty()
	@IsString()
	@MaxLength(200)
	name: string

	@IsArray()
	@IsString({ each: true })
	permissions: string[]
}
