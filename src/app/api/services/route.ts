import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    const limit = Math.min(Number(req.nextUrl.searchParams.get('limit') ?? 100), 500)
    const competitorId = req.nextUrl.searchParams.get('competitorId') ?? undefined
    const q = req.nextUrl.searchParams.get('q')?.trim()

    const services = await db.service.findMany({
      take: limit,
      where: {
        competitorId,
        isActive: true,
        ...(q
          ? {
              OR: [
                { name: { contains: q } },
                { nameRaw: { contains: q } },
                { code: { contains: q } },
                { externalId: { contains: q } },
              ],
            }
          : {}),
      },
      orderBy: { lastSeenAt: 'desc' },
      include: {
        competitor: {
          select: { id: true, name: true, baseUrl: true },
        },
        snapshots: {
          take: 1,
          orderBy: { scrapedAt: 'desc' },
        },
      },
    })

    return NextResponse.json({
      services: services.map((service) => {
        const latest = service.snapshots[0]
        return {
          id: service.id,
          competitorId: service.competitorId,
          competitorName: service.competitor.name,
          externalId: service.externalId,
          externalIdType: service.externalIdType,
          code: service.code,
          slug: service.slug,
          name: service.name,
          nameRaw: service.nameRaw,
          category: service.category,
          url: service.url,
          lastSeenAt: service.lastSeenAt,
          latestPrice: latest?.price ?? null,
          latestCurrency: latest?.currency ?? null,
          latestScrapedAt: latest?.scrapedAt ?? null,
          latestRegion: latest?.region ?? null,
        }
      }),
      total: services.length,
    })
  } catch (error) {
    logger.error({ err: error, module: 'api/services' }, 'Failed to list services')
    return NextResponse.json({ error: 'Failed to fetch services' }, { status: 500 })
  }
}
