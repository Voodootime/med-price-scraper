/**
 * API: /api/download/project
 *
 * Скачивает полный исходный код проекта как tar.gz архив.
 * Исключает: node_modules, .next, .git, data/ (raw-lake, screenshots)
 * Включает: src/, docs/, prisma/, package.json, tsconfig.json, и т.д.
 *
 * Использование: открыть в браузере /api/download/project
 * или curl https://[preview-url]/api/download/project -o project.tar.gz
 */

import { NextRequest, NextResponse } from 'next/server'
import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

const PROJECT_ROOT = process.cwd()

// Что включаем в архив (явный список для безопасности)
const INCLUDE_PATHS = [
  'src/',
  'docs/',
  'prisma/',
  'public/',
  'examples/',
  'download/',
  'mini-services/',
  'package.json',
  'bun.lock',
  'tsconfig.json',
  'next.config.ts',
  'tailwind.config.ts',
  'postcss.config.mjs',
  'eslint.config.mjs',
  'components.json',
  'Caddyfile',
  '.env.example',
  '.gitignore',
  'README.md',
  'worklog.md',
]

// Что точно исключаем (даже если попадается внутри include)
const EXCLUDE_PATTERNS = [
  'node_modules',
  '.next',
  '.git',
  '*.log',
  'data/raw-lake',
  'data/screenshots',
  'db/*.db',
  'db/*.db-journal',
]

export async function GET(_req: NextRequest) {
  try {
    const archiveName = `med-price-scraper-${new Date().toISOString().slice(0, 10)}.tar.gz`
    const tmpArchive = join(tmpdir(), archiveName)

    // Формируем tar exclude аргументы
    const excludeArgs = EXCLUDE_PATTERNS.map((p) => `--exclude='${p}'`).join(' ')

    // Создаём tar.gz архив
    // Используем --transform для удаления путей (архив будет с относительными путями)
    const cmd = `cd ${PROJECT_ROOT} && tar -czf ${tmpArchive} ${excludeArgs} ${INCLUDE_PATHS.join(' ')} 2>&1`

    logger.info({ archiveName }, 'Creating project archive')
    execSync(cmd, { encoding: 'utf-8', timeout: 30000 })

    const archiveBuffer = readFileSync(tmpArchive)
    const sizeMB = (archiveBuffer.length / 1024 / 1024).toFixed(2)

    logger.info({ archiveName, sizeMB }, 'Archive created')

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
    logger.error({ err: e }, 'Failed to create project archive')
    return NextResponse.json(
      {
        error: 'Failed to create archive',
        details: (e as Error).message,
      },
      { status: 500 }
    )
  }
}
