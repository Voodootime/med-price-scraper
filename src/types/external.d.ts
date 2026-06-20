/**
 * Type declarations for modules without @types.
 */

declare module 'robots-parser' {
  export interface Robots {
    isAllowed(url: string, userAgent?: string): boolean | null
    isDisallowed(url: string, userAgent?: string): boolean
    getCrawlDelay(userAgent?: string): number | undefined
    getSitemaps(): string[]
    getMatchingLineNumber(userAgent: string, url: string): number
  }

  function robotsParser(url: string, body: string): Robots
  export default robotsParser
}
