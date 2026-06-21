'use client'

import * as React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, ExternalLink, Inbox, Play, Search } from 'lucide-react'
import { toast } from 'sonner'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert'
import {
  useCompetitors,
  type CompetitorDTO,
} from '@/components/dashboard/stats-cards'
import {
  STATUS_BADGE_CLASSES,
  STATUS_LABELS,
  TIER_LABELS_SHORT,
  type CompetitorStatus,
  formatRelativeDate,
  shortenUrl,
} from '@/components/dashboard/shared'

// ============================================================================
// HELPERS
// ============================================================================

function StatusBadge({ status }: { status: string }) {
  const s = (status in STATUS_LABELS ? status : 'new') as CompetitorStatus
  return (
    <Badge
      variant="outline"
      className={STATUS_BADGE_CLASSES[s]}
      title={`status: ${s}`}
    >
      {STATUS_LABELS[s]}
    </Badge>
  )
}

function TierBadge({ tier }: { tier: string | null | undefined }) {
  if (!tier) {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        не определён
      </Badge>
    )
  }
  const label = TIER_LABELS_SHORT[tier] ?? tier
  return (
    <Badge
      variant="outline"
      className="border-border bg-secondary text-secondary-foreground"
      title={`tier: ${tier}`}
    >
      {label}
    </Badge>
  )
}

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(json.error ?? json.details ?? `Request failed: ${res.status}`)
  }
  return json
}

// ============================================================================
// TABLE ROW
// ============================================================================

function CompetitorRow({ competitor }: { competitor: CompetitorDTO }) {
  const queryClient = useQueryClient()

  const refreshDashboard = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['competitors'] })
    void queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] })
    void queryClient.invalidateQueries({ queryKey: ['stats'] })
    void queryClient.invalidateQueries({ queryKey: ['scrape-runs'] })
    void queryClient.invalidateQueries({ queryKey: ['services'] })
    void queryClient.invalidateQueries({ queryKey: ['prices'] })
  }, [queryClient])

  const probeMutation = useMutation({
    mutationFn: () => postJson('/api/probe', { competitorId: competitor.id }),
    onSuccess: () => {
      toast.success(`Probe completed: ${competitor.name}`)
      refreshDashboard()
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Probe failed')
    },
  })

  const scrapeMutation = useMutation({
    mutationFn: () => postJson('/api/scrape-runs', { competitorId: competitor.id, maxUrls: 25 }),
    onSuccess: () => {
      toast.success(`Scrape completed: ${competitor.name}`)
      refreshDashboard()
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Scrape failed')
    },
  })

  const isBusy = probeMutation.isPending || scrapeMutation.isPending

  return (
    <TableRow>
      <TableCell className="font-medium text-foreground">
        {competitor.name}
      </TableCell>
      <TableCell>
        <a
          href={competitor.baseUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          title={competitor.baseUrl}
        >
          <span className="max-w-[18rem] truncate sm:max-w-[24rem]">
            {shortenUrl(competitor.baseUrl)}
          </span>
          <ExternalLink className="size-3.5 shrink-0" />
        </a>
      </TableCell>
      <TableCell>
        <StatusBadge status={competitor.status} />
      </TableCell>
      <TableCell>
        <TierBadge tier={competitor.tier} />
      </TableCell>
      <TableCell className="tabular-nums">
        {competitor.itemsCount.toLocaleString('ru-RU')}
      </TableCell>
      <TableCell
        className="tabular-nums text-muted-foreground"
        title={competitor.lastScrapeAt ?? 'нет данных'}
      >
        {formatRelativeDate(competitor.lastScrapeAt)}
      </TableCell>
      <TableCell className="pr-6">
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            size="icon"
            title="Probe"
            disabled={isBusy}
            onClick={() => probeMutation.mutate()}
          >
            <Search className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            title="Scrape now"
            disabled={isBusy}
            onClick={() => scrapeMutation.mutate()}
          >
            <Play className="size-4" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  )
}

// ============================================================================
// LOADING SKELETON
// ============================================================================

function LoadingRows({ rows = 5 }: { rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <TableRow key={`skeleton-${i}`}>
          <TableCell>
            <Skeleton className="h-4 w-32" />
          </TableCell>
          <TableCell>
            <Skeleton className="h-4 w-40" />
          </TableCell>
          <TableCell>
            <Skeleton className="h-5 w-20 rounded-full" />
          </TableCell>
          <TableCell>
            <Skeleton className="h-5 w-24 rounded-full" />
          </TableCell>
          <TableCell>
            <Skeleton className="h-4 w-10" />
          </TableCell>
          <TableCell>
            <Skeleton className="h-4 w-20" />
          </TableCell>
          <TableCell>
            <Skeleton className="h-8 w-20" />
          </TableCell>
        </TableRow>
      ))}
    </>
  )
}

// ============================================================================
// EMPTY STATE
// ============================================================================

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <div
        aria-hidden
        className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground"
      >
        <Inbox className="size-6" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">
          Нет конкурентов
        </p>
        <p className="text-xs text-muted-foreground">
          Добавьте первого, чтобы запустить Probe Engine.
        </p>
      </div>
    </div>
  )
}

// ============================================================================
// ERROR STATE
// ============================================================================

function ErrorState({ message }: { message: string }) {
  return (
    <div className="px-6 pb-6">
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>Не удалось загрузить список</AlertTitle>
        <AlertDescription>
          {message}. Проверьте <code className="font-mono">/api/health</code> и
          подключение к БД.
        </AlertDescription>
      </Alert>
    </div>
  )
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function CompetitorsTable() {
  const { data, isLoading, isError, error, refetch, isFetching } =
    useCompetitors()

  const competitors = data?.competitors ?? []
  const isEmpty = !isLoading && !isError && competitors.length === 0

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="text-base">Конкуренты</CardTitle>
            <CardDescription>
              {data
                ? `Всего: ${data.total} · регион: ${data.region}`
                : 'Загрузка…'}
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            {isFetching ? 'Обновление…' : 'Обновить'}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="px-0 pb-0">
        {isError ? (
          <ErrorState message={error?.message ?? 'Ошибка запроса'} />
        ) : isEmpty ? (
          <EmptyState />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Название</TableHead>
                <TableHead>URL</TableHead>
                <TableHead>Статус</TableHead>
                <TableHead>Tier</TableHead>
                <TableHead className="text-right">Услуг</TableHead>
                <TableHead className="pr-6">Последний сбор</TableHead>
                <TableHead className="pr-6 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <LoadingRows />
              ) : (
                competitors.map((c) => (
                  <CompetitorRow key={c.id} competitor={c} />
                ))
              )}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
