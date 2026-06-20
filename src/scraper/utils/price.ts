/**
 * Утилиты для нормализации цен.
 *
 * Парсит разные форматы цен с медицинских сайтов:
 * - "1 300 ₽" (Gemotest, Helix)
 * - "530 р." (CMD)
 * - "3 000 руб." (Veramed, Altamed+)
 * - "от 6 500 ₽" (Altamed+ stom)
 * - "1&nbsp;300 ₽" (Medsi — с HTML entity)
 *
 * Возвращает цену в КОПЕЙКАХ (Int) для точности и совместимости с SQLite.
 *
 * Документация: docs/scraping-methodology.md раздел 6.1
 */

export interface ParsedPrice {
  /** Цена в копейках (1300 ₽ → 130000) */
  price: number
  /** true если цена с префиксом "от" (минимальная) */
  isMinPrice: boolean
  /** ISO 4217 валюта (RUB по умолчанию) */
  currency: string
  /** Сырая строка, из которой парсили */
  raw: string
}

/**
 * Парсинг цены из строки.
 *
 * @example
 * parsePrice("1 300 ₽")        // → { price: 130000, isMinPrice: false, currency: 'RUB' }
 * parsePrice("530 р.")         // → { price: 53000,  isMinPrice: false, currency: 'RUB' }
 * parsePrice("от 6 500 ₽")     // → { price: 650000, isMinPrice: true,  currency: 'RUB' }
 * parsePrice("1&nbsp;300 руб.") // → { price: 130000, isMinPrice: false, currency: 'RUB' }
 */
export function parsePrice(raw: string): ParsedPrice | null {
  if (!raw || typeof raw !== 'string') return null

  // Декодируем HTML entities
  const cleaned = raw
    .replace(/&nbsp;/g, ' ')
    .replace(/&thinsp;/g, '')
    .replace(/&#160;/g, ' ')
    .replace(/\u00A0/g, ' ') // unicode non-breaking space
    .trim()

  // Определяем, есть ли префикс "от"
  const isMinPrice = /^от\s+/i.test(cleaned)

  // Извлекаем число: ищем первую последовательность цифр и пробелов
  const numberMatch = cleaned.match(/(\d[\d\s]*)/)
  if (!numberMatch) return null

  const numStr = numberMatch[1].replace(/\s/g, '')
  const price = parseInt(numStr, 10)

  if (isNaN(price) || price < 0) return null

  // Определяем валюту
  let currency = 'RUB'
  if (/₽/.test(cleaned)) currency = 'RUB'
  else if (/руб\.?/i.test(cleaned)) currency = 'RUB'
  else if (/р\.?$/i.test(cleaned)) currency = 'RUB'
  else if (/\$/.test(cleaned)) currency = 'USD'
  else if (/€/.test(cleaned)) currency = 'EUR'

  // Возвращаем в копейках
  return {
    price: price * 100,
    isMinPrice,
    currency,
    raw,
  }
}

/**
 * Конвертировать копейки в рубли (для отображения).
 */
export function kopecksToRubles(kopecks: number): number {
  return kopecks / 100
}

/**
 * Форматировать цену для отображения: 130000 → "1 300 ₽"
 */
export function formatPrice(kopecks: number, currency = 'RUB'): string {
  const rubles = kopecksToRubles(kopecks)
  const formatted = rubles.toLocaleString('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })
  const symbol = currency === 'RUB' ? '₽' : currency
  return `${formatted} ${symbol}`
}

/**
 * Вычислить процент изменения цены.
 * Возвращает значение × 100 (для точности: 5.25% → 525).
 */
export function computeDeltaPct(previous: number, current: number): number {
  if (previous === 0) return 0
  return Math.round(((current - previous) / previous) * 10000)
}

/**
 * Нормализация названия услуги:
 * - trim
 * - collapse multiple spaces
 * - lowercase (для канонической формы)
 * - удалить лишние переносы строк
 */
export function normalizeName(nameRaw: string): string {
  return nameRaw
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Нормализация категории.
 */
export function normalizeCategory(category?: string): string | undefined {
  if (!category) return undefined
  return category
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Вычислить SHA-256 хеш строки (для content-hash и structure fingerprint).
 */
export async function sha256(text: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(text)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Вычислить "структурный" хеш HTML — без динамических токенов (CSRF, timestamp, session).
 * Используется для diff-проверки structureDiff (раздел 5.1).
 */
export async function htmlStructureHash(html: string): Promise<string> {
  // Удаляем динамические части
  const cleaned = html
    .replace(/name="([^"]*token[^"]*)"[^>]*value="[^"]*"/gi, '')
    .replace(/name="([^"]*sessid[^"]*)"[^>]*value="[^"]*"/gi, '')
    .replace(/data-[a-z-]+="[a-f0-9]{32,}"/gi, '') // data-v-hash, data-cid, etc.
    .replace(/\d{10,}/g, '') // timestamps
    .replace(/bx-context-id="[^"]*"/gi, '')

  return sha256(cleaned)
}

/**
 * Простое сравнение структуры HTML (dice coefficient на триграммах).
 * Возвращает 0-1, где 1 = identical, 0 = полностью разные.
 */
export function structureSimilarity(htmlA: string, htmlB: string): number {
  // Упрощённая версия: сравниваем множества HTML-тегов
  const tagsA = new Set((htmlA.match(/<[a-z][a-z0-9-]*/gi) || []).map((t) => t.toLowerCase()))
  const tagsB = new Set((htmlB.match(/<[a-z][a-z0-9-]*/gi) || []).map((t) => t.toLowerCase()))

  const intersection = new Set([...tagsA].filter((x) => tagsB.has(x)))
  const union = new Set([...tagsA, ...tagsB])

  if (union.size === 0) return 1
  return intersection.size / union.size
}
