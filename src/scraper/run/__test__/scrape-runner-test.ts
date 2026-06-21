import { computeRunStatus } from '@/scraper/run/scrape-runner'

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`)
  }
}

assertEqual(
  computeRunStatus({
    urlsPlanned: 3,
    urlsSucceeded: 3,
    urlsFailed: 0,
    itemsExtracted: 12,
    validationOk: true,
  }),
  'success',
  'all fetched and valid'
)

assertEqual(
  computeRunStatus({
    urlsPlanned: 3,
    urlsSucceeded: 2,
    urlsFailed: 1,
    itemsExtracted: 12,
    validationOk: true,
  }),
  'partial',
  'some failed URLs'
)

assertEqual(
  computeRunStatus({
    urlsPlanned: 3,
    urlsSucceeded: 3,
    urlsFailed: 0,
    itemsExtracted: 12,
    validationOk: false,
  }),
  'partial',
  'validation warnings/errors'
)

assertEqual(
  computeRunStatus({
    urlsPlanned: 3,
    urlsSucceeded: 0,
    urlsFailed: 3,
    itemsExtracted: 0,
    validationOk: false,
  }),
  'failed',
  'no successful extraction'
)

console.log('scrape-runner tests passed')
