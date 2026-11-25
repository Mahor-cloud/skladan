/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { ServiceUnavailableException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'

// Шифрование секретов, которые нужны серверу в исходном виде (хеш не подходит): пароль сайта, токен бота

const key = (secret: string) => createHash('sha256').update(secret).digest()

/** Текст → «iv.tag.данные» (AES-256-GCM, base64) */
export function seal(text: string, secret: string) {
	const iv = randomBytes(12)
	const cipher = createCipheriv('aes-256-gcm', key(secret), iv, { authTagLength: 16 })
	const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
	return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.')
}

export function unseal(sealed: string, secret: string) {
	const [iv, tag, data] = String(sealed).split('.').map((s) => Buffer.from(s, 'base64'))
	// короткая метка ослабила бы проверку подлинности
	if (iv?.length !== 12 || tag?.length !== 16 || !data) throw new Error('Неверный формат зашифрованного значения')
	const decipher = createDecipheriv('aes-256-gcm', key(secret), iv, { authTagLength: 16 })
	decipher.setAuthTag(tag)
	return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

/**
 * Секрет шифрования: метка данных и LITNA_KEY, без него — JWT_SECRET; label разводит секреты разных данных.
 * saving — для записи: в бою новые секреты шифруются только своим ключом, чтение старых и запуск сервера без него работают.
 */
export function sealSecret(config: ConfigService, label: string, saving = false) {
	const own = config.get('LITNA_KEY')
	const jwt = config.get('JWT_SECRET')
	if (saving && config.get('NODE_ENV') === 'production' && String(own || '').length < 32) throw new ServiceUnavailableException('Не задан ключ LITNA_KEY')
	if (!own && !jwt) throw new Error('Не задан ни LITNA_KEY, ни JWT_SECRET')
	return `${label}:${own || jwt}`
}
