import type {
  HealthEvaluation,
  ScrapeHealth,
  UniversalPriceItem,
  ValidationResult,
} from '@/scraper/types'
import type { ValidationRules, Validator } from '@/scraper/interfaces'

const REQUIRED_TEXT_FIELDS: Array<keyof UniversalPriceItem> = [
  'externalId',
  'externalIdType',
  'name',
  'nameRaw',
  'priceRaw',
  'currency',
  'region',
  'url',
  'parseStrategy',
]

export class DefaultValidator implements Validator {
  validateItem(
    item: UniversalPriceItem,
    rules: ValidationRules
  ): { ok: boolean; errors: string[] } {
    const errors: string[] = []

    for (const field of REQUIRED_TEXT_FIELDS) {
      const value = item[field]
      if (value === undefined || value === null || String(value).trim() === '') {
        errors.push(`${String(field)} is required`)
      }
    }

    if (!Number.isInteger(item.price)) {
      errors.push('price must be an integer in kopecks')
    }

    if (!rules.allowZeroPrice && item.price <= 0) {
      errors.push('price must be greater than zero')
    }

    const [minRub, maxRub] = rules.priceRange
    const minKopecks = minRub * 100
    const maxKopecks = maxRub * 100
    if (item.price < minKopecks || item.price > maxKopecks) {
      errors.push(`price must be within ${minRub}-${maxRub} RUB`)
    }

    if (item.marketPrice !== undefined && item.marketPrice < item.price) {
      errors.push('marketPrice must be greater than or equal to price')
    }

    if (item.parseConfidence < 0 || item.parseConfidence > 100) {
      errors.push('parseConfidence must be within 0-100')
    }

    try {
      const url = new URL(item.url)
      if (!['http:', 'https:'].includes(url.protocol)) {
        errors.push('url must use http or https')
      }
    } catch {
      errors.push('url must be valid')
    }

    return { ok: errors.length === 0, errors }
  }

  validateBatch(items: UniversalPriceItem[], rules: ValidationRules): ValidationResult {
    const errors: string[] = []
    const warnings: string[] = []
    let itemsValid = 0
    let itemsInvalid = 0

    if (items.length < rules.minItems) {
      errors.push(`items count ${items.length} is below minItems ${rules.minItems}`)
    }

    if (rules.maxItems !== undefined && items.length > rules.maxItems) {
      warnings.push(`items count ${items.length} is above maxItems ${rules.maxItems}`)
    }

    const seenKeys = new Set<string>()

    for (const [index, item] of items.entries()) {
      const result = this.validateItem(item, rules)
      const itemErrors = [...result.errors]
      const key = `${item.region}:${item.locationKey ?? ''}:${item.externalId}`

      if (seenKeys.has(key)) {
        itemErrors.push(`duplicate externalId in scope: ${key}`)
      }
      seenKeys.add(key)

      if (itemErrors.length === 0) {
        itemsValid += 1
      } else {
        itemsInvalid += 1
        errors.push(...itemErrors.map((error) => `item[${index}]: ${error}`))
      }
    }

    return {
      ok: errors.length === 0,
      errors,
      warnings,
      itemsValid,
      itemsInvalid,
    }
  }

  evaluateHealth(health: ScrapeHealth, rules: ValidationRules): HealthEvaluation {
    if (health.itemsExtracted <= 0) {
      return { action: 'pause_competitor', reason: 'no items extracted' }
    }

    if (health.itemsExtracted < health.expectedMin || health.itemsExtracted < rules.minItems) {
      return {
        action: 'trigger_reprobe',
        reason: `items extracted ${health.itemsExtracted} below expected minimum`,
      }
    }

    if (
      rules.alertIfStructureDiff !== undefined &&
      health.structureDiff >= rules.alertIfStructureDiff
    ) {
      return {
        action: 'trigger_partial_reprobe',
        reason: `structure diff ${health.structureDiff} exceeded threshold ${rules.alertIfStructureDiff}`,
      }
    }

    if (
      rules.alertIfNullFieldsRate !== undefined &&
      health.nullFieldsRate >= rules.alertIfNullFieldsRate
    ) {
      return {
        action: 'proceed_with_warning',
        reason: `null fields rate ${health.nullFieldsRate} exceeded threshold ${rules.alertIfNullFieldsRate}`,
      }
    }

    return { action: 'proceed' }
  }

  validateScope(region: string, targetRegion: string): boolean {
    return region === targetRegion
  }
}

let validatorInstance: DefaultValidator | null = null

export function getValidator(): DefaultValidator {
  if (!validatorInstance) {
    validatorInstance = new DefaultValidator()
  }
  return validatorInstance
}
