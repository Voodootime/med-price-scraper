/**
 * Словарь известных slug'ов городов РФ.
 *
 * Используется в:
 * - region-detector: определение region_strategy по URL
 * - url-classifier: фильтрация URL по target region
 *
 * Источник: slug'ы из sitemap CMD, Gemotest, и других медсайтов.
 * Расширяемый — добавляйте новые города по мере обнаружения.
 */

export const KNOWN_CITY_SLUGS = new Set<string>([
  // Москва и СПб
  'msk',
  'moskva',
  'moscow',
  'spb',
  'sankt-peterburg',
  'saint-petersburg',
  // Крупные города РФ
  'ekb',
  'ekaterinburg',
  'nn',
  'nizhniy-novgorod',
  'nsk',
  'novosibirsk',
  'kzn',
  'kazan',
  'krasnodar',
  'rostov',
  'rnd',
  'samara',
  'ufa',
  'chelyabinsk',
  'perm',
  'volgograd',
  'voronezh',
  'omsk',
  'tyumen',
  'saransk',
  'bryansk',
  'vladimir',
  'izhevsk',
  'nignevartovsk',
  'nyagan',
  'usinsk',
  'makhachkala',
  'nalchik',
  'nazran',
  'khasavyurt',
  'arkhangelsk',
  'murmansk',
  'tolyatti',
  'tver',
  'ryazan',
  'tula',
  'sevastopol',
  'orsk',
  'orenburg',
  'novomoskovsk',
  'obninsk',
  'salekhard',
  'tsimlyansk',
  'vyazma',
  'baksan',
  'terek',
  // Города МО (CMD sitemap)
  'aprelevka',
  'balashikha',
  'bittsa',
  'bobrovo',
  'butovo',
  'chekhov',
  'chernogolovka',
  'dedovsk',
  'dmitrov',
  'dolgoprudnyy',
  'domodedovo',
  'drozhzhino',
  'dzerzhinskiy',
  'elektrostal',
  'fryazino',
  'istra',
  'ivanteevka',
  'kashira',
  'khimki',
  'kirzhach',
  'klin',
  'kolomna',
  'korolyev',
  'kotelniki',
  'kraskovo',
  'krasnogorsk',
  'krasnoznamensk',
  'lobnya',
  'lopatino',
  'lukhovitsy',
  'lyubertsy',
  'malino',
  'misaylovo',
  'monchegorsk',
  'monino',
  'mytishchi',
  'nakhabino',
  'noginsk',
  'odintsovo',
  'podolsk',
  'pushkino',
  'putilkovo',
  'ramenskoe',
  'reutov',
  'serpukhov',
  'shchelkovo',
  'solnechnogorsk',
  'stupino',
  'sverdlovskiy',
  'vidnoe',
  'volgodonsk',
  'zhukovskiy',
  'zvenigorod',
  'zelenograd',
  // Дополнительные города из CMD sitemap (найдены при M1 тестировании)
  'aleksin',
  'kaluga',
  'naro-fominsk',
  'noyabrsk',
  'udelnaya',
  'sergiev-posad',
  'ulan-ude',
])

/**
 * Проверить, является ли строка известным slug'ом города.
 */
export function isKnownCitySlug(slug: string): boolean {
  return KNOWN_CITY_SLUGS.has(slug.toLowerCase())
}

/**
 * Получить все известные slug'ы городов (для итерации).
 */
export function getAllKnownCitySlugs(): string[] {
  return Array.from(KNOWN_CITY_SLUGS)
}
