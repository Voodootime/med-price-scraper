/**
 * Health endpoint — базовая проверка живости приложения.
 *
 * Возвращает:
 * - status: 'ok' | 'degraded' | 'down'
 * - проверки: db, config, env
 * - версия и uptime
 *
 * Используется для:
 * - Kubernetes liveness/readiness probes
 * - Uptime monitoring
 * - Быстрая диагностика
 */

import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { loadConfig } from '@/lib/config'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

interface HealthCheck {
  name: string
  status: 'ok' | 'fail'
  latencyMs?: number
  details?: string
}

async function checkDb(): Promise<HealthCheck> {
  const start = Date.now()
  try {
    // Простой запрос для проверки подключения
    await db.$queryRaw`SELECT 1 as test`
    return {
      name: 'database',
      status: 'ok',
      latencyMs: Date.now() - start,
    }
  } catch (e) {
    return {
      name: 'database',
      status: 'fail',
      latencyMs: Date.now() - start,
      details: (e as Error).message,
    }
  }
}

function checkConfig(): HealthCheck {
  try {
    const config = loadConfig()
    return {
      name: 'config',
      status: 'ok',
      details: `region=${config.TARGET_REGION}, log=${config.LOG_LEVEL}`,
    }
  } catch (e) {
    return {
      name: 'config',
      status: 'fail',
      details: (e as Error).message,
    }
  }
}

export async function GET() {
  const checks = await Promise.all([checkDb(), Promise.resolve(checkConfig())])

  const allOk = checks.every((c) => c.status === 'ok')
  const status = allOk ? 'ok' : 'degraded'

  const response = {
    status,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.npm_package_version || '0.1.0',
    region: loadConfig().TARGET_REGION,
    checks,
  }

  logger.info({ status, checks }, 'Health check')

  return NextResponse.json(response, { status: allOk ? 200 : 503 })
}
