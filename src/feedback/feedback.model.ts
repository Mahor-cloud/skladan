/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { modelOptions, mongoose, prop } from '@typegoose/typegoose'
import { Base } from '@typegoose/typegoose/lib/defaultClasses'

export interface FeedbackSettings extends Base {}

/** Куда пересылать обратную связь: одна запись на всю установку, без местности */
@modelOptions({ options: { allowMixed: 0 }, schemaOptions: { collection: 'FeedbackSettings' } })
export class FeedbackSettings {
	@prop({ required: true, unique: true, default: 'default' })
	key: string

	/** Токен бота Telegram: AES-256-GCM, «iv.tag.данные» в base64 (common/seal); наружу не отдаётся */
	@prop({ default: '' })
	token: string

	/** Числовой Telegram ID получателя (у группы — отрицательный) */
	@prop({ default: '' })
	chatId: string
}

export const TG_STATES = ['none', 'sent', 'failed'] as const

export class FeedbackCompany {
	@prop({ type: mongoose.Types.ObjectId, default: null })
	id: mongoose.Types.ObjectId | null

	@prop({ default: '' })
	name: string
}

export class FeedbackAuthor {
	@prop({ type: mongoose.Types.ObjectId, required: true })
	id: mongoose.Types.ObjectId

	@prop({ default: '' })
	name: string

	@prop({ default: '' })
	login: string

	@prop({ default: '' })
	role: string
}

export interface FeedbackMessage extends Base {}

/**
 * Сообщение обратной связи. Данные платформы (без местности в смысле tenantPlugin), хранятся бессрочно.
 * Местность и автор — снимком на момент отправки: удаление местности или пользователя сообщения не трогает.
 */
@modelOptions({ options: { allowMixed: 0 }, schemaOptions: { collection: 'FeedbackMessages' } })
export class FeedbackMessage {
	@prop({ type: () => FeedbackCompany, _id: false, required: true })
	company: FeedbackCompany

	@prop({ type: () => FeedbackAuthor, _id: false, required: true })
	user: FeedbackAuthor

	@prop({ required: true })
	text: string

	@prop({ default: () => new Date() })
	createdAt: Date

	@prop({ type: Date, default: null })
	readAt: Date | null

	/** Пересылка в Telegram: none — не настроена, sent, failed */
	@prop({ type: String, enum: TG_STATES as unknown as string[], default: 'none' })
	tg: string
}
