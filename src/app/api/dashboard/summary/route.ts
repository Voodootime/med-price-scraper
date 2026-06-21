import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { logger } from '@/lib/logger'
import { loadConfig } from '@/lib/config'

export const dynamic = 'force-dynamic'

type PipelineStatus = 'ok' | 'running' | 'warning' | 'failed' | 'idle'

function startOfToday(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

function countBy<T extends string>(
  rows: Array<{ status: T; _count: { _all: number } }>
): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.status, row._count._all]))
}

function phaseStatus(input: {
  total: number
  running?: number
  failed?: number
  warning?: number
}): PipelineStatus {
  if (input.running && input.running > 0) return 'running'
  if (input.failed && input.failed > 0) return 'failed'
  if (input.warning && input.warning > 0) return 'warning'
  if (input.total > 0) return 'ok'
  return 'idle'
}

export async function GET() {
  try {
    const targetRegion = loadConfig().TARGET_REGION
    const today = startOfToday()

    const [
      competitorsTotal,
      competitorsByStatusRows,
      servicesTotal,
      scrapesToday,
      scrapeRunsByStatusRows,
      activeAlerts,
      latestRuns,
      latestProbes,
      recentAlerts,
      specsByStatusRows,
    ] = await Promise.all([
      db.competitor.count(),
      db.competitor.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      db.service.count(),
      db.scrapeRun.count({
        where: {
          startedAt: { gte: today },
        },
      }),
      db.scrapeRun.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      db.scrapeAlert.count({
        where: {
          acknowledged: false,
        },
      }),
      db.scrapeRun.findMany({
        take: 12,
        orderBy: { startedAt: 'desc' },
        include: {
          competitor: {
            select: {
              id: true,
              name: true,
              baseUrl: true,
            },
          },
        },
      }),
      db.probeResult.findMany({
        take: 8,
        orderBy: { probedAt: 'desc' },
        include: {
          competitor: {
            select: {
              id: true,
              name: true,
              baseUrl: true,
              status: true,
            },
          },
        },
      }),
      db.scrapeAlert.findMany({
        take: 8,
        orderBy: { createdAt: 'desc' },
        include: {
          competitor: {
            select: {
              id: true,
              name: true,
            },
          },
          scrapeRun: {
            select: {
              id: true,
              status: true,
            },
          },
        },
      }),
      db.scrapeSpec.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
    ])

    const competitorsByStatus = countBy(competitorsByStatusRows)
    const scrapeRunsByStatus = countBy(scrapeRunsByStatusRows)
    const specsByStatus = countBy(specsByStatusRows)

    const probing = competitorsByStatus.probing ?? 0
    const blocked = competitorsByStatus.blocked ?? 0
    const needsReviewCompetitors = competitorsByStatus.needs_review ?? 0
    const runningScrapes = scrapeRunsByStatus.running ?? 0
    const failedScrapes = scrapeRunsByStatus.failed ?? 0
    const partialScrapes = scrapeRunsByStatus.partial ?? 0
    const needsReviewSpecs = specsByStatus.needs_review ?? 0
    const rejectedSpecs = specsByStatus.rejected ?? 0
    const latestProbe = latestProbes[0]
    const latestRun = latestRuns[0]
    const latestDiscoveryUrls = latestProbe?.priceUrlsCount ?? 0

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      region: targetRegion,
      stats: {
        competitors: competitorsTotal,
        services: servicesTotal,
        scrapesToday,
        activeAlerts,
      },
      pipeline: [
        {
          id: 'competitors',
          label: 'Competitors',
          status: phaseStatus({
            total: competitorsTotal,
            running: probing,
            failed: blocked,
            warning: needsReviewCompetitors,
          }),
          value: competitorsTotal,
          description:
            competitorsTotal > 0
              ? `${probing} probing, ${needsReviewCompetitors} needs review`
              : 'No competitors configured',
          updatedAt: latestProbe?.probedAt ?? null,
        },
        {
          id: 'probe',
          label: 'Probe',
          status: phaseStatus({
            total: latestProbes.length,
            running: probing,
            warning: needsReviewCompetitors,
            failed: blocked,
          }),
          value: latestProbes.length,
          description:
            latestProbes.length > 0
              ? `${latestProbe?.confidenceScore ?? 0}% latest confidence`
              : 'No probe results yet',
          updatedAt: latestProbe?.probedAt ?? null,
        },
        {
          id: 'discovery',
          label: 'Discovery',
          status:
            latestProbes.length === 0
              ? 'idle'
              : latestDiscoveryUrls > 0
                ? 'ok'
                : 'warning',
          value: latestDiscoveryUrls,
          description:
            latestProbes.length > 0
              ? `${latestProbe?.sitemapUrlsCount ?? 0} sitemaps, ${latestDiscoveryUrls} price URLs`
              : 'Waiting for probe output',
          updatedAt: latestProbe?.probedAt ?? null,
        },
        {
          id: 'scrape',
          label: 'Scrape runs',
          status: phaseStatus({
            total: latestRuns.length,
            running: runningScrapes,
            failed: failedScrapes,
            warning: partialScrapes + activeAlerts,
          }),
          value: latestRuns.length,
          description:
            latestRuns.length > 0
              ? `${runningScrapes} running, ${activeAlerts} active alerts`
              : `${needsReviewSpecs + rejectedSpecs} specs need operator attention`,
          updatedAt: latestRun?.startedAt ?? null,
        },
      ],
      latestRuns: latestRuns.map((run) => ({
        id: run.id,
        competitorId: run.competitorId,
        competitorName: run.competitor.name,
        baseUrl: run.competitor.baseUrl,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        durationMs: run.durationMs,
        status: run.status,
        urlsPlanned: run.urlsPlanned,
        urlsFetched: run.urlsFetched,
        urlsSucceeded: run.urlsSucceeded,
        urlsFailed: run.urlsFailed,
        itemsExtracted: run.itemsExtracted,
        itemsChanged: run.itemsChanged,
        itemsAdded: run.itemsAdded,
        itemsRemoved: run.itemsRemoved,
        errorMessage: run.errorMessage,
        region: run.region,
      })),
      latestProbes: latestProbes.map((probe) => ({
        id: probe.id,
        competitorId: probe.competitorId,
        competitorName: probe.competitor.name,
        baseUrl: probe.competitor.baseUrl,
        competitorStatus: probe.competitor.status,
        probedAt: probe.probedAt,
        tier: probe.tier,
        framework: probe.framework,
        regionStrategy: probe.regionStrategy,
        confidenceScore: probe.confidenceScore,
        sitemapUrlsCount: probe.sitemapUrlsCount,
        priceUrlsCount: probe.priceUrlsCount,
      })),
      recentAlerts: recentAlerts.map((alert) => ({
        id: alert.id,
        competitorId: alert.competitorId,
        competitorName: alert.competitor.name,
        scrapeRunId: alert.scrapeRunId,
        scrapeRunStatus: alert.scrapeRun?.status ?? null,
        createdAt: alert.createdAt,
        severity: alert.severity,
        type: alert.type,
        message: alert.message,
        acknowledged: alert.acknowledged,
      })),
    })
  } catch (e) {
    logger.error({ err: e, module: 'api/dashboard/summary' }, 'Failed to build dashboard summary')
    return NextResponse.json(
      { error: 'Failed to fetch dashboard summary', details: (e as Error).message },
      { status: 500 }
    )
  }
}
