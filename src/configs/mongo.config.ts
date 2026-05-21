/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { ConfigService } from '@nestjs/config'
import { TypegooseModuleOptions } from 'nestjs-typegoose'

export const getMongoDbConfig = async (
	configService: ConfigService
): Promise<TypegooseModuleOptions> => ({
	uri: configService.get('MONGO_URI'),
	serverSelectionTimeoutMS: 5000,
	socketTimeoutMS: 45000,
	maxPoolSize: 50,
	retryWrites: true,
	retryReads: true,
})
