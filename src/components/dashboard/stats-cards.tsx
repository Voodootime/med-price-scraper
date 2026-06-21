'use client'

import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  Bell,
  Database,
  Users,
  type LucideIcon,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useDashboardSummary } from './dashboard-data'

// ============================================================================
// TYPES
// ============================================================================

export interface CompetitorDTO {
  id: string
  name: string
  baseUrl: string
  status: string
  tier: string | null
  regionStrategy: string | null
  lastProbeAt: string | null
  lastScrapeAt: string | null
  itemsCount: number
  confidenceScore: number | null
  createdAt: string
}

export interface CompetitorsResponse {
  competitors: CompetitorDTO[]
  total: number
  region: string
}

export interface DashboardStats {
  competitors: number
  services: number
  scrapesToday: number
  alerts: number
}

// ============================================================================
// QUERIES
// ============================================================================

/**
 * Список конкурентов (polling каждые 30 секунд).
 * Квери-ключ: ['competitors'] — шарится с CompetitorsTable и StatsCards.
 */
export function useCompetitors() {
  return useQuery<CompetitorsResponse>({
    queryKey: ['competitors'],
    queryFn: async () => {
      const res = await fetch('/api/competitors')
      if (!res.ok) {
        throw new Error(`Failed to fetch competitors: ${res.status}`)
      }
      return (await res.json()) as CompetitorsResponse
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  })
}

/**
 * Дашборд-статистика.
 *
 * Пока реального /api/stats endpoint нет (Phase 6), метрики вычисляются
 * на клиенте из competitors: competitors = total, services = Σ itemsCount.
 * scrapesToday и alerts — заглушки (0). Когда появится /api/stats, заменить
 * квери-функцию.
 */
export function useStats() {
  const { data, isLoading, isError } = useDashboardSummary()

  const stats: DashboardStats = React.useMemo(() => {
    return {
      competitors: data?.stats.competitors ?? 0,
      services: data?.stats.services ?? 0,
      scrapesToday: data?.stats.scrapesToday ?? 0,
      alerts: data?.stats.activeAlerts ?? 0,
    }
  }, [data])

  return {
    data: stats,
    isLoading,
    isError,
  }
}

// ============================================================================
// STAT CARD
// ============================================================================

interface StatCardProps {
  title: string
  value: number
  description: string
  icon: LucideIcon
  accentClass: string
  isLoading?: boolean
}

function StatCard({
  title,
  value,
  description,
  icon: Icon,
  accentClass,
  isLoading,
}: StatCardProps) {
  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-1">
            <CardDescription className="text-xs uppercase tracking-wide">
              {title}
            </CardDescription>
            {isLoading ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <CardTitle className="text-2xl font-semibold tabular-nums sm:text-3xl">
                {value.toLocaleString('ru-RU')}
              </CardTitle>
            )}
          </div>
          <div
            aria-hidden
            className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${accentClass}`}
          >
            <Icon className="size-5" />
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <p className="text-xs text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  )
}

// ============================================================================
// STATS CARDS
// ============================================================================

export function StatsCards() {
  const { data, isLoading } = useStats()

  return (
    <section
      aria-label="Статистика"
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
    >
      <StatCard
        title="Конкуренты"
        value={data.competitors}
        description="Сайтов-источников в базе"
        icon={Users}
        accentClass="bg-emerald-100 text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200"
        isLoading={isLoading}
      />
      <StatCard
        title="Услуги"
        value={data.services}
        description="Нормализованных записей"
        icon={Database}
        accentClass="bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200"
        isLoading={isLoading}
      />
      <StatCard
        title="Сборов сегодня"
        value={data.scrapesToday}
        description="Завершённых scrape-run за сутки"
        icon={Activity}
        accentClass="bg-orange-100 text-orange-900 dark:bg-orange-950/60 dark:text-orange-200"
        isLoading={isLoading}
      />
      <StatCard
        title="Alerts"
        value={data.alerts}
        description="Неподтверждённых уведомлений"
        icon={Bell}
        accentClass="bg-red-100 text-red-900 dark:bg-red-950/60 dark:text-red-200"
        isLoading={isLoading}
      />
    </section>
  )
}
