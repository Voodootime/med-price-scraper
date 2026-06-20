/**
 * Структурированный логгер на pino.
 *
 * Особенности:
 * - JSON-вывод в production, pretty-print в dev
 * - traceId для сквозной трассировки (OpenTelemetry-ready)
 * - Контекстные child-логгеры для каждой подсистемы
 * - Низкая аллокация (pino быстрый)
 *
 * Документация: docs/scraping-methodology.md раздел 15
 */

import pino from 'pino'

const isDev = process.env.NODE_ENV !== 'production'
const logLevel = process.env.LOG_LEVEL || (isDev ? 'debug' : 'info')

const baseLogger = pino({
  level: logLevel,
  base: {
    service: 'med-price-scraper',
    env: process.env.NODE_ENV || 'development',
  },
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname,service,env',
            singleLine: false,
          },
        },
      }
    : {
        // В prod — чистый JSON для Loki/Datadog
        formatters: {
          level: (label) => ({ level: label }),
        },
      }),
})

export type Logger = typeof baseLogger

/**
 * Создать child-логгер с контекстом (competitorId, scrapeRunId, etc.)
 */
export function createLogger(context: Record<string, string | undefined>): Logger {
  return baseLogger.child(context)
}

/**
 * Генерация traceId для сквозной трассировки запроса.
 */
export function generateTraceId(): string {
  return `trace_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Главный логгер приложения.
 */
export const logger = baseLogger

export default baseLogger
