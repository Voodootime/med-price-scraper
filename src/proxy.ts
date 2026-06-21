import { NextRequest, NextResponse } from 'next/server'

const PROTECTED_PATHS = [
  '/api/competitors',
  '/api/probe',
  '/api/scrape-runs',
  '/api/download',
]

export function proxy(req: NextRequest) {
  if (!isProtectedRequest(req)) {
    return NextResponse.next()
  }

  const configuredKey = process.env.ADMIN_API_KEY
  if (!configuredKey) {
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json(
        { error: 'ADMIN_API_KEY is required in production' },
        { status: 503 }
      )
    }
    return NextResponse.next()
  }

  const providedKey = extractApiKey(req)
  if (providedKey !== configuredKey) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/api/:path*'],
}

function isProtectedRequest(req: NextRequest): boolean {
  const { pathname } = req.nextUrl

  if (pathname.startsWith('/api/download')) return true
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return false

  return PROTECTED_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))
}

function extractApiKey(req: NextRequest): string | null {
  const apiKey = req.headers.get('x-api-key')
  if (apiKey) return apiKey

  const authorization = req.headers.get('authorization')
  if (!authorization) return null

  const [scheme, token] = authorization.split(/\s+/, 2)
  if (scheme?.toLowerCase() !== 'bearer') return null

  return token ?? null
}
