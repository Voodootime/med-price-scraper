'use client'

import * as React from 'react'
import { AlertCircle } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { DashboardHeader } from '@/components/dashboard/dashboard-header'
import { DashboardFooter } from '@/components/dashboard/dashboard-footer'
import { StatsCards } from '@/components/dashboard/stats-cards'
import { CompetitorsTable } from '@/components/dashboard/competitors-table'
import { RecentActivity } from '@/components/dashboard/recent-activity'
import { PipelineStatus } from '@/components/dashboard/pipeline-status'
import { ServicesTable } from '@/components/dashboard/services-table'
import { useHealth } from '@/components/dashboard/shared'

/**
 * Dashboard — единственная страница приложения (route `/`).
 *
 * Layout:
 *   ┌─ Header (sticky top) ───────────────────┐
 *   │  Лого + регион + "Добавить конкурента"  │
 *   ├─ Main (min-h-screen flex-1) ────────────┤
 *   │  Stats row (4 карточки)                  │
 *   │  Competitors table                       │
 *   │  Recent activity (timeline)              │
 *   ├─ Footer (sticky bottom, mt-auto) ───────┤
 *   │  Версия · env · health · /api/health    │
 *   └──────────────────────────────────────────┘
 *
 * Sticky footer обязателен по правилам проекта:
 *   root wrapper = `min-h-screen flex flex-col`, footer = `mt-auto`.
 */
export default function DashboardPage() {
  const { data: health, isError: healthError } = useHealth()
  const region = health?.region

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <DashboardHeader region={region} />

      <main className="flex flex-1 flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        {/* Глобальный алерт: если health degraded/down */}
        {health && health.status !== 'ok' && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Система в режиме degraded</AlertTitle>
            <AlertDescription>
              Один или несколько компонентов недоступны. Сбор может работать
              нестабильно. Подробности на <code>/api/health</code>.
            </AlertDescription>
          </Alert>
        )}
        {healthError && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Health endpoint недоступен</AlertTitle>
            <AlertDescription>
              Не удалось получить статус приложения. Проверьте, что сервер
              запущен и БД доступна.
            </AlertDescription>
          </Alert>
        )}

        {/* Stats row — 4 карточки */}
        <StatsCards />

        <PipelineStatus />

        {/* Основная сетка: таблица конкурентов + таймлайн активности */}
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
          <section aria-label="Конкуренты" className="min-w-0">
            <CompetitorsTable />
          </section>
          <section aria-label="Последняя активность" className="min-w-0">
            <RecentActivity />
          </section>
        </div>

        <ServicesTable />
      </main>

      <DashboardFooter />
    </div>
  )
}
