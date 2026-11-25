/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { Body, Controller, Delete, ForbiddenException, Get, Param, ParseIntPipe, Post, Put, Query, Res, StreamableFile } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import type { Response } from 'express'
import { Auth } from '../auth/decorators/auth.decorator'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { UserModel } from '../auth/user.model'
import { IdValidationPipe } from '../pipes/id.validation.pipe'
import { LitnaAccountDto, LitnaDocDto, LitnaLinksDto, LitnaLoginDto, LitnaOrderDto, LitnaPayDto, LitnaPointsDto } from './dto/litna.dto'
import { LitnaService } from './litna.service'

// Маршруты, которые ходят на сайт: частота с одного адреса ограничена — сайт чужой, и каждый запрос к нему не бесплатен
const SITE = { default: { limit: 20, ttl: 60_000 } }

// Всё про lit-na.ru — внутри местности: у супер-админа без местности ни аккаунта, ни закупок
function local(user: any) {
	if (!user?.company) throw new ForbiddenException('Доступно только внутри местности')
}

// Настройку ведут те, у кого есть право создавать или править закупки (галочка «служащий» не требуется); роль подставлена в пользователя при входе в запрос.
// true — право настройки, false — пропущен только по одному из also
function setup(user: any, also: string[] = []) {
	local(user)
	const perms: string[] = user?.role?.permissions || []
	if (['create_purchases', 'edit_purchases'].some((p) => perms.includes(p))) return true
	if (also.some((p) => perms.includes(p))) return false
	throw new ForbiddenException('У вас нету доступа для выполнения данного действия.')
}

@Controller('litna')
export class LitnaController {
	constructor(private readonly litna: LitnaService) {}

	@Get('account')
	@Auth()
	account(@CurrentUser() user: UserModel) {
		const full = setup(user, ['view_purchases'])
		// тот, кто настраивает: пункты Яндекса грузятся заранее, фоном
		if (full) this.litna.prewarmPoints()
		return this.litna.account(full)
	}

	@Put('account')
	@Auth()
	saveAccount(@CurrentUser() user: UserModel, @Body() dto: LitnaAccountDto) {
		setup(user)
		return this.litna.saveAccount(dto, user)
	}

	/** Вход под аккаунтом сайта (необязателен): проверяется сейчас, сохраняется только удачный */
	@Post('account/login')
	@Auth()
	@Throttle({ default: { limit: 5, ttl: 60_000 } })
	login(@CurrentUser() user: UserModel, @Body() dto: LitnaLoginDto) {
		setup(user)
		return this.litna.login(dto, user)
	}

	/** Сверка адреса приложения с кабинетом lit-na.ru: { same, site } — см. LitnaService.addressCheck */
	@Get('account/address')
	@Auth()
	@Throttle(SITE)
	addressCheck(@CurrentUser() user: UserModel) {
		setup(user)
		return this.litna.addressCheck()
	}

	/** Вход заранее при открытии закупки: { login, loginFailed }; неудачный вход — не ошибка запроса */
	@Post('account/warm')
	@Auth()
	warm(@CurrentUser() user: UserModel) {
		setup(user)
		this.litna.prewarmPoints()
		return this.litna.warm(user)
	}

	/** Выйти в гостя: дальше заказы — без входа */
	@Post('account/logout')
	@Auth()
	logout(@CurrentUser() user: UserModel) {
		setup(user)
		return this.litna.logout(user)
	}

	@Get('points')
	@Auth()
	@Throttle(SITE)
	points(@CurrentUser() user: UserModel, @Query() query: LitnaPointsDto) {
		setup(user)
		return this.litna.points(query.kind, query.city)
	}

	/** seeds=1 — для «Семян»: супер-админу и без местности; иначе — настройка или право видеть закупки (остаток сайта в закупке) */
	@Get('catalog')
	@Auth()
	catalog(@CurrentUser() user: UserModel, @Query('seeds') seeds?: string) {
		if (seeds === '1') {
			if (!user?.isSuperAdmin) throw new ForbiddenException('У вас нету доступа для выполнения данного действия.')
			return this.litna.catalog(true)
		}
		setup(user, ['view_purchases'])
		return this.litna.catalog()
	}

