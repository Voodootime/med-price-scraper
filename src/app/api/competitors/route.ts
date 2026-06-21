/**
 * API: /api/competitors
 *
 * GET    — список конкурентов
 * POST   — добавить нового конкурента (trigger probe)
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { logger } from '@/lib/logger'
import { loadConfig } from '@/lib/config'
import { assertPublicHttpUrl, UnsafeUrlError } from '@/lib/security/url-policy'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const competitors = await db.competitor.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        baseUrl: true,
        status: true,
        tier: true,
        regionStrategy: true,
        lastProbeAt: true,
        lastScrapeAt: true,
        itemsCount: true,
        confidenceScore: true,
        createdAt: true,
      },
    })

    return NextResponse.json({
      competitors,
      total: competitors.length,
      region: loadConfig().TARGET_REGION,
    })
  } catch (e) {
    logger.error({ err: e }, 'Failed to list competitors')
    return NextResponse.json(
      { error: 'Failed to fetch competitors', details: (e as Error).message },
      { status: 500 }
    )
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { name, baseUrl } = body

    if (!name || !baseUrl) {
      return NextResponse.json({ error: 'name and baseUrl are required' }, { status: 400 })
    }

    let normalizedBaseUrl: string
    try {
      normalizedBaseUrl = (await assertPublicHttpUrl(baseUrl)).origin
    } catch (e) {
      const message = e instanceof UnsafeUrlError ? e.message : 'Invalid baseUrl'
      return NextResponse.json({ error: message }, { status: 400 })
    }

    // Проверка дубликата
    const existing = await db.competitor.findFirst({
      where: { OR: [{ baseUrl: normalizedBaseUrl }, { baseUrl: `${normalizedBaseUrl}/` }] },
    })
    if (existing) {
      return NextResponse.json({ error: 'Competitor with this URL already exists', id: existing.id }, { status: 409 })
    }

    // Создаём конкурента со статусом 'new' — probe будет запущен отдельно
    const competitor = await db.competitor.create({
      data: {
        name,
        baseUrl: normalizedBaseUrl,
        status: 'new',
      },
    })

    logger.info({ competitorId: competitor.id, name, baseUrl: normalizedBaseUrl }, 'Competitor created')

    // Probe Engine запускается отдельно через POST /api/probe с { competitorId }.
    // См. src/app/api/probe/route.ts и src/scraper/strategies/probe-engine.ts.

    return NextResponse.json({ competitor }, { status: 201 })
  } catch (e) {
    logger.error({ err: e }, 'Failed to create competitor')
    return NextResponse.json(
      { error: 'Failed to create competitor', details: (e as Error).message },
      { status: 500 }
    )
  }
}
