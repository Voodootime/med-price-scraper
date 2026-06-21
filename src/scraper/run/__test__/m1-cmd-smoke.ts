/**
 * M1 Live Smoke Test — прямой запуск scrape для CMD без dev server.
 *
 * Запуск: bun run src/scraper/run/__test__/m1-cmd-smoke.ts
 *
 * Этот скрипт:
 * 1. Очищает БД
 * 2. Создаёт competitor для CMD
 * 3. Запускает scrape-run (maxUrls=5)
 * 4. Выводит результат
 * 5. Сохраняет первый успешный HTML как fixture
 */

import { db } from '@/lib/db'
import { runScrape } from '@/scraper/run/scrape-runner'
import { getStaticFetcher } from '@/scraper/strategies/static-fetcher'
import { logger } from '@/lib/logger'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

const log = logger.child({ module: 'm1-smoke' })

async function main() {
  log.info('=== M1 CMD Live Smoke Test ===')

  // 1. Clean DB
  log.info('Step 1: Cleaning DB...')
  await db.priceSnapshot.deleteMany({})
  await db.service.deleteMany({})
  await db.scrapeAlert.deleteMany({})
  await db.scrapeRun.deleteMany({})
  await db.scrapeSpec.deleteMany({})
  await db.probeResult.deleteMany({})
  await db.competitor.deleteMany({})
  log.info('DB cleaned')

  // 2. Create competitor
  log.info('Step 2: Creating CMD competitor...')
  const competitor = await db.competitor.create({
    data: {
      name: 'CMD Online',
      baseUrl: 'https://www.cmd-online.ru',
      status: 'new',
    },
  })
  log.info({ competitorId: competitor.id }, 'Competitor created')

  // 3. Run scrape
  log.info('Step 3: Running scrape (maxUrls=2, autoProbe=true)...')
  const result = await runScrape({
    competitorId: competitor.id,
    maxUrls: 2,
    autoProbe: true,
  })

  log.info({ result }, 'Scrape completed')
  console.log('\n=== SCRAPE RESULT ===')
  console.log(JSON.stringify(result, null, 2))

  // 4. Check DB state
  log.info('Step 4: Checking DB state...')
  const services = await db.service.findMany({ take: 5 })
  const snapshots = await db.priceSnapshot.findMany({ take: 5, include: { service: true } })
  const runs = await db.scrapeRun.findMany({ take: 1 })

  console.log('\n=== DB STATE ===')
  console.log(`Services: ${services.length}`)
  console.log(`PriceSnapshots: ${snapshots.length}`)
  console.log(`ScrapeRuns: ${runs.length}`)

  if (services.length > 0) {
    console.log('\n=== FIRST SERVICE ===')
    console.log(JSON.stringify(services[0], null, 2))
  }

  if (snapshots.length > 0) {
    console.log('\n=== FIRST PRICE SNAPSHOT ===')
    console.log(JSON.stringify(snapshots[0], null, 2))
  }

  // 5. If no items, fetch a known CMD card directly and test parser
  if (services.length === 0) {
    log.info('Step 5: No items found. Testing direct fetch of known CMD card...')
    const testUrl =
      'https://www.cmd-online.ru/analizy-i-tseny/katalog-analizov/msk/gluten/'
    const fetcher = getStaticFetcher()
    const fetched = await fetcher.fetch({
      url: testUrl,
      region: 'mo',
      tier: 'T1',
      timeoutMs: 30000,
      retries: 1,
      rateLimitMs: 1000,
    })
    log.info(
      { status: fetched.status, size: fetched.body.length, url: fetched.url },
      'Direct fetch result'
    )

    // Save HTML as fixture
    const fixtureDir = join(process.cwd(), 'src/scraper/parsers/__test__/fixtures')
    mkdirSync(fixtureDir, { recursive: true })
    const fixturePath = join(fixtureDir, 'cmd-gluten.html')
    writeFileSync(fixturePath, fetched.body)
    log.info({ fixturePath, size: fetched.body.length }, 'Fixture saved')

    console.log('\n=== DIRECT FETCH ===')
    console.log(`URL: ${fetched.url}`)
    console.log(`Status: ${fetched.status}`)
    console.log(`Size: ${fetched.body.length} bytes`)
    console.log(`Fixture: ${fixturePath}`)

    // Check if HTML has Schema.org
    const hasSchemaOrg = /itemprop=["']price["']/i.test(fetched.body)
    const hasH1 = /<h1[^>]*>/i.test(fetched.body)
    console.log(`Has Schema.org price: ${hasSchemaOrg}`)
    console.log(`Has H1: ${hasH1}`)

    // Show first 500 chars around itemprop="price"
    const idx = fetched.body.indexOf('itemprop="price"')
    if (idx > 0) {
      console.log('\n=== Schema.org price context ===')
      console.log(fetched.body.slice(Math.max(0, idx - 200), idx + 300))
    }
  }

  await db.$disconnect()
  process.exit(0)
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
