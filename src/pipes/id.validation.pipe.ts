import {
	ArgumentMetadata,
	BadRequestException,
	PipeTransform,
} from '@nestjs/common'
import { Types } from 'mongoose'

export class IdValidationPipe implements PipeTransform {
	transform(value: any, metadata: ArgumentMetadata) {
		if (metadata.type !== 'param') return value

		if (metadata.data === 'id' && !Types.ObjectId.isValid(value)) {
			throw new BadRequestException('Неверный формат id')
		}

		return value
	}
}
