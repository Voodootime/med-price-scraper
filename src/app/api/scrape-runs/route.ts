import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { loadConfig } from '@/lib/config'
import { logger } from '@/lib/logger'
import { assertPublicHttpUrl, UnsafeUrlError } from '@/lib/security/url-policy'
import { runScrape } from '@/scraper/run'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

interface ScrapeRunRequestBody {
  competitorId?: string
  url?: string
  name?: string
  region?: string
  maxUrls?: number
  autoProbe?: boolean
}

class BadRequestError extends Error {}

export async function GET(req: NextRequest) {
  try {
    const limit = Math.min(Number(req.nextUrl.searchParams.get('limit') ?? 20), 100)
    const competitorId = req.nextUrl.searchParams.get('competitorId') ?? undefined

    const runs = await db.scrapeRun.findMany({
      take: limit,
      where: competitorId ? { competitorId } : undefined,
      orderBy: { startedAt: 'desc' },
      include: {
        competitor: {
          select: { id: true, name: true, baseUrl: true },
        },
      },
    })

    return NextResponse.json({
      scrapeRuns: runs.map((run) => ({
        id: run.id,
        competitorId: run.competitorId,
        competitorName: run.competitor.name,
        baseUrl: run.competitor.baseUrl,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        durationMs: run.durationMs,
        urlsPlanned: run.urlsPlanned,
        urlsFetched: run.urlsFetched,
        urlsSucceeded: run.urlsSucceeded,
        urlsFailed: run.urlsFailed,
        itemsExtracted: run.itemsExtracted,
        itemsAdded: run.itemsAdded,
        itemsChanged: run.itemsChanged,
        itemsRemoved: run.itemsRemoved,
        region: run.region,
        errorMessage: run.errorMessage,
      })),
      total: runs.length,
      region: loadConfig().TARGET_REGION,
    })
  } catch (error) {
    logger.error({ err: error, module: 'api/scrape-runs' }, 'Failed to list scrape runs')
    return NextResponse.json({ error: 'Failed to fetch scrape runs' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body: ScrapeRunRequestBody = await req.json()
    if (!body.competitorId && !body.url) {
      return NextResponse.json({ error: 'competitorId or url is required' }, { status: 400 })
    }

    const competitorId = body.competitorId ?? (await resolveCompetitorIdFromUrl(body))

    const result = await runScrape({
      competitorId,
      region: body.region,
      maxUrls: body.maxUrls,
      autoProbe: body.autoProbe ?? true,
    })

    return NextResponse.json({ scrapeRun: result }, { status: 201 })
  } catch (error) {
    if (error instanceof BadRequestError) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }

    logger.error({ err: error, module: 'api/scrape-runs' }, 'Scrape run failed')
    return NextResponse.json(
      {
        error: 'Scrape run failed',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    )
  }
}

async function resolveCompetitorIdFromUrl(body: ScrapeRunRequestBody): Promise<string> {
  if (body.competitorId) return body.competitorId
  if (!body.url) throw new BadRequestError('url is required')

  let parsed: URL
  try {
    parsed = await assertPublicHttpUrl(body.url)
  } catch (error) {
    if (error instanceof UnsafeUrlError) {
      throw new BadRequestError(error.message)
    }
    throw error
  }

  const baseUrl = parsed.origin
  const existing = await db.competitor.findFirst({
    where: { OR: [{ baseUrl }, { baseUrl: `${baseUrl}/` }] },
  })
  if (existing) return existing.id

  const competitor = await db.competitor.create({
    data: {
      name: body.name?.trim() || parsed.hostname.replace(/^www\./, ''),
      baseUrl,
      status: 'new',
    },
  })

  return competitor.id
}
