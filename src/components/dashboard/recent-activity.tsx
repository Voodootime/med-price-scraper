'use client'

import * as React from 'react'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { useDashboardSummary, type DashboardScrapeRunDTO } from './dashboard-data'
import { formatFullDate, formatRelativeDate } from './shared'

type RunStatus = 'running' | 'success' | 'failed' | 'partial' | 'cancelled'

const STATUS_META: Record<
  RunStatus,
  { label: string; icon: LucideIcon; className: string }
> = {
  running: {
    label: 'Выполняется',
    icon: Loader2,
    className: 'bg-secondary text-secondary-foreground [&_svg]:animate-spin',
  },
  success: {
    label: 'Успешно',
    icon: CheckCircle2,
    className:
      'border-transparent bg-emerald-100 text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200',
  },
  partial: {
    label: 'Частично',
    icon: AlertTriangle,
    className:
      'border-transparent bg-orange-100 text-orange-900 dark:bg-orange-950/60 dark:text-orange-200',
  },
  failed: {
    label: 'Ошибка',
    icon: XCircle,
    className:
      'border-transparent bg-red-100 text-red-900 dark:bg-red-950/60 dark:text-red-200',
  },
  cancelled: {
    label: 'Отменен',
    icon: Clock,
    className: 'border-transparent bg-muted text-muted-foreground',
  },
}

function knownStatus(status: string): RunStatus {
  return status in STATUS_META ? (status as RunStatus) : 'cancelled'
}

function formatDuration(ms: number | null): string {
  if (!ms || ms < 1000) return '-'
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec} с`
  const min = Math.floor(sec / 60)
  const remSec = sec % 60
  if (min < 60) return remSec ? `${min} мин ${remSec} с` : `${min} мин`
  const h = Math.floor(min / 60)
  return `${h} ч ${min % 60} мин`
}

function TimelineSkeleton() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex gap-3">
          <Skeleton className="size-6 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-56" />
          </div>
        </div>
      ))}
    </div>
  )
}

function TimelineItem({
  run,
  isLast,
}: {
  run: DashboardScrapeRunDTO
  isLast: boolean
}) {
  const meta = STATUS_META[knownStatus(run.status)]
  const Icon = meta.icon

  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      {!isLast && (
        <span
          aria-hidden
          className="absolute left-[11px] top-6 h-full w-px bg-border"
        />
      )}
      <span
        aria-hidden
        className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full ${meta.className}`}
      >
        <Icon className="size-3.5" />
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <span className="truncate text-sm font-medium text-foreground">
            {run.competitorName}
          </span>
          <time
            className="text-xs text-muted-foreground tabular-nums"
            dateTime={run.startedAt}
            title={formatFullDate(run.startedAt)}
          >
            {formatRelativeDate(run.startedAt)}
          </time>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline" className={meta.className}>
            {meta.label}
          </Badge>
          {run.status !== 'running' && (
            <span>
              услуг: <span className="tabular-nums text-foreground">
                {run.itemsExtracted.toLocaleString('ru-RU')}
              </span>
            </span>
          )}
          {run.itemsAdded > 0 && (
            <span>
              added: <span className="tabular-nums text-foreground">
                {run.itemsAdded.toLocaleString('ru-RU')}
              </span>
            </span>
          )}
          {run.itemsChanged > 0 && (
            <span>
              changed: <span className="tabular-nums text-foreground">
                {run.itemsChanged.toLocaleString('ru-RU')}
              </span>
            </span>
          )}
          {run.urlsFailed > 0 && (
            <span>
              failed URLs: <span className="tabular-nums text-foreground">
                {run.urlsFailed.toLocaleString('ru-RU')}
              </span>
            </span>
          )}
          {run.durationMs && run.durationMs > 0 && (
            <span>
              длит.: <span className="tabular-nums text-foreground">
                {formatDuration(run.durationMs)}
              </span>
            </span>
          )}
        </div>
        {run.errorMessage && (
          <p className="line-clamp-2 text-xs text-destructive">
            {run.errorMessage}
          </p>
        )}
      </div>
    </li>
  )
}

export function RecentActivity() {
  const { data, isLoading, isError } = useDashboardSummary()
  const runs = data?.latestRuns ?? []

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="size-4 text-emerald-700 dark:text-emerald-400" />
          Последние запуски
        </CardTitle>
        <CardDescription>
          Реальные scrape-run из базы данных.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <TimelineSkeleton />
        ) : isError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            Не удалось загрузить scrape-run.
          </div>
        ) : runs.length === 0 ? (
          <div className="rounded-md border px-4 py-6 text-sm text-muted-foreground">
            Scrape-run пока нет. Запустите Probe, затем Scrape now для конкурента.
          </div>
        ) : (
          <ol className="space-y-0">
            {runs.map((run, idx) => (
              <TimelineItem
                key={run.id}
                run={run}
                isLast={idx === runs.length - 1}
              />
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  )
}
