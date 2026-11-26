/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { Type } from 'class-transformer'
import {
	ArrayMaxSize,
	IsArray,
	IsBoolean,
	IsIn,
	IsInt,
	IsMongoId,
	IsNotEmpty,
	IsNumber,
	IsOptional,
	IsString,
	MaxLength,
	Min,
	ValidateNested,
} from 'class-validator'

export const DELIVERY_KINDS = ['cdek_pvz', 'yandex_pvz', 'cdek_door', 'yandex_door']
// cheque (для юрлиц) не делается
export const PAY_METHODS = ['robokassa', 'robokassa_sbp', 'robokassa_split', 'robokassa_credit', 'robokassa_mokka']

export class LitnaDeliveryDto {
	@IsIn(DELIVERY_KINDS)
	kind!: string

	/** Выбранный пункт: код и строка пункта (адрес); у Яндекса сайт ждёт её в виде «Город (Адрес)» — как name из /litna/points */
	@IsOptional()
	@IsString()
	@MaxLength(100)
	code?: string

	@IsOptional()
	@IsString()
	@MaxLength(300)
	title?: string

	/** Город, по которому искали пункт: по нему сайт считает доставку */
	@IsOptional()
	@IsString()
	@MaxLength(100)
	city?: string

	/** Адрес при пункте выдачи вписан руками (бесплатную доставку магазин везёт не в пункт): уходит на сайт как написан */
	@IsOptional()
	@IsBoolean()
	manual?: boolean
}

export class LitnaLinkDto {
	@IsMongoId()
	product!: string

	/** null — товар намеренно без пары на сайте */
	@IsOptional()
	@IsInt()
	@Min(1)
	siteId!: number | null
}

export class LitnaLinksDto {
	@IsArray()
	@ArrayMaxSize(5000)
	@ValidateNested({ each: true })
	@Type(() => LitnaLinkDto)
	links!: LitnaLinkDto[]
}

/** Вход под аккаунтом сайта — необязателен: без него заказы идут гостем */
export class LitnaLoginDto {
	@IsString()
	@IsNotEmpty()
	@MaxLength(200)
	login!: string

	@IsString()
	@IsNotEmpty()
	@MaxLength(200)
	password!: string
}

/** Получатель и доставка; вход — отдельно (account/login) */
export class LitnaAccountDto {
	@IsOptional()
	@IsString()
	@MaxLength(100)
	firstName?: string

	@IsOptional()
	@IsString()
	@MaxLength(100)
	lastName?: string

	@IsOptional()
	@IsString()
	@MaxLength(50)
	phone?: string

	@IsOptional()
	@IsString()
	@MaxLength(200)
	email?: string

	/** Одной строкой: до двери — «Город, улица, дом» (город — первой частью), у пункта выдачи — адрес пункта */
	@IsOptional()
	@IsString()
	@MaxLength(300)
	address?: string

	@IsOptional()
	@ValidateNested()
	@Type(() => LitnaDeliveryDto)
	delivery?: LitnaDeliveryDto
}

export class LitnaPointsDto {
	@IsIn(['cdek', 'yandex'])
	kind!: string

	@IsString()
	@IsNotEmpty()
	@MaxLength(100)
	city!: string
}

export class LitnaOrderDto {
	/** Сумма к оплате (товары + доставка), которую человек видел и подтвердил */
	@IsNumber()
	@Min(0)
	total!: number

	/** Этот заказ — гостем, даже если вход под аккаунтом сайта сохранён */
	@IsOptional()
	@IsBoolean()
	guest?: boolean
}

export class LitnaDocDto {
	/** invoice — счёт, packing — накладная (упаковочный лист) */
	@IsIn(['invoice', 'packing'])
	type!: 'invoice' | 'packing'
}

/** method — по-старому присылаемый способ; сервер его не применяет: форма Robokassa одна, способ выбирается на её странице */
export class LitnaPayDto {
	@IsOptional()
	@IsIn(PAY_METHODS)
	method?: string
}
