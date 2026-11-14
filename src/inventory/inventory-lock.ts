/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { BadRequestException } from '@nestjs/common'
import { ModelType } from '@typegoose/typegoose/lib/types'
import { Message } from 'src/database/messages.model'
import { Inventory } from './inventory.model'

// Company setting (Admin, председатель): inventory may start while orders/purchases are open,
// and new orders/purchases may be created during it. Tenant plugin scopes both queries to the company.
export async function openDocsAllowed(messageModel: ModelType<Message>): Promise<boolean> {
	const msg = await messageModel.findOne().select('allowInventoryWithOpenDocs').lean().exec()
	return msg?.allowInventoryWithOpenDocs === true
}

// While an inventory is open, nothing may move Product.quantity: the count would overwrite it.
export async function assertStockNotFrozen(inventoryModel: ModelType<Inventory>, message: string): Promise<void> {
	const active = await inventoryModel.findOne({ isCompleted: false }).select('_id').lean().exec()
	if (active) throw new BadRequestException({ code: 'ACTIVE_INVENTORY', message })
}
