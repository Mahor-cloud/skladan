/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { HttpException, HttpStatus, Injectable } from '@nestjs/common'
import { ModelType } from '@typegoose/typegoose/lib/types'
import { Types } from 'mongoose'
import { InjectModel } from 'nestjs-typegoose'
import { Company } from '../company/company.model'
import { FeedbackListDto } from './dto/feedback.dto'
import { FeedbackMessage } from './feedback.model'

// не больше стольких сообщений от одного пользователя за окно
export const FEEDBACK_LIMIT = 5
export const FEEDBACK_WINDOW = 10 * 60_000
// и не больше стольких со всей установки за час: база не должна заваливаться
export const FEEDBACK_TOTAL = 60
export const FEEDBACK_TOTAL_WINDOW = 3600_000

/** Роль автора на момент отправки — как её показывает приложение */
export const roleOf = (user: any) => (user?.isSuperAdmin ? 'Супер-админ' : user?.role?.name || 'Пользователь')

@Injectable()
export class FeedbackService {
	constructor(
		@InjectModel(FeedbackMessage) private readonly messageModel: ModelType<FeedbackMessage>,
		@InjectModel(Company) private readonly companyModel: ModelType<Company>
	) {}

	/** Отправки по пользователям: моменты в пределах окна. Один процесс сервера — счёт в памяти */
	private readonly sent = new Map<string, number[]>()
	private readonly total: number[] = []

	/**
	 * Сообщение пользователя: сохраняется, читает супер-админ в разделе «Обратная связь».
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
		try {
			const company = user?.company
				? await this.companyModel.findById(user.company).select('name').setOptions({ skipTenantScope: true } as any).lean().exec()
				: null
			await this.messageModel.create({
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
		return { ok: true }
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
}
