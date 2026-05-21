/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { modelOptions, prop } from '@typegoose/typegoose'

@modelOptions({
	schemaOptions: { collection: 'MetricSnapshots', timestamps: { createdAt: true, updatedAt: false } },
})
export class MetricSnapshot {
	@prop({ required: true, index: { expireAfterSeconds: 90 * 24 * 3600 } })
	createdAt!: Date

	@prop({ type: Object, required: true, _id: false })
	payload!: Record<string, number>
}
