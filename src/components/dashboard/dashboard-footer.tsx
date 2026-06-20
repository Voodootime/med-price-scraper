'use client'

import * as React from 'react'
import Link from 'next/link'
import { HeartPulse, Heart } from 'lucide-react'
import {
  formatRelativeDate,
  useHealth,
  type HealthResponse,
} from '@/components/dashboard/shared'

/**
 * Footer Dashboard.
 *
 * Sticky-bottom обязан по правилам проекта: родительский wrapper использует
 * `min-h-screen flex flex-col`, footer — `mt-auto`.
 *
 * Содержимое:
 * - Версия (из /api/health)
 * - Окружение (NEXT_ENV)
 * - Region
 * - Статус health (ok / degraded)
 * - Ссылка на /api/health
 */
export function DashboardFooter() {
  const { data: health, isLoading, isError } = useHealth()

  const env =
    process.env.NEXT_PUBLIC_VERCEL_ENV ??
    (process.env.NODE_ENV === 'production' ? 'production' : 'development')

  return (
    <footer
      className="mt-auto w-full border-t border-border bg-card/50 backdrop-blur supports-[backdrop-filter]:bg-card/30"
      role="contentinfo"
    >
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-2 px-4 py-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
        {/* Левая часть: бред + версия */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
            <HeartPulse className="size-3.5 text-emerald-600 dark:text-emerald-400" />
            MedPrice Tracker
          </span>
          <span className="text-muted-foreground/70">·</span>
          <span>v{health?.version ?? '0.0.0'}</span>
          <span className="text-muted-foreground/70">·</span>
          <span className="uppercase tracking-wide">{env}</span>
          {health?.region && (
            <>
              <span className="text-muted-foreground/70">·</span>
              <span>region: {health.region}</span>
            </>
          )}
        </div>

        {/* Правая часть: статус + ссылка на /api/health */}
        <div className="flex items-center gap-3">
          <HealthBadge health={health} isLoading={isLoading} isError={isError} />
          {health?.uptime != null && (
            <span
              className="hidden sm:inline"
              title="Время работы сервера с последнего рестарта"
            >
              uptime: {formatUptime(health.uptime)}
            </span>
          )}
          <Link
            href="/api/health"
            className="font-medium text-foreground underline-offset-4 hover:underline"
            prefetch={false}
          >
            /api/health
          </Link>
        </div>
      </div>
    </footer>
  )
}

function HealthBadge({
  health,
  isLoading,
  isError,
}: {
  health?: HealthResponse
  isLoading: boolean
  isError: boolean
}) {
  if (isLoading) {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <Heart className="size-3.5 animate-pulse" />
        проверка…
      </span>
    )
  }

  if (isError || !health) {
    return (
      <span className="inline-flex items-center gap-1.5 text-red-700 dark:text-red-400">
        <Heart className="size-3.5" />
        health: ошибка
      </span>
    )
  }

  const ok = health.status === 'ok'
  const cls = ok
    ? 'text-emerald-700 dark:text-emerald-400'
    : 'text-orange-700 dark:text-orange-400'

  return (
    <span className={`inline-flex items-center gap-1.5 ${cls}`} title={`Обновлено: ${formatRelativeDate(health.timestamp)}`}>
      <Heart className="size-3.5" />
      health: {health.status}
    </span>
  )
}

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}д ${h}ч`
  if (h > 0) return `${h}ч ${m}м`
  return `${m}м`
}
