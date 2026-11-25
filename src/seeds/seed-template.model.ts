/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { modelOptions, prop } from '@typegoose/typegoose'
import { Base } from '@typegoose/typegoose/lib/defaultClasses'
import { KindCover } from '../database/messages.model'

export interface SeedTemplate extends Base {}

export class SeedRoleTemplate {
	@prop({ required: true })
	name: string

	@prop({ type: () => [String], default: [] })
	permissions: string[]
}

export class SeedProductTemplate {
	@prop({ required: true })
	name: string

	@prop({ default: '' })
	category: string

	@prop({ default: 0 })
	price: number

	@prop({ default: 0 })
	targetQty: number

	@prop()
	coverColor?: string

	// ключ картинки в SeedPhotos; новой местности достаётся своя копия
	@prop()
	photo?: string

	// товар на lit-na.ru (как Product.litnaId): копируется в товары новой местности
	@prop()
	litnaId?: number | null
}

@modelOptions({
	options: { allowMixed: 0 },
	schemaOptions: { collection: 'SeedTemplate' },
})
export class SeedTemplate {

	@prop({ required: true, unique: true, default: 'default' })
	key: string

	@prop({ type: () => [SeedRoleTemplate], default: [] })
	roles: SeedRoleTemplate[]

	@prop({ type: () => [SeedProductTemplate], default: [] })
	products: SeedProductTemplate[]

	@prop({ type: () => [KindCover], _id: false, default: [] })
	kindCovers: KindCover[]

	@prop({ default: () => Date.now() })
	updatedAt?: number
}

export interface SeedPhoto extends Base {}

// Фото товаров шаблона: общие для платформы, поэтому без местности и отдельно от ProductPhotos
@modelOptions({ options: { allowMixed: 0 } })
export class SeedPhoto {
	@prop({ required: true, unique: true })
	token: string

	@prop({ required: true })
	contentType: string

	@prop({ required: true })
	data: Buffer
}
