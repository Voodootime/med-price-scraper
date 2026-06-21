import type { RegionStrategy, UrlCategory } from '@/scraper/types'
import { isKnownCitySlug } from '@/scraper/utils/city-slugs'

const SERVICE_HINTS = [
  'analiz',
  'analysis',
  'analizy',
  'analyzes',
  'diagnost',
  'diagnostics',
  'issledovan',
  'lab',
  'laborator',
  'price',
  'prices',
  'prajs',
  'preiskurant',
  'service',
  'services',
  'test',
  'tests',
  'usluga',
  'uslugi',
]

const CATALOG_HINTS = [
  'catalog',
  'category',
  'categories',
  'katalog',
  'napravlen',
  'program',
  'programs',
]

const CLINIC_HINTS = ['address', 'addresses', 'clinic', 'clinics', 'filial', 'filials', 'office', 'offices']
const DOCTOR_HINTS = ['doctor', 'doctors', 'specialist', 'specialists', 'vrach', 'vrachi']
const ARTICLE_HINTS = [
  'about',
  'akcii',
  'article',
  'articles',
  'blog',
  'diskont',
  'discount',
  'faq',
  'news',
  'novosti',
  'patient',
  'patients',
  'patsient',
  'promo',
  'stock',
]

const BLOCKED_PRICE_PATH_HINTS = [
  '404',
  'akcii',
  'calendar',
  'calendar-kk',
  'diskont',
  'discount',
  'htmlrender',
  'htmlrender-php',
  'news',
  'novosti',
  'patsient',
  'postvaktsinal',
  'promo',
  'urgent-analyzes',
]

const BROAD_PRICE_PATHS = [
  '/analizy-i-tseny',
  '/analizy-i-tseny/urgent-analyzes',
  '/meditsinskie-uslugi',
  '/napravleniya-deyatelnosti',
]

function normalizeToken(value: string): string {
  return decodeURIComponent(value)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/g, '-')
}

export function normalizeDiscoveryUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, '')
    parsed.searchParams.sort()
    return parsed.toString()
  } catch {
    return null
  }
}

export function categorizeUrl(url: string): UrlCategory {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'other'
  }

  const haystack = normalizeToken(`${parsed.pathname} ${parsed.search}`)

  if (DOCTOR_HINTS.some((hint) => haystack.includes(hint))) return 'doctor'
  if (ARTICLE_HINTS.some((hint) => haystack.includes(hint))) return 'article'
  if (CLINIC_HINTS.some((hint) => haystack.includes(hint))) return 'clinic'
  if (CATALOG_HINTS.some((hint) => haystack.includes(hint))) return 'catalog'
  if (SERVICE_HINTS.some((hint) => haystack.includes(hint))) return 'service'

  return 'other'
}

export function hasCitySegment(url: string, regionStrategy: RegionStrategy): boolean {
  if (regionStrategy.type === 'none') return false

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  const mappedValues = Object.values(regionStrategy.mapping).filter(Boolean).map(normalizeToken)
  if (mappedValues.length === 0) return false

  if (regionStrategy.type === 'url_subdomain') {
    const host = normalizeToken(parsed.hostname)
    return mappedValues.some((value) => host.startsWith(`${value}-`) || host.startsWith(`${value}.`))
  }

  if (regionStrategy.type === 'url_query') {
    const param = regionStrategy.param
    if (!param) return false
    const value = parsed.searchParams.get(param)
    return value ? mappedValues.includes(normalizeToken(value)) : false
  }

  const pathSegments = parsed.pathname.split('/').filter(Boolean).map(normalizeToken)
  return pathSegments.some((segment) => mappedValues.includes(segment))
}

