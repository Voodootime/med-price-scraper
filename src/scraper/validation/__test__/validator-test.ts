import { getValidator } from '@/scraper/validation/default-validator'
import type { UniversalPriceItem } from '@/scraper/types'
import type { ValidationRules } from '@/scraper/interfaces'

const rules: ValidationRules = {
  minItems: 1,
  priceRange: [50, 1_000_000],
  allowZeroPrice: false,
  pagesWithPriceRatio: 0.7,
  alertIfNullFieldsRate: 0.2,
  alertIfStructureDiff: 0.3,
}

const validItem: UniversalPriceItem = {
  externalId: '100002',
  externalIdType: 'code',
  code: '100002',
  name: 'общий анализ крови',
  nameRaw: 'Общий анализ крови',
  price: 53000,
  priceRaw: '530 р.',
  currency: 'RUB',
  isMinPrice: false,
  region: 'mo',
  url: 'https://www.cmd-online.ru/analizy-i-tseny/100002/',
  available: true,
  parseStrategy: 'schema_org',
  parseConfidence: 95,
}

const validator = getValidator()

assert(validator.validateItem(validItem, rules).ok, 'valid item should pass')
assert(validator.validateBatch([validItem], rules).ok, 'valid batch should pass')
assert(validator.validateScope('mo', 'mo'), 'matching scope should pass')
assert(!validator.validateScope('moscow', 'mo'), 'mismatched scope should fail')

const invalidItem = {
  ...validItem,
  externalId: '',
  price: 0,
  url: 'file:///etc/passwd',
}

const invalid = validator.validateItem(invalidItem, rules)
assert(!invalid.ok, 'invalid item should fail')
assert(
  invalid.errors.some((error) => error.includes('externalId')),
  'invalid item should report missing externalId'
)
assert(
  invalid.errors.some((error) => error.includes('greater than zero')),
  'invalid item should report zero price'
)

const duplicate = validator.validateBatch([validItem, validItem], rules)
assert(!duplicate.ok, 'duplicate scoped externalId should fail')

assert(
  validator.evaluateHealth(
    {
      itemsExtracted: 0,
      expectedMin: 1,
      nullFieldsRate: 0,
      htmlStructureHash: 'hash',
      structureDiff: 0,
    },
    rules
  ).action === 'pause_competitor',
  'zero items should pause competitor'
)

console.log('validator-test: ok')

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message)
  }
}
