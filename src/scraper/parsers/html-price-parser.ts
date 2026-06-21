import * as cheerio from 'cheerio'
import type { AnyNode } from 'domhandler'
import type { Parser, ParseContext, ParseResult } from '@/scraper/interfaces'
import type { ExternalIdType, PriceStrategyName, UniversalPriceItem } from '@/scraper/types'
import { normalizeCategory, normalizeName, parsePrice } from '@/scraper/utils/price'

type JsonRecord = Record<string, unknown>

interface RawPriceCandidate {
  strategy: PriceStrategyName
  confidence: number
  nameRaw: string
  priceRaw: string
  code?: string
  slug?: string
  category?: string
  description?: string
  available?: boolean
  sourceKey?: string
}

const STRATEGY_ORDER: PriceStrategyName[] = [
  'schema_org',
  'data_attributes',
  'embedded_json',
  'css_class',
]

const PRICE_ATTRIBUTE_RE = /^data-(?:eec-)?(?:product-)?(?:price|cost|value|amount)$/i
const NAME_ATTRIBUTE_RE = /^data-(?:eec-)?(?:product-)?(?:name|title|service|service-name)$/i
const CODE_ATTRIBUTE_RE = /^data-(?:eec-)?(?:id|code|sku|article|product-id|service-id)$/i
const PRICE_CLASS_RE = /(?:^|[-_\s])(price|cost|amount|value)(?:[-_\s]|$)/i
const NAME_CLASS_RE = /(?:^|[-_\s])(name|title|service|product)(?:[-_\s]|$)/i
const MIN_PRICE_RE = /^\s*(?:ot|from|\u043e\u0442)\s+/i

const JSON_NAME_KEYS = ['name', 'title', 'serviceName', 'service_name', 'productName', 'product_name']
const JSON_PRICE_KEYS = ['price', 'cost', 'amount', 'value', 'minPrice', 'min_price']
const JSON_CODE_KEYS = ['code', 'id', 'sku', 'article', 'externalId', 'external_id']
const JSON_CATEGORY_KEYS = ['category', 'section', 'group']
const JSON_DESCRIPTION_KEYS = ['description', 'text', 'summary']

/**
 * Universal static HTML parser for first-pass T1/T2 coverage.
 *
 * It avoids site-specific selectors and tries stable public signals first:
 * Schema.org microdata/JSON-LD, data attributes, embedded JSON state, then CSS/table price blocks.
 */
export class HtmlPriceParser implements Parser {
  readonly name: PriceStrategyName = 'schema_org'
  readonly priority = 1

