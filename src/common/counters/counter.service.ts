import { Injectable } from '@nestjs/common'
import { ModelType } from '@typegoose/typegoose/lib/types'
import { Types } from 'mongoose'
import { InjectModel } from 'nestjs-typegoose'
import { Counter } from './counter.model'

export type CounterType = 'order' | 'purchase'

@Injectable()
export class CounterService {
	constructor(
		@InjectModel(Counter) private readonly counterModel: ModelType<Counter>
	) {}

	async getNext(company: Types.ObjectId | string, type: CounterType): Promise<number> {
		const companyId = typeof company === 'string' ? new Types.ObjectId(company) : company
		const result = await this.counterModel
			.findOneAndUpdate(
				{ company: companyId, type },
				{ $inc: { value: 1 } },
				{ upsert: true, new: true, setDefaultsOnInsert: true }
			)
			.setOptions({ skipTenantScope: true } as any)
			.exec()
		return result.value
	}


	async ensureAtLeast(company: Types.ObjectId | string, type: CounterType, value: number): Promise<number> {
		const companyId = typeof company === 'string' ? new Types.ObjectId(company) : company
		const result = await this.counterModel
			.findOneAndUpdate(
				{ company: companyId, type },
				{ $max: { value } },
				{ upsert: true, new: true, setDefaultsOnInsert: true }
			)
			.setOptions({ skipTenantScope: true } as any)
			.exec()
		return result.value
	}
}
