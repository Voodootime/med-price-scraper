/**
 * CMD fixture test — offline test for html-price-parser on CMD card.
 *
 * Запуск: bun run src/scraper/parsers/__test__/html-price-parser-cmd-test.ts
 *
 * Fixture: cmd-gluten.html (85 KB, сохранён из live fetch)
 * Ожидания:
 *   - 1 item (не 3+)
 *   - strategy: schema_org
 *   - confidence: 95
 *   - name: "Глютен (клейковина), IgE в Москве"
 *   - price: 81000 (810 ₽)
 *   - externalId: "gluten"
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { parseHtmlPrices } from '@/scraper/parsers'

const fixturePath = join(
  process.cwd(),
  'src/scraper/parsers/__test__/fixtures/cmd-gluten.html'
)
const html = readFileSync(fixturePath, 'utf-8')

const url = 'https://www.cmd-online.ru/analizy-i-tseny/katalog-analizov/msk/gluten/'

const result = await parseHtmlPrices(html, url, {
  competitorId: 'test',
  region: 'mo',
  scrapeRunId: 'test',
})

console.log('=== CMD Fixture Parser Test ===')
console.log(`Items: ${result.items.length}`)
console.log(`Strategy: ${result.strategy}`)
console.log(`Confidence: ${result.confidence}`)
console.log(`Errors: ${result.errors.length}`)

// Assertions
const assertions: Array<{ name: string; actual: unknown; expected: unknown }> = [
  { name: 'items.length', actual: result.items.length, expected: 1 },
  { name: 'strategy', actual: result.strategy, expected: 'schema_org' },
  { name: 'confidence', actual: result.confidence, expected: 95 },
  { name: 'errors.length', actual: result.errors.length, expected: 0 },
]

const item = result.items[0]
if (item) {
  assertions.push(
    { name: 'externalId', actual: item.externalId, expected: 'gluten' },
    { name: 'name', actual: item.name, expected: 'глютен (клейковина), ige в москве' },
    { name: 'price', actual: item.price, expected: 81000 },
    { name: 'currency', actual: item.currency, expected: 'RUB' },
    { name: 'parseStrategy', actual: item.parseStrategy, expected: 'schema_org' }
  )
}

console.log('\n=== Assertions ===')
let passed = 0
let failed = 0
for (const a of assertions) {
  const ok = a.actual === a.expected
  const status = ok ? '✅' : '❌'
  console.log(`  ${status} ${a.name}: ${JSON.stringify(a.actual)}${ok ? '' : ` (expected ${JSON.stringify(a.expected)})`}`)
  if (ok) passed++
  else failed++
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

console.log('\n✅ All assertions passed')