  canParse(html: string): boolean {
    if (!html.trim()) return false

    return (
      /itemprop=["']price["']/i.test(html) ||
      /data-(?:eec-)?(?:product-)?(?:price|cost|value|amount)=/i.test(html) ||
      /<script[^>]+(?:application\/ld\+json|__NEXT_DATA__)/i.test(html) ||
      /class=["'][^"']*(?:price|cost|amount|value)/i.test(html)
    )
  }

  async parse(html: string, url: string, context: ParseContext): Promise<ParseResult> {
    const $ = cheerio.load(html)
    const warnings: string[] = []
    const errors: string[] = []

    const candidates = dedupeCandidates([
      ...extractSchemaOrgCandidates($, url),
      ...extractDataAttributeCandidates($),
      ...extractEmbeddedJsonCandidates($),
      ...extractCssCandidates($, url),
    ])

    const items: UniversalPriceItem[] = []
    for (const candidate of candidates) {
      const item = buildItem(candidate, url, context)
      if (item) {
        items.push(item)
      } else {
        warnings.push(`Skipped candidate without valid name or price: ${candidate.sourceKey ?? candidate.strategy}`)
      }
    }

    if (items.length === 0) {
      errors.push('No price items extracted from HTML')
    }

    return {
      items,
      strategy: pickResultStrategy(items),
      confidence: items.length > 0 ? Math.max(...items.map((item) => item.parseConfidence)) : 0,
      errors,
      warnings,
    }
  }
}

export function getHtmlPriceParser(): HtmlPriceParser {
  return new HtmlPriceParser()
}

export async function parseHtmlPrices(
  html: string,
  url: string,
  context: ParseContext
): Promise<ParseResult> {
  return getHtmlPriceParser().parse(html, url, context)
}

function extractSchemaOrgCandidates($: cheerio.CheerioAPI, url: string): RawPriceCandidate[] {
  const candidates: RawPriceCandidate[] = []

  $('[itemprop="price"]').each((_index, el) => {
    const priceEl = $(el)
    const priceRaw = cleanText(priceEl.attr('content') || priceEl.text())
    const container = nearestUsefulContainer($, priceEl)
    // Priority: container's itemprop=name → H1 → body's itemprop=name (skip head) → title
    const containerName =
      cleanText(container.find('[itemprop="name"]').first().attr('content') || '') ||
      cleanText(container.find('[itemprop="name"]').first().text())
    const h1Name = cleanText($('h1').first().text())
    // Skip [itemprop="name"] inside <head> (e.g., site name like "CMD")
    const bodyName =
      cleanText($('main [itemprop="name"]').first().attr('content') || '') ||
      cleanText($('main [itemprop="name"]').first().text()) ||
      cleanText($('body [itemprop="name"]').first().attr('content') || '') ||
      cleanText($('body [itemprop="name"]').first().text())
    const nameRaw = containerName || h1Name || bodyName || cleanText($('title').first().text())

    const currency = cleanText(
      container.find('[itemprop="priceCurrency"]').first().attr('content') ||
        $('[itemprop="priceCurrency"]').first().attr('content') ||
        ''
    )
    const availability = cleanText(
      container.find('[itemprop="availability"]').first().attr('href') ||
        container.find('[itemprop="availability"]').first().attr('content') ||
        ''
    )

    candidates.push({
      strategy: 'schema_org',
      confidence: 95,
      nameRaw,
      priceRaw: currency && !priceRaw.includes(currency) ? `${priceRaw} ${currency}` : priceRaw,
      code: extractCodeFromUrl(url),
      slug: extractSlugFromUrl(url),
      available: availability ? !/outofstock|soldout|unavailable/i.test(availability) : true,
      sourceKey: `schema:${priceRaw}:${nameRaw}`,
    })
  })

  $('script[type="application/ld+json"]').each((_index, el) => {
    const json = parseJsonText($(el).text())
    if (!json) return
    candidates.push(...extractCandidatesFromJson(json, 'schema_org', 92))
  })

  return candidates
}

function extractDataAttributeCandidates($: cheerio.CheerioAPI): RawPriceCandidate[] {
  const candidates: RawPriceCandidate[] = []

  $('*').each((_index, el) => {
    const attrs = getAttributes(el)
    const priceRaw = getFirstMatchingAttribute(attrs, PRICE_ATTRIBUTE_RE)
    if (!priceRaw) return

    const node = $(el)
    const container = nearestUsefulContainer($, node)
    const containerAttrs = getAttributes(container.get(0))
    const nameRaw =
      getFirstMatchingAttribute(attrs, NAME_ATTRIBUTE_RE) ||
      getFirstMatchingAttribute(containerAttrs, NAME_ATTRIBUTE_RE) ||
      findNameNear(container)
    const code =
      getFirstMatchingAttribute(attrs, CODE_ATTRIBUTE_RE) ||
      getFirstMatchingAttribute(containerAttrs, CODE_ATTRIBUTE_RE)

    candidates.push({
      strategy: 'data_attributes',
      confidence: 90,
      nameRaw,
      priceRaw,
      code,
      category: cleanText(container.attr('data-category') || ''),
      available: !/false|0|no/i.test(cleanText(attrs['data-available'] || 'true')),
      sourceKey: `data:${code ?? ''}:${priceRaw}:${nameRaw}`,
    })
  })

  return candidates
}

function extractEmbeddedJsonCandidates($: cheerio.CheerioAPI): RawPriceCandidate[] {
  const candidates: RawPriceCandidate[] = []

  $('script').each((_index, el) => {
    const node = $(el)
    const id = node.attr('id') || ''
    const type = node.attr('type') || ''
    const text = node.text().trim()

    if (!text) return
    if (id === '__NEXT_DATA__' || /application\/json|application\/ld\+json/i.test(type)) {
      const json = parseJsonText(text)
      if (json) candidates.push(...extractCandidatesFromJson(json, 'embedded_json', 82))
      return
    }

    for (const assignment of ['__INITIAL_STATE__', '__NUXT__', '__APOLLO_STATE__', 'G.json']) {
      const jsonText = extractAssignedJson(text, assignment)
      if (!jsonText) continue
      const json = parseJsonText(jsonText)
      if (json) candidates.push(...extractCandidatesFromJson(json, 'embedded_json', 78))
    }
  })

  return candidates
}

function extractCssCandidates($: cheerio.CheerioAPI, url: string): RawPriceCandidate[] {
  const candidates: RawPriceCandidate[] = []

  $('tr').each((_index, el) => {
    const row = $(el)
    const cells = row.find('td, th').toArray().map((cell) => cleanText($(cell).text()))
    const priceCell = cells.find((cell) => parseCandidatePrice(cell) !== null)
    if (!priceCell) return
    const nameRaw = cells.find((cell) => cell !== priceCell && !parseCandidatePrice(cell)) || ''
    if (!nameRaw) return

    candidates.push({
      strategy: 'css_class',
      confidence: 68,
      nameRaw,
      priceRaw: priceCell,
      code: cleanText(row.attr('data-code') || ''),
      sourceKey: `table:${nameRaw}:${priceCell}`,
    })
  })

  $('[class], [data-testid]').each((_index, el) => {
    const attrs = getAttributes(el)
    const className = attrs.class || ''
    const testId = attrs['data-testid'] || ''
    if (!PRICE_CLASS_RE.test(className) && !PRICE_CLASS_RE.test(testId)) return

    const node = $(el)
    if (node.parents('tr').length > 0) return

    const priceRaw = cleanText(node.text())
    if (!parseCandidatePrice(priceRaw)) return

    const container = nearestUsefulContainer($, node)
    const nameRaw = findNameNear(container) || findNameNear(node.parent())
    if (!nameRaw || parseCandidatePrice(nameRaw)) return

    candidates.push({
      strategy: 'css_class',
      confidence: 65,
      nameRaw,
      priceRaw,
      code: cleanText(container.attr('data-code') || node.attr('data-code') || ''),
      slug: extractSlugFromUrl(url),
      sourceKey: `css:${nameRaw}:${priceRaw}`,
    })
  })

  return candidates
}

function extractCandidatesFromJson(
  value: unknown,
  strategy: PriceStrategyName,
  confidence: number,
  depth = 0
): RawPriceCandidate[] {
  if (depth > 12 || value === null || value === undefined) return []

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractCandidatesFromJson(item, strategy, confidence, depth + 1))
  }

