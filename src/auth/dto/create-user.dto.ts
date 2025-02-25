export class CreateUserDto {
	login: string
	password: string
	role: string
	isAdmin?: boolean
}