export function matchesTargetRegion(url: string, region: string, regionStrategy: RegionStrategy): boolean {
  if (regionStrategy.type === 'none') return true
  if (regionStrategy.type === 'cookie' || regionStrategy.type === 'ip_default') return true
  if (regionStrategy.type === 'tariff_select') return true

  const targetValue = regionStrategy.mapping[region]
  if (!targetValue) return true

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  const normalizedTarget = normalizeToken(targetValue)

  if (regionStrategy.type === 'url_subdomain') {
    const host = normalizeToken(parsed.hostname)
    return host.startsWith(`${normalizedTarget}-`) || host.startsWith(`${normalizedTarget}.`)
  }

  if (regionStrategy.type === 'url_query') {
    const param = regionStrategy.param
    if (!param) return true
    const value = parsed.searchParams.get(param)
    return value ? normalizeToken(value) === normalizedTarget : true
  }

  // url_path_segment or url_prefix: check path segments
  const pathSegments = parsed.pathname.split('/').filter(Boolean).map(normalizeToken)

  // If URL contains the target city slug → pass
  if (pathSegments.includes(normalizedTarget)) return true

  // If URL contains ANY known city slug that is NOT the target → reject
  // This prevents podolsk/balashikha URLs when target is msk
  const hasOtherCity = pathSegments.some(
    (segment) => isKnownCitySlug(segment) && segment !== normalizedTarget
  )
  if (hasOtherCity) return false

  // No city segment at all → pass (might be a generic page)
  return true
}

// Debug version for testing
export function matchesTargetRegionDebug(url: string, region: string, regionStrategy: RegionStrategy): boolean {
  const result = matchesTargetRegion(url, region, regionStrategy)
  if (!result) {
    console.log(`[matchesTargetRegion] REJECTED: ${url} (region=${region}, target=${regionStrategy.mapping?.[region]})`)
  }
  return result
}

export function isLikelyPriceUrl(url: string, category = categorizeUrl(url)): boolean {
  const parsed = new URL(url)
  const haystack = normalizeToken(`${parsed.pathname} ${parsed.search}`)
  if (hasBlockedPricePathHint(haystack)) return false
  if (category === 'doctor' || category === 'article' || category === 'clinic') return false
  if (hasConcretePricePageMarker(parsed, haystack)) return true
  if (category === 'catalog' || category === 'service') return true

  return SERVICE_HINTS.some((hint) => haystack.includes(hint))
}

export function scoreLikelyPriceUrl(url: string, category = categorizeUrl(url)): number {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return Number.NEGATIVE_INFINITY
  }

  const pathname = parsed.pathname.toLowerCase()
  const normalizedPath = pathname.replace(/\/+$/, '')
  const haystack = normalizeToken(`${parsed.pathname} ${parsed.search}`)
  const segments = parsed.pathname.split('/').filter(Boolean)
  let score = 0

  if (hasBlockedPricePathHint(haystack)) score -= 300
  if (hasConcretePricePageMarker(parsed, haystack)) score += 90
  if (category === 'service') score += 30
  if (category === 'catalog') score += 20
  if (/analizy-i-tseny|katalog-analizov|catalog|katalog/.test(haystack)) score += 35
  if (/meditsinskie-uslugi|uslugi|service|services/.test(haystack)) score += 15
  if (/(?:_|-|\/)\d{3,}(?:\/|$)/.test(pathname)) score += 30
  if (segments.length >= 3) score += 20
  if (segments.length >= 4) score += 10

  if (segments.length <= 1) score -= 40
  if (BROAD_PRICE_PATHS.includes(normalizedPath)) score -= 80
  if (category === 'clinic' || category === 'doctor' || category === 'article') score -= 100

  return score
}

function hasConcretePricePageMarker(parsed: URL, haystack: string): boolean {
  const pathname = parsed.pathname.toLowerCase()
  const hasNumericCode = /(?:_|-|\/)\d{3,}(?:\/|$)/.test(pathname)
  const isCmdAnalysisCard = haystack.includes('analizy-i-tseny') && haystack.includes('katalog-analizov')
  const isCatalogCard = /catalog|katalog/.test(haystack) && hasNumericCode
  const isServiceCard = /service|services|usluga|uslugi|analiz|diagnost/.test(haystack) && hasNumericCode

  return (isCmdAnalysisCard && hasNumericCode) || isCatalogCard || isServiceCard
}

function hasBlockedPricePathHint(haystack: string): boolean {
  return BLOCKED_PRICE_PATH_HINTS.some((hint) => haystack.includes(hint))
}

function hasAnyKnownRegionSegment(pathSegments: string[], regionStrategy: RegionStrategy): boolean {
  const mappedValues = Object.values(regionStrategy.mapping).filter(Boolean).map(normalizeToken)
  return pathSegments.some((segment) => mappedValues.includes(segment))
}