	/** Картинка товара сайта для обложки: тому, кто правит товары, и супер-админу (семена). Байты как есть, на сервере не хранятся. */
	@Get('image/:siteId')
	@Auth()
	@Throttle(SITE)
	async image(@Param('siteId', ParseIntPipe) siteId: number, @CurrentUser() user: UserModel, @Res() res: Response) {
		const perms: string[] = (user?.role as any)?.permissions || []
		if (!user?.isSuperAdmin && !(user?.isAdmin && (perms.includes('edit_products') || perms.includes('create_product')))) {
			throw new ForbiddenException('У вас нету доступа для выполнения данного действия.')
		}
		const { contentType, bytes } = await this.litna.image(siteId)
		// как у фото товаров: ответ с домена приложения не исполняется как страница
		res.set({ 'Content-Type': contentType, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" })
		res.send(bytes)
	}

	/** Миниатюра товара сайта для списка выбора: без авторизации (<img> не шлёт ключ), как обложки товаров; картинка не секрет */
	@Get('thumb/:siteId')
	async thumb(@Param('siteId', ParseIntPipe) siteId: number, @Res() res: Response) {
		const { contentType, bytes } = await this.litna.thumb(siteId)
		res.set({ 'Content-Type': contentType, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" })
		res.send(bytes)
	}

	/** Массовая правка пар «наш товар ↔ товар сайта»: пишет litnaId в перечисленные товары местности */
	@Put('links')
	@Auth()
	links(@CurrentUser() user: UserModel, @Body() dto: LitnaLinksDto) {
		setup(user)
		return this.litna.saveLinks(dto.links, user)
	}

	@Post('purchases/:id/quote')
	@Auth('user', ['create_purchases'])
	@Throttle(SITE)
	quote(@Param('id', IdValidationPipe) id: string, @CurrentUser() user: UserModel) {
		local(user)
		return this.litna.quote(id, user)
	}

	/** Что сервер делает на сайте по этой закупке прямо сейчас (пока идёт расчёт или заказ); на сайт не ходит */
	@Get('purchases/:id/step')
	@Auth('user', ['create_purchases'])
	step(@Param('id', IdValidationPipe) id: string, @CurrentUser() user: UserModel) {
		local(user)
		return this.litna.step(id, user)
	}

	@Post('purchases/:id/order')
	@Auth('user', ['create_purchases'])
	@Throttle(SITE)
	order(@Param('id', IdValidationPipe) id: string, @Body() dto: LitnaOrderDto, @CurrentUser() user: UserModel) {
		local(user)
		return this.litna.order(id, dto.total, user, dto.guest === true)
	}

	@Post('purchases/:id/pay')
	@Auth('user', ['approve-payment'])
	@Throttle(SITE)
	pay(@Param('id', IdValidationPipe) id: string, @Body() dto: LitnaPayDto, @CurrentUser() user: UserModel) {
		local(user)
		// способ оплаты не применяется: форма Robokassa одна, способ выбирается на её странице
		return this.litna.pay(id, user)
	}

	@Post('purchases/:id/check')
	@Auth('user', ['view_purchases'])
	@Throttle({ default: { limit: 30, ttl: 60_000 } })
	check(@Param('id', IdValidationPipe) id: string, @CurrentUser() user: UserModel) {
		local(user)
		return this.litna.check(id, user)
	}

	@Get('purchases/:id/doc')
	@Auth('user', ['view_purchases'])
	@Throttle(SITE)
	async doc(@Param('id', IdValidationPipe) id: string, @Query() query: LitnaDocDto, @CurrentUser() user: UserModel): Promise<StreamableFile> {
		local(user)
		const { bytes, name } = await this.litna.doc(id, query.type)
		return new StreamableFile(bytes, { type: 'application/pdf', disposition: `attachment; filename="${name}"`, length: bytes.length })
	}

	@Post('purchases/:id/release')
	@Auth()
	release(@Param('id', IdValidationPipe) id: string, @CurrentUser() user: UserModel) {
		setup(user)
		return this.litna.release(id, user)
	}

	/** Отвязать созданную неоплаченную закупку от заказа сайта (заказ на сайте отменяется): право редактировать закупки */
	@Post('purchases/:id/detach')
	@Auth('user', ['edit_purchases'])
	detach(@Param('id', IdValidationPipe) id: string, @CurrentUser() user: UserModel) {
		local(user)
		return this.litna.detach(id, user)
	}

	@Delete('purchases/:id')
	@Auth('user', ['delete_purchases'])
	remove(@Param('id', IdValidationPipe) id: string, @CurrentUser() user: UserModel) {
		local(user)
		return this.litna.remove(id, user)
	}
}
