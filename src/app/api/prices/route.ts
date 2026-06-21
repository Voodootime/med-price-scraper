import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    const limit = Math.min(Number(req.nextUrl.searchParams.get('limit') ?? 100), 500)
    const serviceId = req.nextUrl.searchParams.get('serviceId') ?? undefined
    const scrapeRunId = req.nextUrl.searchParams.get('scrapeRunId') ?? undefined
    const region = req.nextUrl.searchParams.get('region') ?? undefined

    const prices = await db.priceSnapshot.findMany({
      take: limit,
      where: {
        serviceId,
        scrapeRunId,
        region,
      },
      orderBy: { scrapedAt: 'desc' },
      include: {
        service: {
          include: {
            competitor: {
              select: { id: true, name: true, baseUrl: true },
            },
          },
        },
      },
    })

    return NextResponse.json({
      prices: prices.map((snapshot) => ({
        id: snapshot.id,
        serviceId: snapshot.serviceId,
        serviceName: snapshot.service.name,
        competitorId: snapshot.service.competitorId,
        competitorName: snapshot.service.competitor.name,
        price: snapshot.price,
        pricePrevious: snapshot.pricePrevious,
        deltaPct: snapshot.deltaPct,
        currency: snapshot.currency,
        region: snapshot.region,
        locationKey: snapshot.locationKey,
        tariff: snapshot.tariff,
        isMinPrice: snapshot.isMinPrice,
        marketPrice: snapshot.marketPrice,
        scrapedAt: snapshot.scrapedAt,
        scrapeRunId: snapshot.scrapeRunId,
        rawHtmlS3Key: snapshot.rawHtmlS3Key,
        parseStrategy: snapshot.parseStrategy,
        parseConfidence: snapshot.parseConfidence,
      })),
      total: prices.length,
    })
  } catch (error) {
    logger.error({ err: error, module: 'api/prices' }, 'Failed to list prices')
    return NextResponse.json({ error: 'Failed to fetch prices' }, { status: 500 })
  }
}
