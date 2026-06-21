'use client'

import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Database, SearchX } from 'lucide-react'
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
import { formatFullDate, formatRelativeDate } from './shared'

interface ServiceDTO {
  id: string
  competitorName: string
  externalId: string
  code: string | null
  name: string
  nameRaw: string
  category: string | null
  url: string
  lastSeenAt: string
  latestPrice: number | null
  latestCurrency: string | null
  latestScrapedAt: string | null
  latestRegion: string | null
}

interface ServicesResponse {
  services: ServiceDTO[]
  total: number
}

function formatKopecks(value: number | null, currency: string | null): string {
  if (value === null) return '-'
  const rubles = value / 100
  const symbol = currency === 'RUB' || !currency ? '₽' : currency
  return `${rubles.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ${symbol}`
}

function LoadingRows() {
  return (
    <>
      {Array.from({ length: 5 }).map((_, index) => (
        <TableRow key={index}>
          <TableCell><Skeleton className="h-4 w-28" /></TableCell>
          <TableCell><Skeleton className="h-4 w-60" /></TableCell>
          <TableCell><Skeleton className="h-5 w-20 rounded-full" /></TableCell>
          <TableCell><Skeleton className="h-4 w-20" /></TableCell>
          <TableCell><Skeleton className="h-4 w-24" /></TableCell>
        </TableRow>
      ))}
    </>
  )
}

export function ServicesTable() {
  const { data, isLoading, isError } = useQuery<ServicesResponse>({
    queryKey: ['services'],
    queryFn: async () => {
      const res = await fetch('/api/services?limit=100')
      if (!res.ok) throw new Error(`Failed to fetch services: ${res.status}`)
      return (await res.json()) as ServicesResponse
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  })

  const services = data?.services ?? []

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <Database className="size-4 text-emerald-700 dark:text-emerald-400" />
              Таблица услуг и цен
            </CardTitle>
            <CardDescription>
              Нормализованные данные последнего scrape.
            </CardDescription>
          </div>
          <Badge variant="outline">{data?.total ?? 0}</Badge>
        </div>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {isError ? (
          <div className="px-6 pb-6 text-sm text-destructive">
            Не удалось загрузить услуги.
          </div>
        ) : !isLoading && services.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center text-sm text-muted-foreground">
            <SearchX className="size-8" />
            Данных пока нет. Добавьте сайт и запустите Scrape now.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Конкурент</TableHead>
                <TableHead>Услуга</TableHead>
                <TableHead>Категория</TableHead>
                <TableHead className="text-right">Цена</TableHead>
                <TableHead className="pr-6">Последний сбор</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <LoadingRows />
              ) : (
                services.map((service) => (
                  <TableRow key={service.id}>
                    <TableCell className="pl-6 font-medium">
                      {service.competitorName}
                    </TableCell>
                    <TableCell>
                      <a
                        href={service.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="line-clamp-2 max-w-[32rem] underline-offset-2 hover:underline"
                        title={service.nameRaw}
                      >
                        {service.nameRaw}
                      </a>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {service.code ?? service.externalId}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{service.category ?? '-'}</Badge>
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatKopecks(service.latestPrice, service.latestCurrency)}
                    </TableCell>
                    <TableCell
                      className="pr-6 text-muted-foreground"
                      title={formatFullDate(service.latestScrapedAt ?? service.lastSeenAt)}
                    >
                      {formatRelativeDate(service.latestScrapedAt ?? service.lastSeenAt)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
