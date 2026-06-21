'use client'

import * as React from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  RadioTower,
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
import { useDashboardSummary, type PipelinePhaseStatus } from './dashboard-data'
import { formatFullDate, formatRelativeDate } from './shared'

const STATUS_META: Record<
  PipelinePhaseStatus,
  { label: string; icon: LucideIcon; className: string }
> = {
  ok: {
    label: 'OK',
    icon: CheckCircle2,
    className:
      'border-transparent bg-emerald-100 text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200',
  },
  running: {
    label: 'Running',
    icon: Loader2,
    className: 'border-transparent bg-secondary text-secondary-foreground [&_svg]:animate-spin',
  },
  warning: {
    label: 'Review',
    icon: AlertTriangle,
    className:
      'border-transparent bg-orange-100 text-orange-900 dark:bg-orange-950/60 dark:text-orange-200',
  },
  failed: {
    label: 'Failed',
    icon: XCircle,
    className:
      'border-transparent bg-red-100 text-red-900 dark:bg-red-950/60 dark:text-red-200',
  },
  idle: {
    label: 'Idle',
    icon: Clock,
    className: 'border-transparent bg-muted text-muted-foreground',
  },
}

function PipelineSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="rounded-md border p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="space-y-2">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-7 w-16" />
            </div>
            <Skeleton className="size-8 rounded-full" />
          </div>
          <Skeleton className="mt-4 h-4 w-full" />
        </div>
      ))}
    </div>
  )
}

export function PipelineStatus() {
  const { data, isLoading, isError } = useDashboardSummary()
  const phases = data?.pipeline ?? []

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <RadioTower className="size-4 text-emerald-700 dark:text-emerald-400" />
              Pipeline status
            </CardTitle>
            <CardDescription>
              Probe, discovery и scrape-run по текущей базе данных.
            </CardDescription>
          </div>
          {data && (
            <time
              className="text-xs text-muted-foreground"
              dateTime={data.generatedAt}
              title={formatFullDate(data.generatedAt)}
            >
              {formatRelativeDate(data.generatedAt)}
            </time>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <PipelineSkeleton />
        ) : isError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            Не удалось загрузить dashboard summary.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {phases.map((phase) => {
              const meta = STATUS_META[phase.status]
              const Icon = meta.icon
              return (
                <div key={phase.id} className="rounded-md border p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <p className="truncate text-sm font-medium text-foreground">
                        {phase.label}
                      </p>
                      <p className="text-2xl font-semibold tabular-nums">
                        {phase.value.toLocaleString('ru-RU')}
                      </p>
                    </div>
                    <Badge variant="outline" className={meta.className}>
                      <Icon className="size-3.5" />
                      {meta.label}
                    </Badge>
                  </div>
                  <p className="mt-3 min-h-8 text-xs text-muted-foreground">
                    {phase.description}
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {phase.updatedAt ? formatRelativeDate(phase.updatedAt) : 'нет данных'}
                  </p>
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
