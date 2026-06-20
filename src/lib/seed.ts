/**
 * Seed script — инициализация БД начальными данными.
 *
 * Создаёт:
 * - Регионы (moscow, mo, spb)
 * - AppConfig singleton с TARGET_REGION из .env
 *
 * Запуск: bun run db:seed (через package.json) или напрямую.
 */

import { db } from './db'
import { loadConfig } from './config'
import { logger } from './logger'

async function seed() {
  logger.info('Starting database seed...')

  // === Регионы ===
  const regions = [
    { id: 'moscow', name: 'Москва', isDefault: false },
    { id: 'mo', name: 'Московская область', isDefault: true },
    { id: 'spb', name: 'Санкт-Петербург', isDefault: false },
  ]

  for (const region of regions) {
    await db.region.upsert({
      where: { id: region.id },
      update: { name: region.name, isDefault: region.isDefault },
      create: region,
    })
    logger.info({ region: region.id }, 'Region upserted')
  }

  // === AppConfig (singleton) ===
  const config = loadConfig()
  const existing = await db.appConfig.findUnique({ where: { id: 1 } })

  if (!existing) {
    await db.appConfig.create({
      data: {
        id: 1,
        targetRegion: config.TARGET_REGION,
        defaultRateLimitMs: config.DEFAULT_RATE_LIMIT_MS,
        defaultConcurrency: config.DEFAULT_CONCURRENCY,
        vlmDailyQuota: config.VLM_DAILY_QUOTA,
        llmDailyQuota: config.LLM_DAILY_QUOTA,
        webReaderDailyQuota: config.WEB_READER_DAILY_QUOTA,
      },
    })
    logger.info({ targetRegion: config.TARGET_REGION }, 'AppConfig created')
  } else {
    logger.info({ targetRegion: existing.targetRegion }, 'AppConfig already exists')
  }

  logger.info('Seed completed successfully')
}

seed()
  .catch((e) => {
    logger.error({ err: e }, 'Seed failed')
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await db.$disconnect()
  })