  if (!isRecord(value)) return []

  const candidates: RawPriceCandidate[] = []
  const nameRaw = getFirstString(value, JSON_NAME_KEYS)
  const priceRaw = getFirstPriceValue(value)

  if (nameRaw && priceRaw) {
    candidates.push({
      strategy,
      confidence,
      nameRaw,
      priceRaw,
      code: getFirstString(value, JSON_CODE_KEYS),
      category: getFirstString(value, JSON_CATEGORY_KEYS),
      description: getFirstString(value, JSON_DESCRIPTION_KEYS),
      available: getJsonAvailability(value),
      sourceKey: `json:${nameRaw}:${priceRaw}`,
    })
  }

  for (const child of Object.values(value)) {
    if (typeof child === 'object' && child !== null) {
      candidates.push(...extractCandidatesFromJson(child, strategy, confidence, depth + 1))
    }
  }

  return candidates
}

function buildItem(
  candidate: RawPriceCandidate,
  url: string,
  context: ParseContext
): UniversalPriceItem | null {
  const nameRaw = cleanText(candidate.nameRaw)
  const parsedPrice = parseCandidatePrice(candidate.priceRaw)
  if (!nameRaw || !parsedPrice) return null

  const code = cleanText(candidate.code || '')
  const slug = cleanText(candidate.slug || extractSlugFromUrl(url) || '')
  const externalIdType: ExternalIdType = code ? 'code' : slug ? 'slug' : 'name_hash'
  const externalId = code || slug || hashText(`${normalizeName(nameRaw)}:${parsedPrice.price}`)

  return {
    externalId,
    externalIdType,
    code: code || undefined,
    slug: slug || undefined,
    name: normalizeName(nameRaw),
    nameRaw,
    category: normalizeCategory(candidate.category),
    description: candidate.description,
    price: parsedPrice.price,
    priceRaw: candidate.priceRaw,
    currency: parsedPrice.currency,
    isMinPrice: parsedPrice.isMinPrice || MIN_PRICE_RE.test(candidate.priceRaw),
    region: context.region,
    locationKey: context.locationKey,
    tariff: context.tariff,
    url,
    available: candidate.available ?? true,
    parseStrategy: candidate.strategy,
    parseConfidence: candidate.confidence,
  }
}

