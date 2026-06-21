import {
  categorizeUrl,
  hasCitySegment,
  isLikelyPriceUrl,
  matchesTargetRegion,
  normalizeDiscoveryUrl,
  scoreLikelyPriceUrl,
} from '@/scraper/discovery'
import type { RegionStrategy } from '@/scraper/types'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

const regionStrategy: RegionStrategy = {
  type: 'url_path_segment',
  mapping: {
    moscow: 'msk',
    spb: 'spb',
  },
}

assert(
  normalizeDiscoveryUrl('https://example.ru/catalog/msk/service/?b=2&a=1#details') ===
    'https://example.ru/catalog/msk/service?a=1&b=2',
  'normalizeDiscoveryUrl should remove hash, trim trailing slash and sort query params'
)

assert(categorizeUrl('https://example.ru/catalog/msk/analizy/krovi') === 'catalog', 'catalog URL')
assert(categorizeUrl('https://example.ru/services/diagnostics/mrt') === 'service', 'service URL')
assert(categorizeUrl('https://example.ru/clinics/msk') === 'clinic', 'clinic URL')
assert(categorizeUrl('https://example.ru/doctors/ivanov') === 'doctor', 'doctor URL')
assert(categorizeUrl('https://example.ru/blog/how-to-prepare') === 'article', 'article URL')

assert(isLikelyPriceUrl('https://example.ru/catalog/msk/analizy/krovi'), 'catalog should be price URL')
assert(isLikelyPriceUrl('https://example.ru/services/diagnostics/mrt'), 'service should be price URL')
assert(!isLikelyPriceUrl('https://example.ru/blog/analizy-u-detey'), 'article should not be price URL')
assert(!isLikelyPriceUrl('https://example.ru/doctors/price-specialist'), 'doctor should not be price URL')
assert(
  scoreLikelyPriceUrl('https://example.ru/analizy-i-tseny/katalog-analizov/msk/glukoza_300076/') >
    scoreLikelyPriceUrl('https://example.ru/meditsinskie-uslugi'),
  'deep analysis service pages should outrank broad service landing pages'
)
assert(
  isLikelyPriceUrl('https://www.cmd-online.ru/analizy-i-tseny/katalog-analizov/baksan/peroralnyj_glukozotolerantnyj_test_300076/'),
  'CMD analysis cards should be price URLs'
)
assert(
  !isLikelyPriceUrl('https://www.cmd-online.ru/patsientam/diskontnaya-programma-dev/htmlRender.php'),
  'discount helper pages should not be price URLs'
)
assert(
  !isLikelyPriceUrl('https://www.cmd-online.ru/calendar-kk/diagnostika-funktsii-shchitovidnoy-zhelezy'),
  'calendar pages should not be price URLs'
)
assert(
  scoreLikelyPriceUrl('https://www.cmd-online.ru/analizy-i-tseny/katalog-analizov/baksan/peroralnyj_glukozotolerantnyj_test_300076/') >
    scoreLikelyPriceUrl('https://www.cmd-online.ru/analizy-i-tseny/urgent-analyzes'),
  'CMD analysis cards should outrank broad urgent analysis pages'
)

assert(
  hasCitySegment('https://example.ru/catalog/msk/analizy/krovi', regionStrategy),
  'known city segment should be detected'
)
assert(
  matchesTargetRegion('https://example.ru/catalog/msk/analizy/krovi', 'moscow', regionStrategy),
  'target city segment should match'
)
assert(
  !matchesTargetRegion('https://example.ru/catalog/spb/analizy/krovi', 'moscow', regionStrategy),
  'other city segment should not match'
)
assert(
  matchesTargetRegion('https://example.ru/catalog/analizy/krovi', 'moscow', regionStrategy),
  'URL without known city segment should remain eligible'
)

console.log('url-classifier tests passed')
