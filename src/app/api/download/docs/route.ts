/**
 * API: /api/download/docs
 *
 * Скачивает только техническую документацию как tar.gz архив.
 * Включает:
 *   - docs/scraping-methodology.md (1600 строк — полная методология)
 *   - worklog.md (журнал разработки)
 *   - README.md (если есть)
 *
 * Лёгкий архив (~50 КБ) для быстрого скачивания.
 */

import { NextRequest, NextResponse } from 'next/server'
import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

const PROJECT_ROOT = process.cwd()

export async function GET(_req: NextRequest) {
  try {
    const archiveName = `med-price-scraper-docs-${new Date().toISOString().slice(0, 10)}.tar.gz`
    const tmpArchive = join(tmpdir(), archiveName)

    // Создаём архив только с документацией
    const cmd = `cd ${PROJECT_ROOT} && tar -czf ${tmpArchive} docs/ worklog.md README.md 2>/dev/null || true`
    execSync(cmd, { encoding: 'utf-8', timeout: 15000 })

    const archiveBuffer = readFileSync(tmpArchive)
    const sizeKB = (archiveBuffer.length / 1024).toFixed(2)

    logger.info({ archiveName, sizeKB }, 'Docs archive created')

    return new NextResponse(archiveBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${archiveName}"`,
        'Content-Length': archiveBuffer.length.toString(),
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    })
  } catch (e) {
    logger.error({ err: e }, 'Failed to create docs archive')
    return NextResponse.json(
      {
        error: 'Failed to create docs archive',
        details: (e as Error).message,
      },
      { status: 500 }
    )
  }
}
