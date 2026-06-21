import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { loadConfig } from '@/lib/config'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const since = new Date()
    since.setHours(0, 0, 0, 0)

    const [competitors, services, scrapesToday, alerts] = await Promise.all([
      db.competitor.count(),
      db.service.count({ where: { isActive: true } }),
      db.scrapeRun.count({ where: { startedAt: { gte: since } } }),
      db.scrapeAlert.count({ where: { acknowledged: false } }),
    ])

    return NextResponse.json({
      competitors,
      services,
      scrapesToday,
      alerts,
      region: loadConfig().TARGET_REGION,
      generatedAt: new Date().toISOString(),
    })
  } catch (error) {
    logger.error({ err: error, module: 'api/stats' }, 'Failed to load stats')
    return NextResponse.json({ error: 'Failed to fetch stats' }, { status: 500 })
  }
}
