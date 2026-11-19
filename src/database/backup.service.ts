/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { ConflictException, Injectable, Logger } from '@nestjs/common'
import { ModelType } from '@typegoose/typegoose/lib/types'
import { once } from 'events'
import { createReadStream, createWriteStream, promises as fs } from 'fs'
import { mongo } from 'mongoose'
import { InjectModel } from 'nestjs-typegoose'
import { tmpdir } from 'os'
import { join } from 'path'
import { pipeline } from 'stream/promises'
import { createGzip } from 'zlib'
import { Company } from '../company/company.model'

const PREFIX = 'skladan-manual-'

/** Заголовок файла в архиве tar (формат ustar): имя, размер, время и контрольная сумма в блоке 512 байт. */
export function tarHeader(
	name: string,
	size: number,
	mtime = Math.floor(Date.now() / 1000)
): Buffer {
	if (Buffer.byteLength(name) > 100)
		throw new Error(`Имя слишком длинное для tar: ${name}`)
	const h = Buffer.alloc(512)
	h.write(name, 0, 100, 'utf8')
	h.write('0000644\0', 100)
	h.write('0000000\0', 108)
	h.write('0000000\0', 116)
	h.write(size.toString(8).padStart(11, '0') + '\0', 124)
	h.write(mtime.toString(8).padStart(11, '0') + '\0', 136)
	h.fill(' ', 148, 156) // на время подсчёта контрольной суммы её поле — пробелы
	h.write('0', 156)
	h.write('ustar\0' + '00', 257)
	let sum = 0
	for (const byte of h) sum += byte
	h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
	return h
}

/** Имя файла бэкапа по времени (по Москве): skladan-manual-2026-11-20_013005.tar */
export const backupName = (now = Date.now()) =>
	PREFIX +
	new Date(now + 3 * 3600 * 1000)
		.toISOString()
		.slice(0, 19)
		.replace('T', '_')
		.replace(/:/g, '') +
	'.tar'

/**
 * Полный бэкап базы по кнопке супер-админа — дополнительно к бэкапу по расписанию (тот делает сам сервер, не приложение).
 * Содержимое — как у `mongodump --gzip`: на каждую коллекцию `<база>/<коллекция>.bson.gz` (документы как они лежат в базе)
 * и `<коллекция>.metadata.json.gz` (индексы), всё в одном tar. Восстановление — обычным `mongorestore --gzip` (см. DEPLOY.md).
 * Хранится один бэкап: новый готов — прежние, сделанные этой кнопкой, удаляются. Бэкапы по расписанию не трогаются.
 */
@Injectable()
export class BackupService {
	private readonly logger = new Logger('Backup')
	private busy = false

	constructor(
		@InjectModel(Company) private readonly companyModel: ModelType<Company>
	) {}

	/** Куда складываются бэкапы: на боевом сервере — папка сервера, подключённая в контейнер (BACKUP_DIR). */
	private get dir() {
		return process.env.BACKUP_DIR || join(tmpdir(), 'skladan-backups')
	}

	/** Последний бэкап, сделанный кнопкой: { name, size, at } или null. */
	async last() {
		const names = (await fs.readdir(this.dir).catch(() => [] as string[]))
			.filter((n) => n.startsWith(PREFIX) && n.endsWith('.tar'))
			.sort()
		const name = names[names.length - 1]
		if (!name) return null
		const stat = await fs.stat(join(this.dir, name))
		return { name, size: stat.size, at: stat.mtimeMs }
	}

	/** Снять новый бэкап, удалить прежние, вернуть свежий: { name, size, path }. */
	async create() {
		if (this.busy)
			throw new ConflictException('Бэкап уже создаётся — дождитесь окончания')
		this.busy = true
		const started = Date.now()
		const work = await fs.mkdtemp(join(tmpdir(), 'skladan-dump-'))
		const name = backupName()
		const target = join(this.dir, name)
		try {
			await fs.mkdir(this.dir, { recursive: true })
			const db = this.companyModel.db.db
			const parts: { entry: string; file: string }[] = []
			const collections = (
				await db.listCollections({}, { nameOnly: false }).toArray()
			)
				.filter((c: any) => c.type !== 'view' && !c.name.startsWith('system.'))
				.sort((a, b) => a.name.localeCompare(b.name))
			for (const info of collections as any[]) {
				// Документы пишутся теми же байтами, что отдаёт база (raw): без разбора и повторной сборки
				const data = join(work, `${info.name}.bson.gz`)
				const gz = createGzip()
				const done = pipeline(gz, createWriteStream(data))
				for await (const doc of db
					.collection(info.name)
					.find({}, { raw: true }))
					if (!gz.write(doc as unknown as Buffer)) await once(gz, 'drain')
				gz.end()
				await done
				const meta = join(work, `${info.name}.metadata.json.gz`)
				const indexes = await db.collection(info.name).indexes()
				const uuid = info.info?.uuid
					? Buffer.from(info.info.uuid.buffer).toString('hex')
					: undefined
				const metaGz = createGzip()
				const metaDone = pipeline(metaGz, createWriteStream(meta))
				metaGz.end(
					mongo.BSON.EJSON.stringify(
						{
							indexes,
							uuid,
							collectionName: info.name,
							type: 'collection',
							options: info.options || {},
						},
						{ relaxed: false }
					)
				)
				await metaDone
				parts.push(
					{ entry: `${db.databaseName}/${info.name}.bson.gz`, file: data },
					{
						entry: `${db.databaseName}/${info.name}.metadata.json.gz`,
						file: meta,
					}
				)
			}

			// Сначала во временный файл: недописанный архив не должен выглядеть готовым бэкапом
			const out = createWriteStream(target + '.tmp')
			const write = async (chunk: Buffer) => {
				if (!out.write(chunk)) await once(out, 'drain')
			}
			for (const part of parts) {
				const { size } = await fs.stat(part.file)
				await write(tarHeader(part.entry, size))
				for await (const chunk of createReadStream(part.file))
					await write(chunk as Buffer)
				if (size % 512) await write(Buffer.alloc(512 - (size % 512)))
			}
			await write(Buffer.alloc(1024))
			out.end()
			await once(out, 'finish')
			await fs.rename(target + '.tmp', target)

			// Остаётся только свежий: прежние бэкапы этой кнопки и недописанные файлы удаляются
			for (const old of await fs.readdir(this.dir))
				if (old.startsWith(PREFIX) && old !== name)
					await fs.rm(join(this.dir, old), { force: true })
			const { size } = await fs.stat(target)
			this.logger.log(
				`бэкап ${name}: коллекций ${collections.length}, ${size} байт, ${Date.now() - started} мс`
			)
			return { name, size, path: target }
		} catch (e) {
			await fs.rm(target + '.tmp', { force: true })
			throw e
		} finally {
			await fs.rm(work, { recursive: true, force: true })
			this.busy = false
		}
	}
}
