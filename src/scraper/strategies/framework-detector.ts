/**
 * Framework Detector — определяет веб-фреймворк сайта по HTML-признакам.
 *
 * Анализирует HTML главной страницы и выявляет:
 * - Фреймворк (bitrix, next, nuxt, angular, vue, react-spa, tilda, wordpress, custom, unknown)
 * - SSR vs SPA (по наличию серверного состояния)
 * - Embedded state (__NEXT_DATA__, G.json./api/, window.__INITIAL_STATE__, __APOLLO_STATE__)
 * - Schema.org микроразметку (itemprop=, ld+json)
 * - Формат валюты (₽, руб., р., rub, mixed)
 * - Anti-bot hints (Cloudflare, reCAPTCHA, DataDome, PerimeterX, Akamai)
 *
 * Документация: docs/scraping-methodology.md раздел 2.2
 */

import { logger } from '@/lib/logger'
import type { AntiBotHints, Framework } from '@/scraper/types'

const log = logger.child({ module: 'framework-detector' })

/** Результат определения фреймворка и связанных характеристик. */
export interface FrameworkDetectionResult {
  /** Определённый фреймворк */
  framework: Framework
  /** Доверие 0-100 (зависит от количества и силы сработавших сигналов) */
  confidence: number
  /** Сработавшие признаки (для аудита/debug) */
  signals: string[]
  /** Server-side rendering (HTML содержит финальный контент) */
  isSSR: boolean
  /** Наличие встроенного JSON-состояния в HTML */
  hasEmbeddedState: boolean
  /** Schema.org микроразметка присутствует */
  hasSchemaOrg: boolean
  /** Преобладающий формат валюты */
  currencyFormat: '₽' | 'руб.' | 'р.' | 'rub' | 'mixed'
  /** Подсказки об anti-bot защите */
  antiBotHints: AntiBotHints
}

/** Один сигнал определения фреймворка. */
interface FrameworkSignal {
  framework: Framework
  signal: string
  weight: number
}

/**
 * Определить фреймворк и характеристики сайта по HTML.
 *
 * @param html - HTML-страница (обычно главная)
 * @returns результат определения с confidence и signals
 *
 * @example
 * const result = detectFramework(html)
 * if (result.framework === 'next' && result.isSSR) {
 *   // сайт на Next.js с SSR — embedded_json стратегия может сработать
 * }
 */
export function detectFramework(html: string): FrameworkDetectionResult {
  const signals: FrameworkSignal[] = []

  // === Framework detection (методология раздел 2.2) ===
  if (/class="[^"]*bx-core\b/.test(html) || /\/bitrix\//.test(html)) {
    signals.push({ framework: 'bitrix', signal: 'class="bx-core" или /bitrix/ в asset paths', weight: 90 })
  }
  if (/<script[^>]+id="__NEXT_DATA__"/.test(html)) {
    signals.push({ framework: 'next', signal: '__NEXT_DATA__ script', weight: 95 })
  }
  if (/__NUXT__|window\.__NUXT__/.test(html)) {
    signals.push({ framework: 'nuxt', signal: '__NUXT__ / window.__NUXT__', weight: 95 })
  }
  if (/ng-version|_nghost-|_ngcontent-/.test(html)) {
    signals.push({ framework: 'angular', signal: 'ng-version / _nghost- / _ngcontent-', weight: 90 })
  }
  if (/data-v-[a-f0-9]{6,}/.test(html)) {
    signals.push({ framework: 'vue', signal: 'data-v- attrs (hash)', weight: 70 })
  }
  if (/data-reactroot|data-react-helmet|data-reactid/.test(html)) {
    signals.push({ framework: 'react-spa', signal: 'data-reactroot', weight: 65 })
  }
  if (/<meta[^>]+name="generator"[^>]+content="[^"]*tilda/i.test(html)) {
    signals.push({ framework: 'tilda', signal: 'meta generator = tilda', weight: 95 })
  }
  if (/\/wp-content\/|\/wp-includes\//.test(html)) {
    signals.push({ framework: 'wordpress', signal: '/wp-content/ или /wp-includes/', weight: 90 })
  }

  // === Выбор фреймворка по наибольшему весу ===
  let framework: Framework = 'unknown'
  let maxWeight = 0
  for (const s of signals) {
    if (s.weight > maxWeight) {
      maxWeight = s.weight
      framework = s.framework
    }
  }
  if (framework === 'unknown' && /<[^>]+data-[a-z]+=/.test(html)) {
    framework = 'custom'
  }

  // === isSSR: server-side rendering detection ===
  const isSSR =
    /<script[^>]+id="__NEXT_DATA__"/.test(html) ||
    /__NUXT__|window\.__NUXT__/.test(html) ||
    /_nghost-/.test(html) ||
    hasRealContent(html)

  // === hasEmbeddedState: встроенный JSON state ===
  const hasEmbeddedState =
    /__NEXT_DATA__/.test(html) ||
    /G\.json\.\/api\//.test(html) ||
    /window\.__INITIAL_STATE__/.test(html) ||
    /window\.__APOLLO_STATE__/.test(html) ||
    /window\.__NUXT__/.test(html)

  // === hasSchemaOrg: микроразметка ===
  const hasSchemaOrg = /itemprop=/.test(html) || /<script[^>]+type="application\/ld\+json"/.test(html)

  // === currencyFormat: подсчёт вхождений ===
  const currencyFormat = detectCurrencyFormat(html)

  // === antiBotHints ===
  const antiBotHints = detectAntiBot(html)

  // === confidence ===
  const confidence = maxWeight > 0 ? Math.min(100, maxWeight) : 10

  const result: FrameworkDetectionResult = {
    framework,
    confidence,
    signals: signals.map((s) => `${s.framework}: ${s.signal}`),
    isSSR,
    hasEmbeddedState,
    hasSchemaOrg,
    currencyFormat,
    antiBotHints,
  }

  log.debug(
    { framework, confidence, isSSR, hasEmbeddedState, hasSchemaOrg, currencyFormat, antiBotHints },
    'Framework detected'
  )

  return result
}

