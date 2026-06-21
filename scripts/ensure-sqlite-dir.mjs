import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const schemaDir = resolve(process.cwd(), 'prisma')
const databaseUrl = process.env.DATABASE_URL ?? readDatabaseUrlFromEnv()

if (!databaseUrl?.startsWith('file:')) {
  process.exit(0)
}

const rawPath = databaseUrl.slice('file:'.length)
if (!rawPath || rawPath === ':memory:') {
  process.exit(0)
}

const dbPath = resolve(schemaDir, rawPath)
mkdirSync(dirname(dbPath), { recursive: true })

function readDatabaseUrlFromEnv() {
  try {
    const env = readFileSync(resolve(process.cwd(), '.env'), 'utf8')
    const line = env
      .split(/\r?\n/)
      .find((entry) => entry.trim().startsWith('DATABASE_URL='))
    if (!line) return undefined
    return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')
  } catch {
    return undefined
  }
}
