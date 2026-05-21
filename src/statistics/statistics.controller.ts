/**
 * Copyright 2026 Lord_mahor
 * Licensed under Apache 2.0
 */

import { Controller, Get, Header, Query, Res } from '@nestjs/common'
import type { Response } from 'express'
import { Auth } from '../auth/decorators/auth.decorator'
import { DashboardQueryDto, TimelineQueryDto } from './dto/dashboard-query.dto'
import { StatisticsService } from './statistics.service'

@Controller('statistics')
export class StatisticsController {
	constructor(private readonly statisticsService: StatisticsService) {}

	@Get('dashboard')
	@Auth('user', ['view_statistics'])
	getDashboard(@Query() query: DashboardQueryDto) {
		return this.statisticsService.getDashboard(query)
	}

	@Get('period-bounds')
	@Auth('user', ['view_statistics'])
	getPeriodBounds() {
		return this.statisticsService.getPeriodBounds()
	}

	@Get('timeline')
	@Auth('user', ['view_statistics'])
	getTimeline(@Query() query: TimelineQueryDto) {
		return this.statisticsService.getTimeline(query)
	}

	@Get('export')
	@Auth('user', ['export_statistics'])
	@Header('Content-Type', 'text/csv; charset=utf-8')
	@Header('Content-Disposition', 'attachment; filename="skladan-statistics.csv"')
	async exportCsv(@Query() query: DashboardQueryDto, @Res() res: Response) {
		const csv = await this.statisticsService.exportCsv(query)
		res.send(csv)
	}
}
