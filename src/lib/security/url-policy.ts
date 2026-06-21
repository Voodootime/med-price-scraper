import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

const MAX_REDIRECTS = 5

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
])

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeUrlError'
  }
}

export function parsePublicHttpUrl(input: string): URL {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new UnsafeUrlError('Invalid URL')
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new UnsafeUrlError('Only http and https URLs are allowed')
  }

  const hostname = normalizeHostname(url.hostname)
  if (!hostname || BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')) {
    throw new UnsafeUrlError('Local hostnames are not allowed')
  }

  const literalIpVersion = isIP(hostname)
  if (literalIpVersion && isBlockedIp(hostname)) {
    throw new UnsafeUrlError('Private, loopback, link-local, and reserved IPs are not allowed')
  }

  return url
}

export async function assertPublicHttpUrl(input: string): Promise<URL> {
  const url = parsePublicHttpUrl(input)
  const hostname = normalizeHostname(url.hostname)

  if (isIP(hostname)) return url

  const addresses = await lookup(hostname, { all: true, verbatim: true })
  if (addresses.length === 0) {
    throw new UnsafeUrlError('Hostname does not resolve')
  }

  for (const address of addresses) {
    if (isBlockedIp(address.address)) {
      throw new UnsafeUrlError('Hostname resolves to a blocked IP range')
    }
  }

  return url
}

export async function fetchPublicHttpUrl(
  input: string,
  init: RequestInit,
  maxRedirects = MAX_REDIRECTS
): Promise<Response> {
  let currentUrl = await assertPublicHttpUrl(input)

  for (let redirect = 0; redirect <= maxRedirects; redirect++) {
    const response = await fetch(currentUrl, {
      ...init,
      redirect: 'manual',
    })

    if (!isRedirectStatus(response.status)) return response

    const location = response.headers.get('location')
    if (!location) return response

    currentUrl = await assertPublicHttpUrl(new URL(location, currentUrl).toString())
  }

  throw new UnsafeUrlError(`Too many redirects: more than ${maxRedirects}`)
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '')
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400
}

function isBlockedIp(ip: string): boolean {
  const version = isIP(ip)
  if (version === 4) return isBlockedIpv4(ip)
  if (version === 6) return isBlockedIpv6(ip)
  return true
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true
  }

  const [a, b] = parts

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  )
}

function isBlockedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase()

  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:') ||
    normalized.startsWith('ff') ||
    normalized.startsWith('2001:db8:') ||
    normalized.startsWith('::ffff:127.') ||
    normalized.startsWith('::ffff:10.') ||
    normalized.startsWith('::ffff:192.168.') ||
    /^::ffff:172\.(1[6-9]|2\d|3[01])\./.test(normalized) ||
    normalized.startsWith('::ffff:169.254.')
  )
}
