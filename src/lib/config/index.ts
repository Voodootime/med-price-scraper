/**
 * Конфигурация приложения с валидацией через Zod.
 *
 * Все настройки загружаются из переменных окружения и валидируются.
 * При ошибке конфигурации приложение не стартует (fail-fast).
 *
 * Документация: docs/scraping-methodology.md раздел 0.3 (scope), 16 (cost)
 */

import { z } from 'zod'

const envSchema = z.object({
  // === Core ===
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  PORT: z.coerce.number().default(3000),

  // === Scope (раздел 0.3) ===
  TARGET_REGION: z
    .string()
    .default('mo')
    .refine((v) => ['moscow', 'mo', 'spb'].includes(v), {
      message: 'TARGET_REGION must be one of: moscow, mo, spb',
    }),

  // === Logging ===
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  // === Rate limits (politeness, раздел 12) ===
  DEFAULT_RATE_LIMIT_MS: z.coerce.number().default(2000),
  DEFAULT_CONCURRENCY: z.coerce.number().default(5),
  MAX_RETRIES: z.coerce.number().default(3),

  // === AI Skills quotas (раздел 8) ===
  VLM_DAILY_QUOTA: z.coerce.number().default(100),
  LLM_DAILY_QUOTA: z.coerce.number().default(1000),
  WEB_READER_DAILY_QUOTA: z.coerce.number().default(500),
  WEB_SEARCH_DAILY_QUOTA: z.coerce.number().default(50),

  // === z-ai SDK ===
  ZAI_API_KEY: z.string().optional(),

  // === API protection ===
  ADMIN_API_KEY: z.string().optional(),

  // === Storage ===
  RAW_LAKE_PATH: z.string().default('./data/raw-lake'),
  SCREENSHOTS_PATH: z.string().default('./data/screenshots'),

  // === Proxy (для Helix-Москва, раздел 14.7) ===
  PROXY_URL: z.string().optional(),
  PROXY_USER: z.string().optional(),
  PROXY_PASS: z.string().optional(),

  // === Telegram alerts ===
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
})

export type EnvConfig = z.infer<typeof envSchema>

let cachedConfig: EnvConfig | null = null

/**
 * Загрузить и провалидировать конфигурацию.
 * Кеширует результат (singleton).
 */
export function loadConfig(): EnvConfig {
  if (cachedConfig) return cachedConfig

  const parsed = envSchema.safeParse(process.env)

  if (!parsed.success) {
    console.error('❌ Invalid environment configuration:')
    console.error(parsed.error.flatten().fieldErrors)
    throw new Error(`Configuration validation failed: ${parsed.error.message}`)
  }

  cachedConfig = parsed.data
  return cachedConfig
}

/**
 * Получить конкретное значение конфигурации.
 */
export function getConfig<K extends keyof EnvConfig>(key: K): EnvConfig[K] {
  return loadConfig()[key]
}

/**
 * Проверить, что все required-переменные установлены.
 * Использовать при старте приложения.
 */
export function validateConfig(): { ok: boolean; missing: string[] } {
  try {
    loadConfig()
    return { ok: true, missing: [] }
  } catch (e) {
    return { ok: false, missing: [(e as Error).message] }
  }
}
