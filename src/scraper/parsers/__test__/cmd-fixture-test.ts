/**
 * Test parser on CMD gluten fixture (offline, no network).
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { parseHtmlPrices } from '@/scraper/parsers'

const fixturePath = join(
  process.cwd(),
  'src/scraper/parsers/__test__/fixtures/cmd-gluten.html'
)
const html = readFileSync(fixturePath, 'utf-8')

console.log(`Fixture: ${fixturePath}`)
console.log(`HTML size: ${html.length} bytes`)
console.log('')

const result = await parseHtmlPrices(html, 'https://www.cmd-online.ru/analizy-i-tseny/katalog-analizov/msk/gluten/', {
  competitorId: 'test',
  region: 'mo',
  scrapeRunId: 'test',
})

console.log('=== PARSE RESULT ===')
console.log(`Strategy: ${result.strategy}`)
console.log(`Confidence: ${result.confidence}`)
console.log(`Items: ${result.items.length}`)
console.log(`Errors: ${result.errors.length}`)
console.log(`Warnings: ${result.warnings.length}`)
console.log('')

if (result.items.length > 0) {
  console.log('=== FIRST 3 ITEMS ===')
  for (const item of result.items.slice(0, 3)) {
    console.log(JSON.stringify({
      externalId: item.externalId,
      externalIdType: item.externalIdType,
      code: item.code,
      slug: item.slug,
      name: item.name,
      nameRaw: item.nameRaw,
      price: item.price,
      priceRaw: item.priceRaw,
      currency: item.currency,
      isMinPrice: item.isMinPrice,
      parseStrategy: item.parseStrategy,
      parseConfidence: item.parseConfidence,
    }, null, 2))
  }
}

if (result.errors.length > 0) {
  console.log('\n=== ERRORS (first 5) ===')
  for (const e of result.errors.slice(0, 5)) {
    console.log(`  ${e}`)
  }
}

if (result.warnings.length > 0) {
  console.log('\n=== WARNINGS (first 5) ===')
  for (const w of result.warnings.slice(0, 5)) {
    console.log(`  ${w}`)
  }
}
