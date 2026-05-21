import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator'
import { Type } from 'class-transformer'

class SubscriptionKeysDto {
	@IsNotEmpty()
	@IsString()
	@MaxLength(500)
	p256dh: string

	@IsNotEmpty()
	@IsString()
	@MaxLength(500)
	auth: string
}

export class SubscriptionPreferencesDto {
	@IsOptional()
	@IsBoolean()
	orders?: boolean

	@IsOptional()
	@IsBoolean()
	purchases?: boolean

	@IsOptional()
	@IsBoolean()
	inventory?: boolean

	@IsOptional()
	@IsBoolean()
	products?: boolean

	@IsOptional()
	@IsBoolean()
	users?: boolean

	@IsOptional()
	@IsBoolean()
	roles?: boolean

	@IsOptional()
	@IsBoolean()
	payment?: boolean

	@IsOptional()
	@IsBoolean()
	ordersOwnOnly?: boolean
}

export class SubscriptionDto {
	@IsNotEmpty()
	@IsString()
	@MaxLength(2000)
	endpoint: string

	@ValidateNested()
	@Type(() => SubscriptionKeysDto)
	keys: SubscriptionKeysDto

	@IsOptional()
	expirationTime?: number | null

	@IsOptional()
	@ValidateNested()
	@Type(() => SubscriptionPreferencesDto)
	preferences?: SubscriptionPreferencesDto
}