/**
 * Проверка, содержит ли HTML реальный контент (не пустой root div).
 * SPA-сайты обычно имеют пустой <div id="root"></div> или <div id="app"></div>.
 */
function hasRealContent(html: string): boolean {
  // Если в body есть > 500 символов текста — вероятно SSR
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  if (!bodyMatch) return false
  const bodyText = bodyMatch[1].replace(/<[^>]+>/g, '').trim()
  if (bodyText.length > 500) return true
  // Если root div пустой — SPA
  if (/<div\s+id="(root|app|__next)"[^>]*>\s*<\/div>/i.test(html)) return false
  return bodyText.length > 100
}

/**
 * Определить преобладающий формат валюты в HTML.
 * Сравнивает вхождения ₽, "руб.", "р.", "rub".
 */
function detectCurrencyFormat(
  html: string
): '₽' | 'руб.' | 'р.' | 'rub' | 'mixed' {
  const counts = {
    '₽': (html.match(/₽/g) || []).length,
    'руб.': (html.match(/руб\./g) || []).length,
    'р.': (html.match(/\bр\./g) || []).length,
    rub: (html.match(/\brub\b/gi) || []).length,
  }

  const entries = Object.entries(counts) as Array<[keyof typeof counts, number]>
  const nonzero = entries.filter(([, n]) => n > 0)
  if (nonzero.length === 0) return '₽'
  if (nonzero.length === 1) return nonzero[0][0]

  // Несколько форматов — выбрать максимум, но пометить mixed если разница маленькая
  nonzero.sort((a, b) => b[1] - a[1])
  const [top, second] = nonzero
  if (top[1] - second[1] <= Math.max(2, top[1] * 0.2)) return 'mixed'
  return top[0]
}

/**
 * Обнаружить anti-bot защиту: Cloudflare, reCAPTCHA, DataDome, PerimeterX, Akamai.
 */
function detectAntiBot(html: string): AntiBotHints {
  const hints: AntiBotHints = {}

  if (/cdn-cgi\/challenge-platform|__cf_bm|cf-ray/i.test(html)) {
    hints.cloudflare = true
    hints.jsChallenge = true
  }
  if (/g-recaptcha|data-sitekey|googlerecaptcha/i.test(html)) {
    hints.recaptcha = true
  }
  if (/datadome|dd-datakey|dd-key/i.test(html)) {
    hints.datadome = true
    hints.jsChallenge = true
  }
  if (/perimeterx|_pxhd|px-captcha/i.test(html)) {
    hints.perimeterX = true
    hints.jsChallenge = true
  }
  if (/_abck=|akamai|bm-verify/i.test(html)) {
    hints.akamai = true
    hints.jsChallenge = true
  }

  return hints
}
