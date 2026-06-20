'use client'

import * as React from 'react'
import { Activity, MapPin, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { AddCompetitorDialog } from '@/components/dashboard/add-competitor-dialog'
import { regionLabel } from '@/components/dashboard/shared'

/**
 * Sticky-шапка Dashboard.
 *
 * - Лого "MedPrice Tracker"
 * - Индикатор scope: "Регион: Московская область" (TARGET_REGION из /api/health)
 * - Кнопка "Добавить конкурента" (открывает AddCompetitorDialog)
 *
 * Sticky реализован через `sticky top-0 z-40` (semantic <header>).
 * Цвета: bg-background/95 backdrop-blur для лёгкой прозрачности при скролле.
 */
export function DashboardHeader({
  region,
}: {
  region?: string
}) {
  const [open, setOpen] = React.useState(false)

  return (
    <header className="sticky top-0 z-40 w-full border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
        {/* Лого + название */}
        <div className="flex items-center gap-3">
          <div
            aria-hidden
            className="flex size-9 items-center justify-center rounded-lg bg-emerald-100 text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200"
          >
            <Activity className="size-5" />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-base font-semibold tracking-tight sm:text-lg">
              MedPrice Tracker
            </span>
            <span className="hidden text-xs text-muted-foreground sm:block">
              Универсальный скрапер медицинских прайсов
            </span>
          </div>
        </div>

        {/* Правый блок: регион + кнопка */}
        <div className="flex items-center gap-2 sm:gap-3">
          <Badge
            variant="outline"
            className="gap-1.5 px-2.5 py-1 text-xs font-normal"
            title={`Целевой регион сбора (TARGET_REGION=${region ?? '—'})`}
          >
            <MapPin className="size-3.5 text-emerald-700 dark:text-emerald-400" />
            <span className="text-muted-foreground">Регион:</span>
            <span className="font-medium text-foreground">
              {regionLabel(region)}
            </span>
          </Badge>

          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus className="size-4" />
            <span className="hidden sm:inline">Добавить конкурента</span>
            <span className="sm:hidden">Добавить</span>
          </Button>
        </div>
      </div>

      <AddCompetitorDialog open={open} onOpenChange={setOpen} />
    </header>
  )
}
