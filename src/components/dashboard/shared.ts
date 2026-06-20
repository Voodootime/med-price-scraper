/**
 * Общие утилиты и хуки для dashboard.
 *
 * - Региональные метки (TARGET_REGION → человеко-читаемое название)
 * - Хук useHealth: статус приложения для footer
 * - Форматирование дат
 */

import { useQuery } from '@tanstack/react-query'

// ============================================================================
// REGION LABELS — отображение TARGET_REGION в человеко-читаемом виде
// (см. методологию раздел 0.3)
// ============================================================================

export const REGION_LABELS: Record<string, string> = {
  moscow: 'Москва',
  mo: 'Московская область',
  spb: 'Санкт-Петербург',
}

export function regionLabel(region: string | undefined | null): string {
  if (!region) return 'Не задан'
  return REGION_LABELS[region] ?? region.toUpperCase()
}

// ============================================================================
// STATUS LABELS & COLORS — для Badge компонента
// ============================================================================

export type CompetitorStatus =
  | 'new'
  | 'probing'
  | 'active'
  | 'needs_review'
  | 'blocked'
  | 'deprecated'

export const STATUS_LABELS: Record<CompetitorStatus, string> = {
  new: 'Новый',
  probing: 'Анализ',
  active: 'Активен',
  needs_review: 'На проверке',
  blocked: 'Заблокирован',
  deprecated: 'Устарел',
}

/**
 * Tailwind-классы для badge по статусу (использует emerald/amber/orange/red —
 * НЕ indigo/blue, согласно правилам проекта).
 */
export const STATUS_BADGE_CLASSES: Record<CompetitorStatus, string> = {
  new: 'border-transparent bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200',
  probing:
    'border-transparent bg-secondary text-secondary-foreground',
  active:
    'border-transparent bg-emerald-100 text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200',
  needs_review:
    'border-transparent bg-orange-100 text-orange-900 dark:bg-orange-950/60 dark:text-orange-200',
  blocked:
    'border-transparent bg-red-100 text-red-900 dark:bg-red-950/60 dark:text-red-200',
  deprecated:
    'border-transparent bg-muted text-muted-foreground',
}

// ============================================================================
// TIER LABELS — короткие подписи тиров (см. методологию раздел 1)
// ============================================================================

export const TIER_LABELS_SHORT: Record<string, string> = {
  T1: 'T1 · Static',
  T1_schema_org: 'T1 · Schema.org',
  T2: 'T2 · SSR+JSON',
  T3: 'T3 · SPA+API',
  T4: 'T4 · SPA',
  T5: 'T5 · Lazy',
  T6: 'T6 · Antibot',
  T7: 'T7 · Heavy',
  T8: 'T8 · VLM',
  T9: 'T9 · Files',
  T10: 'T10 · Bots',
}

// ============================================================================
// FORMATTING
// ============================================================================

/**
 * Форматирование даты (relative + absolute tooltip).
 * Если дата null/undefined — возвращает placeholder.
 */
export function formatRelativeDate(date: Date | string | null | undefined): string {
  if (!date) return '—'
  const d = typeof date === 'string' ? new Date(date) : date
  if (Number.isNaN(d.getTime())) return '—'

  const now = Date.now()
  const diffMs = now - d.getTime()
  const sec = Math.floor(diffMs / 1000)
  const min = Math.floor(sec / 60)
  const hour = Math.floor(min / 60)
  const day = Math.floor(hour / 24)

  if (sec < 60) return 'только что'
  if (min < 60) return `${min} мин назад`
  if (hour < 24) return `${hour} ч назад`
  if (day < 30) return `${day} дн назад`
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

export function formatFullDate(date: Date | string | null | undefined): string {
  if (!date) return '—'
  const d = typeof date === 'string' ? new Date(date) : date
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * Сокращение длинного URL для таблицы.
 */
export function shortenUrl(url: string, maxLen = 40): string {
  if (url.length <= maxLen) return url
  try {
    const u = new URL(url)
    const host = u.host
    const path = u.pathname.length > 1 ? u.pathname : ''
    const tail = path.length > 15 ? path.slice(0, 13) + '…' : path
    return host + tail
  } catch {
    return url.slice(0, maxLen - 1) + '…'
  }
}

// ============================================================================
// HEALTH QUERY — для footer'а
// ============================================================================

export interface HealthCheck {
  name: string
  status: 'ok' | 'fail'
  latencyMs?: number
  details?: string
}

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'down'
  timestamp: string
  uptime: number
  version: string
  region: string
  checks: HealthCheck[]
}

/**
 * Хук статуса приложения. Refetch каждые 60 секунд (для footer).
 */
export function useHealth() {
  return useQuery<HealthResponse>({
    queryKey: ['health'],
    queryFn: async () => {
      const res = await fetch('/api/health')
      if (!res.ok) {
        throw new Error(`Health check failed: ${res.status}`)
      }
      return (await res.json()) as HealthResponse
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
}
