/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { BadGatewayException, HttpException, HttpStatus, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { ModelType } from '@typegoose/typegoose/lib/types'
import { Types } from 'mongoose'
import { InjectModel } from 'nestjs-typegoose'
import { Company } from '../company/company.model'
import { seal, sealSecret, unseal } from '../common/seal'
import { FeedbackListDto, FeedbackSettingsDto } from './dto/feedback.dto'
import { FeedbackMessage, FeedbackSettings } from './feedback.model'

const KEY = 'default'
// не больше стольких сообщений от одного пользователя за окно
export const FEEDBACK_LIMIT = 5
export const FEEDBACK_WINDOW = 10 * 60_000
// и не больше стольких со всей установки за час: ни база, ни чат владельца не должны заваливаться
export const FEEDBACK_TOTAL = 60
export const FEEDBACK_TOTAL_WINDOW = 3600_000
const NOT_SET = 'Обратная связь пока не настроена'

/** Роль автора на момент отправки — как её показывает приложение */
export const roleOf = (user: any) => (user?.isSuperAdmin ? 'Супер-админ' : user?.role?.name || 'Пользователь')

/** Сообщение владельцу в Telegram: обычный текст, без разметки — из текста пользователя ничего не интерпретируется */
export function feedbackMessage(m: Pick<FeedbackMessage, 'company' | 'user' | 'text'>) {
	return ['Skladan · обратная связь', `Местность: ${m.company?.name || '—'}`, `От: ${m.user?.name || '—'} (${m.user?.login || '—'}), ${m.user?.role || '—'}`, '', m.text].join('\n')
}

/** Ответ Telegram с ошибкой → короткая причина по-русски; токен в неё не попадает, даже если Telegram его повторит */
export function telegramReason(status: number, description: string, token: string) {
	const d = String(description || '')
	if (status === 401 || status === 404) return 'Telegram не принял токен бота'
	if (/chat not found/i.test(d)) return 'Чат не найден — получатель должен нажать Start у бота'
	if (/blocked by the user/i.test(d)) return 'Получатель заблокировал бота'
	if (/initiate conversation/i.test(d)) return 'Получатель должен нажать Start у бота'
	if (status === 429) return 'Telegram просит подождать — попробуйте позже'
	const safe = (token ? d.split(token).join('…') : d).slice(0, 200)
	return safe ? `Telegram: ${safe}` : `Telegram ответил ошибкой ${status}`
}

@Injectable()
export class FeedbackService {
	constructor(
		@InjectModel(FeedbackSettings) private readonly settingsModel: ModelType<FeedbackSettings>,
		@InjectModel(FeedbackMessage) private readonly messageModel: ModelType<FeedbackMessage>,
		@InjectModel(Company) private readonly companyModel: ModelType<Company>,
		private readonly config: ConfigService
	) {}

	private readonly logger = new Logger(FeedbackService.name)
	/** Отправки по пользователям: моменты в пределах окна. Один процесс сервера — счёт в памяти */
	private readonly sent = new Map<string, number[]>()
	private readonly total: number[] = []

	private secret() {
		return sealSecret(this.config, 'feedback')
	}

	private find() {
		return this.settingsModel.findOne({ key: KEY }).lean().exec()
	}

	async settings() {
		const s = await this.find()
		return { chatId: s?.chatId || '', hasToken: !!s?.token }
	}

	async saveSettings(dto: FeedbackSettingsDto) {
		const $set: Record<string, string> = {}
		if (dto.token) $set.token = seal(dto.token, sealSecret(this.config, 'feedback', true))
		if (dto.chatId !== undefined) $set.chatId = dto.chatId
		if (Object.keys($set).length) await this.settingsModel.updateOne({ key: KEY }, { $set }, { upsert: true }).exec()
		return this.settings()
	}

	/** Отправить получателю; ошибка — 503 без настройки, 502 с причиной (без токена) */
	private async send(text: string) {
		const s = await this.find()
		if (!s?.token || !s.chatId) throw new ServiceUnavailableException(NOT_SET)
		let token: string
		try {
			token = unseal(s.token, this.secret())
		} catch {
			throw this.failed('Сохранённый токен не читается — сохраните его заново')
		}
		let res: Response
		try {
			// только свой хост и без переходов: токен в адресе не уйдёт никуда, кроме Telegram
			res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ chat_id: s.chatId, text }),
				redirect: 'error',
				signal: AbortSignal.timeout(8_000),
			})
		} catch {
			throw this.failed('Telegram недоступен')
		}
		const body: any = await res.json().catch(() => null)
		if (!res.ok || !body?.ok) throw this.failed(telegramReason(res.status, body?.description, token))
	}

	private failed(reason: string) {
		this.logger.warn(`Обратная связь не отправлена: ${reason}`)
		return new BadGatewayException(reason)
	}

	/**
	 * Сообщение пользователя: сохраняется и сразу подтверждается; Telegram — после ответа, фоном, его сбой пользователю не виден.
	 * Текст не попадает ни в историю изменений, ни в счётчик использования, ни в журнал.
	 */
	async submit(user: any, text: string) {
		const id = String(user?._id)
		const now = Date.now()
		// один массив на пользователя, меняется на месте: одновременные запросы видят и снимают отметки друг друга
		const times = this.sent.get(id) || []
		while (times.length && now - times[0] >= FEEDBACK_WINDOW) times.shift()
		if (times.length >= FEEDBACK_LIMIT) {
			const minutes = Math.max(1, Math.ceil((times[0] + FEEDBACK_WINDOW - now) / 60_000))
			throw new HttpException(`Слишком много сообщений — повторите через ${minutes} мин.`, HttpStatus.TOO_MANY_REQUESTS)
		}
		while (this.total.length && now - this.total[0] >= FEEDBACK_TOTAL_WINDOW) this.total.shift()
		if (this.total.length >= FEEDBACK_TOTAL) throw new HttpException('Слишком много сообщений — попробуйте позже', HttpStatus.TOO_MANY_REQUESTS)
		// место занимается до сохранения (одновременные запросы не проскочат предел) и освобождается, только если не сохранилось
		times.push(now)
		this.sent.set(id, times)
		this.total.push(now)
		let msg: any
		try {
			const company = user?.company
				? await this.companyModel.findById(user.company).select('name').setOptions({ skipTenantScope: true } as any).lean().exec()
				: null
			msg = await this.messageModel.create({
				company: { id: user?.company ? new Types.ObjectId(String(user.company._id || user.company)) : null, name: company?.name || '' },
				user: { id: new Types.ObjectId(id), name: user?.name || '', login: user?.login || '', role: roleOf(user) },
				text,
			})
		} catch (e) {
			for (const list of [times, this.total]) {
				const i = list.indexOf(now)
				if (i >= 0) list.splice(i, 1)
			}
			throw e
		}
		void this.forward(msg)
		return { ok: true }
	}

	/** Пересылка в Telegram с записью исхода; не настроено — остаётся none. Никогда не бросает: ответ пользователю уже ушёл */
	async forward(msg: { _id: unknown; company: any; user: any; text: string }) {
		let tg = 'sent'
		try {
			await this.send(feedbackMessage(msg))
		} catch (e) {
			// причину (без токена) send уже записал в журнал
			tg = e instanceof ServiceUnavailableException ? 'none' : 'failed'
		}
		if (tg === 'none') return
		await this.messageModel.updateOne({ _id: msg._id }, { $set: { tg } }).exec().catch(() => this.logger.warn('Обратная связь: не записан исход пересылки'))
	}

	private unread() {
		return this.messageModel.countDocuments({ readAt: null }).exec()
	}

	/** Новые сверху, постранично: before — _id последнего показанного */
	async list(q: FeedbackListDto) {
		const limit = Math.min(100, Math.max(1, Number(q.limit) || 50))
		const rows = await this.messageModel
			.find(q.before ? { _id: { $lt: new Types.ObjectId(q.before) } } : {})
			.sort({ _id: -1 })
			.limit(limit + 1)
			.select('-__v')
			.lean()
			.exec()
		return { items: rows.slice(0, limit), unread: await this.unread(), more: rows.length > limit }
	}

	async unreadCount() {
		return { unread: await this.unread() }
	}

	/** Отметить прочитанными перечисленные или все */
	async markRead(ids?: string[]) {
		const filter: Record<string, unknown> = { readAt: null }
		if (ids) filter._id = { $in: ids.map((x) => new Types.ObjectId(x)) }
		await this.messageModel.updateMany(filter, { $set: { readAt: new Date() } }).exec()
		return { unread: await this.unread() }
	}

	/** Удаление настоящее (не пометка): сообщения долго не хранятся */
	async remove(id: string) {
		const r = await this.messageModel.deleteOne({ _id: new Types.ObjectId(id) }).exec()
		return { deleted: r.deletedCount || 0 }
	}

	/** Все или только прочитанные: новые при этом не трогаются */
	async removeAll(readOnly: boolean) {
		const r = await this.messageModel.deleteMany(readOnly ? { readAt: { $ne: null } } : {}).exec()
		return { deleted: r.deletedCount || 0 }
	}

	async test() {
		await this.send('Skladan · проверка обратной связи')
		return { ok: true }
	}
}
