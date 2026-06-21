/**
 * M1 Quick Smoke — быстрый тест без probe (preset tier).
 */
import { db } from '@/lib/db'
import { runScrape } from '@/scraper/run/scrape-runner'
import { logger } from '@/lib/logger'

const log = logger.child({ module: 'm1-quick' })

async function main() {
  log.info('=== M1 Quick Smoke (no probe) ===')

  // Clean
  await db.priceSnapshot.deleteMany({})
  await db.service.deleteMany({})
  await db.scrapeAlert.deleteMany({})
  await db.scrapeRun.deleteMany({})
  await db.scrapeSpec.deleteMany({})
  await db.probeResult.deleteMany({})
  await db.competitor.deleteMany({})

  // Create with preset + probe result (for proper region mapping)
  const competitor = await db.competitor.create({
    data: {
      name: 'CMD Online',
      baseUrl: 'https://www.cmd-online.ru',
      status: 'active',
      tier: 'T1_schema_org',
      regionStrategy: 'url_path_segment',
      confidenceScore: 85,
    },
  })

  // Create probe result with proper region mapping (so discovery filters correctly)
  const probeReport = {
    baseUrl: 'https://www.cmd-online.ru',
    regionStrategy: {
      type: 'url_path_segment' as const,
      param: 'city_slug',
      mapping: { moscow: 'msk', mo: 'msk' },
      note: 'CMD: 77 cities in path segments, prices same across cities',
    },
    tier: 'T1_schema_org',
    confidenceScore: 85,
    sitemapUrls: ['https://www.cmd-online.ru/sitemap.xml'],
    robotsTxt: { sitemaps: ['https://www.cmd-online.ru/sitemap.xml'], disallow: [] },
  }
  await db.probeResult.create({
    data: {
      competitorId: competitor.id,
      probedAt: new Date(),
      framework: 'bitrix',
      isSSR: true,
      hasEmbeddedState: false,
      hasSchemaOrg: true,
      currencyFormat: '₽',
      tier: 'T1_schema_org',
      regionStrategy: 'url_path_segment',
      sitemapUrlsCount: 3,
      priceUrlsCount: 30000,
      confidenceScore: 85,
      probeReportJson: JSON.stringify(probeReport),
    },
  })
  log.info({ id: competitor.id }, 'Competitor created with preset + probe mapping')

  const result = await runScrape({
    competitorId: competitor.id,
    maxUrls: 3,
    autoProbe: false,  // skip probe
  })

  console.log('\n=== RESULT ===')
  console.log(JSON.stringify(result, null, 2))

  const services = await db.service.findMany()
  const snapshots = await db.priceSnapshot.findMany({ include: { service: true } })

  console.log(`\nServices: ${services.length}`)
  console.log(`Snapshots: ${snapshots.length}`)
  if (services[0]) console.log('\nFirst service:', JSON.stringify(services[0], null, 2))
  if (snapshots[0]) console.log('\nFirst snapshot:', JSON.stringify(snapshots[0], null, 2))

  await db.$disconnect()
  process.exit(0)
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
