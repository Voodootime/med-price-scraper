'use client'

import * as React from 'react'
import {
  Activity,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  Loader2,
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

// ============================================================================
// TYPES — заглушка до появления /api/scrape-runs в Phase 6
// ============================================================================

type RunStatus = 'running' | 'success' | 'failed' | 'partial' | 'cancelled'

interface ScrapeRunStub {
  id: string
  competitorName: string
  status: RunStatus
  itemsExtracted: number
  durationMs: number
  startedAt: string // ISO
  region: string
}

/**
 * Заглушка с фейковыми scrape-run для демонстрации timeline.
 *
 * Реальные данные придут в Phase 6 через:
 *   GET /api/scrape-runs?limit=20 → ScrapeRun[]
 *
 * Структура: соответствуют полям Prisma-модели ScrapeRun.
 */
const STUB_RUNS: ScrapeRunStub[] = [
  {
    id: 'stub-1',
    competitorName: 'CMD Online',
    status: 'success',
    itemsExtracted: 1510,
    durationMs: 184_320,
    startedAt: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
    region: 'mo',
  },
  {
    id: 'stub-2',
    competitorName: 'Gemotest',
    status: 'partial',
    itemsExtracted: 742,
    durationMs: 96_540,
    startedAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    region: 'mo',
  },
  {
    id: 'stub-3',
    competitorName: 'Helix',
    status: 'failed',
    itemsExtracted: 0,
    durationMs: 12_400,
    startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    region: 'mo',
  },
  {
    id: 'stub-4',
    competitorName: 'Veramed',
    status: 'success',
    itemsExtracted: 318,
    durationMs: 42_100,
    startedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
    region: 'mo',
  },
  {
    id: 'stub-5',
    competitorName: 'Altamed+',
    status: 'running',
    itemsExtracted: 0,
    durationMs: 0,
    startedAt: new Date(Date.now() - 90 * 1000).toISOString(),
    region: 'mo',
  },
]

// ============================================================================
// HELPERS
// ============================================================================

const STATUS_META: Record<
  RunStatus,
  { label: string; icon: LucideIcon; className: string }
> = {
  running: {
    label: 'Выполняется',
    icon: Loader2,
    className:
      'bg-secondary text-secondary-foreground [&_svg]:animate-spin',
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
    label: 'Отменён',
    icon: Clock,
    className:
      'border-transparent bg-muted text-muted-foreground',
  },
}

function formatDuration(ms: number): string {
  if (!ms || ms < 1000) return '—'
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec} с`
  const min = Math.floor(sec / 60)
  const remSec = sec % 60
  if (min < 60) return remSec ? `${min} мин ${remSec} с` : `${min} мин`
  const h = Math.floor(min / 60)
  return `${h} ч ${min % 60} мин`
}

function formatRelative(iso: string): string {
  const d = new Date(iso)
  const diff = Date.now() - d.getTime()
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'только что'
  if (min < 60) return `${min} мин назад`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} ч назад`
  const days = Math.floor(h / 24)
  return `${days} дн назад`
}

// ============================================================================
// TIMELINE ITEM
// ============================================================================

function TimelineItem({
  run,
  isLast,
}: {
  run: ScrapeRunStub
  isLast: boolean
}) {
  const meta = STATUS_META[run.status]
  const Icon = meta.icon

  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      {/* Линия timeline */}
      {!isLast && (
        <span
          aria-hidden
          className="absolute left-[11px] top-6 h-full w-px bg-border"
        />
      )}
      {/* Иконка-точка */}
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
            title={new Date(run.startedAt).toLocaleString('ru-RU')}
          >
            {formatRelative(run.startedAt)}
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
          {run.durationMs > 0 && (
            <span>
              длит.: <span className="tabular-nums text-foreground">
                {formatDuration(run.durationMs)}
              </span>
            </span>
          )}
        </div>
      </div>
    </li>
  )
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function RecentActivity() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="size-4 text-emerald-700 dark:text-emerald-400" />
          Последние запуски
        </CardTitle>
        <CardDescription>
          Timeline scrape-run. Реальные данные появятся в Phase 6.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="space-y-0">
          {STUB_RUNS.map((run, idx) => (
            <TimelineItem
              key={run.id}
              run={run}
              isLast={idx === STUB_RUNS.length - 1}
            />
          ))}
        </ol>
      </CardContent>
    </Card>
  )
}