function parseCandidatePrice(raw: string): ReturnType<typeof parsePrice> {
  const parsed = parsePrice(raw)
  if (parsed) {
    return {
      ...parsed,
      isMinPrice: parsed.isMinPrice || MIN_PRICE_RE.test(raw),
    }
  }

  const value = cleanText(raw).match(/(\d[\d\s\u00a0]*)(?:[.,]\d{1,2})?\s*(?:rub|rur|₽)?/i)
  if (!value) return null
  return parsePrice(value[0])
}

function pickResultStrategy(items: UniversalPriceItem[]): PriceStrategyName {
  for (const strategy of STRATEGY_ORDER) {
    if (items.some((item) => item.parseStrategy === strategy)) return strategy
  }
  return 'css_class'
}

function dedupeCandidates(candidates: RawPriceCandidate[]): RawPriceCandidate[] {
  const seen = new Set<string>()
  const seenExternalId = new Set<string>()
  const sorted = [...candidates].sort((a, b) => b.confidence - a.confidence)
  const result: RawPriceCandidate[] = []

  for (const candidate of sorted) {
    const key = [
      normalizeName(candidate.nameRaw),
      cleanText(candidate.code || ''),
      cleanText(candidate.slug || ''),
      cleanText(candidate.priceRaw),
    ].join('|')
    if (seen.has(key)) continue
    seen.add(key)

    // Dedupe by externalId (slug or code) — keep only highest-confidence candidate per ID
    const externalId = cleanText(candidate.code || '') || cleanText(candidate.slug || '') || normalizeName(candidate.nameRaw)
    if (externalId && seenExternalId.has(externalId)) continue
    if (externalId) seenExternalId.add(externalId)

    result.push(candidate)
  }

  return result
}

function nearestUsefulContainer($: cheerio.CheerioAPI, node: cheerio.Cheerio<AnyNode>): cheerio.Cheerio<AnyNode> {
  const container = node
    .parents()
    .filter((_index, el) => {
      const attrs = getAttributes(el)
      const signature = `${attrs.class || ''} ${attrs.itemtype || ''} ${attrs.itemscope || ''}`
      return /offer|product|service|price|card|item|row|table|tbody|tr/i.test(signature)
    })
    .first()

  return container.length ? container : node.parent().length ? node.parent() : $.root()
}

