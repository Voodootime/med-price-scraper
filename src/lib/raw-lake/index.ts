import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadConfig } from '@/lib/config'

const REDACTED_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'proxy-authorization',
])

export interface RawFetchSnapshotInput {
  url: string
  finalUrl: string
  status: number
  headers: Record<string, string>
  body: string
  contentHash: string
  fetchedAt: Date
  durationMs: number
  fetcher: string
  tier: string
  retries: number
  region: string
}

export interface RawFetchSnapshot {
  key: string
  htmlPath: string
  metadataPath: string
}

export async function saveRawFetchSnapshot(
  input: RawFetchSnapshotInput
): Promise<RawFetchSnapshot> {
  const root = loadConfig().RAW_LAKE_PATH
  const fetchedAt = input.fetchedAt
  const date = fetchedAt.toISOString().slice(0, 10)
  const host = safePathSegment(new URL(input.finalUrl).hostname || 'unknown-host')
  const hashPrefix = input.contentHash.slice(0, 16)
  const itemDir = join(root, date, host, hashPrefix)

  await mkdir(itemDir, { recursive: true })

  const htmlPath = join(itemDir, 'body.html')
  const metadataPath = join(itemDir, 'metadata.json')

  await writeFile(htmlPath, input.body, 'utf-8')
  await writeFile(
    metadataPath,
    JSON.stringify(
      {
        url: input.url,
        finalUrl: input.finalUrl,
        status: input.status,
        headers: redactHeaders(input.headers),
        contentHash: input.contentHash,
        fetchedAt: fetchedAt.toISOString(),
        durationMs: input.durationMs,
        fetcher: input.fetcher,
        tier: input.tier,
        retries: input.retries,
        region: input.region,
      },
      null,
      2
    ),
    'utf-8'
  )

  return {
    key: `${date}/${host}/${hashPrefix}`,
    htmlPath,
    metadataPath,
  }
}

function safePathSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'unknown'
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {}

  for (const [key, value] of Object.entries(headers)) {
    redacted[key] = REDACTED_HEADER_NAMES.has(key.toLowerCase()) ? '[redacted]' : value
  }

  return redacted
}
