import { getHtmlPriceParser, parseHtmlPrices } from '@/scraper/parsers'
import type { ParseContext } from '@/scraper/interfaces'

const context: ParseContext = {
  competitorId: 'fixture',
  region: 'mo',
  scrapeRunId: 'run-fixture',
}

const parser = getHtmlPriceParser()

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

const schemaHtml = `
  <html>
    <head><title>Complete blood count</title></head>
    <body>
      <div itemscope itemtype="https://schema.org/Product">
        <h1 itemprop="name">Complete blood count</h1>
        <span itemprop="price" content="530">530</span>
        <meta itemprop="priceCurrency" content="RUB" />
        <link itemprop="availability" href="https://schema.org/InStock" />
      </div>
    </body>
  </html>
`

const dataAttributeHtml = `
  <section>
    <div class="service-card" data-code="A100" data-service-name="Glucose blood test" data-price="250">
      <a>Glucose blood test</a>
    </div>
    <div class="service-card" data-code="A200" data-eec-name="Vitamin D" data-eec-price="1900">
      <a>Vitamin D</a>
    </div>
  </section>
`

const embeddedJsonHtml = `
  <script id="__NEXT_DATA__" type="application/json">
    {
      "props": {
        "pageProps": {
          "services": [
            { "id": "HX-1", "name": "Ferritin", "price": 780, "category": "Lab" },
            { "id": "HX-2", "serviceName": "TSH", "minPrice": "ot 620 RUB", "available": true }
          ]
        }
      }
    }
  </script>
`

const cssHtml = `
  <table>
    <tr data-code="T1"><td>ECG</td><td><span class="price">1200 RUB</span></td></tr>
    <tr data-code="T2"><td>Ultrasound</td><td><span class="service-price">2500 RUB</span></td></tr>
  </table>
`

assert(parser.canParse(schemaHtml), 'schema fixture should be parseable')
assert(parser.canParse(dataAttributeHtml), 'data attribute fixture should be parseable')
assert(parser.canParse(embeddedJsonHtml), 'embedded JSON fixture should be parseable')
assert(parser.canParse(cssHtml), 'CSS fixture should be parseable')
assert(!parser.canParse('<html><body>No prices here</body></html>'), 'HTML without price signals should not parse')

const schemaResult = await parseHtmlPrices(
  schemaHtml,
  'https://example.test/analizy-i-tseny/_100002/',
  context
)
assert(schemaResult.errors.length === 0, 'schema parser should not return errors')
assert(schemaResult.strategy === 'schema_org', 'schema strategy should win')
assert(schemaResult.items.length === 1, 'schema parser should extract one item')
assert(schemaResult.items[0].externalId === '100002', 'schema parser should use numeric code from URL')
assert(schemaResult.items[0].price === 53000, 'schema parser should convert RUB to kopecks')
assert(schemaResult.items[0].available, 'schema parser should preserve availability')

const dataResult = await parseHtmlPrices(dataAttributeHtml, 'https://example.test/catalog', context)
assert(dataResult.items.length === 2, 'data attribute parser should extract two items')
assert(dataResult.items[0].parseStrategy === 'data_attributes', 'data strategy should be recorded')
assert(dataResult.items.some((item) => item.externalId === 'A100'), 'data parser should use data-code')
assert(dataResult.items.some((item) => item.price === 190000), 'data parser should parse second price')

const jsonResult = await parseHtmlPrices(embeddedJsonHtml, 'https://example.test/state', context)
assert(jsonResult.items.length === 2, 'embedded JSON parser should extract service array')
assert(jsonResult.items.every((item) => item.parseStrategy === 'embedded_json'), 'JSON items should use JSON strategy')
assert(jsonResult.items.some((item) => item.nameRaw === 'TSH' && item.isMinPrice), 'JSON parser should keep min price')

const cssResult = await parseHtmlPrices(cssHtml, 'https://example.test/services', context)
assert(cssResult.items.length === 2, 'CSS parser should extract table rows')
assert(cssResult.items.every((item) => item.parseStrategy === 'css_class'), 'CSS items should use CSS strategy')
assert(cssResult.items.some((item) => item.nameRaw === 'Ultrasound' && item.price === 250000), 'CSS parser should parse table prices')

console.log('html-price-parser-test: ok')