function findNameNear(node: cheerio.Cheerio<any>): string {
  const directAttr = getFirstMatchingAttribute(getAttributes(node.get(0)), NAME_ATTRIBUTE_RE)
  if (directAttr) return directAttr

  const named = node
    .find('[class], [data-testid], [itemprop="name"], h1, h2, h3, h4, a')
    .filter((_index, el) => {
      const attrs = getAttributes(el)
      const signature = `${attrs.class || ''} ${attrs['data-testid'] || ''} ${attrs.itemprop || ''}`
      return NAME_CLASS_RE.test(signature) || /name/i.test(signature) || /^h[1-4]$/i.test(el.tagName)
    })
    .first()

  return cleanText(named.text() || named.attr('content') || node.find('a').first().text())
}

function getFirstPriceValue(record: JsonRecord): string | undefined {
  const direct = getFirstPrimitive(record, JSON_PRICE_KEYS)
  if (direct) return direct

  for (const key of ['offers', 'offer', 'priceSpecification', 'price_specification']) {
    const nested = record[key]
    if (isRecord(nested)) {
      const nestedPrice = getFirstPriceValue(nested)
      if (nestedPrice) return nestedPrice
    }
    if (Array.isArray(nested)) {
      for (const item of nested) {
        if (!isRecord(item)) continue
        const nestedPrice = getFirstPriceValue(item)
        if (nestedPrice) return nestedPrice
      }
    }
  }

  return undefined
}

function getFirstString(record: JsonRecord, keys: string[]): string | undefined {
  return getFirstPrimitive(record, keys)
}

function getFirstPrimitive(record: JsonRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && cleanText(value)) return cleanText(value)
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return undefined
}

function getJsonAvailability(record: JsonRecord): boolean | undefined {
  const value = record.available ?? record.availability ?? record.inStock ?? record.in_stock
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return !/false|0|outofstock|soldout|unavailable/i.test(value)
  return undefined
}

function extractAssignedJson(text: string, marker: string): string | undefined {
  const markerIndex = text.indexOf(marker)
  if (markerIndex < 0) return undefined

  const firstBrace = text.indexOf('{', markerIndex)
  const firstBracket = text.indexOf('[', markerIndex)
  const start =
    firstBrace < 0 ? firstBracket : firstBracket < 0 ? firstBrace : Math.min(firstBrace, firstBracket)
  if (start < 0) return undefined

  const opening = text[start]
  const closing = opening === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escape = false

  for (let i = start; i < text.length; i++) {
    const char = text[i]

    if (inString) {
      if (escape) {
        escape = false
      } else if (char === '\\') {
        escape = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
    } else if (char === opening) {
      depth++
    } else if (char === closing) {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }

  return undefined
}

function parseJsonText(text: string): unknown | undefined {
  try {
    return JSON.parse(text.trim())
  } catch {
    return undefined
  }
}

function getAttributes(el: any): Record<string, string> {
  if (!el || !el.attribs) return {}
  return el.attribs
}

function getFirstMatchingAttribute(attrs: Record<string, string>, pattern: RegExp): string | undefined {
  for (const [key, value] of Object.entries(attrs)) {
    if (pattern.test(key) && cleanText(value)) return cleanText(value)
  }
  return undefined
}

function cleanText(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractCodeFromUrl(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname
    const match = pathname.match(/(?:^|[\/_-])(\d{3,})(?:\/|$)/)
    return match?.[1]
  } catch {
    return undefined
  }
}

function extractSlugFromUrl(url: string): string | undefined {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean)
    const last = segments.at(-1)
    return last && !/^\d+$/.test(last) ? last : undefined
  } catch {
    return undefined
  }
}

function hashText(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 33) ^ text.charCodeAt(i)
  }
  return `nh_${(hash >>> 0).toString(16)}`
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
