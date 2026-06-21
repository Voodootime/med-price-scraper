'use client'

import { useQuery } from '@tanstack/react-query'

export type PipelinePhaseStatus = 'ok' | 'running' | 'warning' | 'failed' | 'idle'

export interface PipelinePhaseDTO {
  id: string
  label: string
  status: PipelinePhaseStatus
  value: number
  description: string
  updatedAt: string | null
}

export interface DashboardSummaryStats {
  competitors: number
  services: number
  scrapesToday: number
  activeAlerts: number
}

export interface DashboardScrapeRunDTO {
  id: string
  competitorId: string
  competitorName: string
  baseUrl: string
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  status: 'running' | 'success' | 'failed' | 'partial' | 'cancelled' | string
  urlsPlanned: number
  urlsFetched: number
  urlsSucceeded: number
  urlsFailed: number
  itemsExtracted: number
  itemsChanged: number
  itemsAdded: number
  itemsRemoved: number
  errorMessage: string | null
  region: string
}

export interface DashboardProbeDTO {
  id: string
  competitorId: string
  competitorName: string
  baseUrl: string
  competitorStatus: string
  probedAt: string
  tier: string | null
  framework: string | null
  regionStrategy: string | null
  confidenceScore: number
  sitemapUrlsCount: number
  priceUrlsCount: number
}

export interface DashboardAlertDTO {
  id: string
  competitorId: string
  competitorName: string
  scrapeRunId: string | null
  scrapeRunStatus: string | null
  createdAt: string
  severity: 'info' | 'warning' | 'critical' | string
  type: string
  message: string
  acknowledged: boolean
}

export interface DashboardSummaryResponse {
  generatedAt: string
  region: string
  stats: DashboardSummaryStats
  pipeline: PipelinePhaseDTO[]
  latestRuns: DashboardScrapeRunDTO[]
  latestProbes: DashboardProbeDTO[]
  recentAlerts: DashboardAlertDTO[]
}

export function useDashboardSummary() {
  return useQuery<DashboardSummaryResponse>({
    queryKey: ['dashboard-summary'],
    queryFn: async () => {
      const res = await fetch('/api/dashboard/summary')
      if (!res.ok) {
        throw new Error(`Failed to fetch dashboard summary: ${res.status}`)
      }
      return (await res.json()) as DashboardSummaryResponse
    },
    refetchInterval: 20_000,
    staleTime: 10_000,
  })
}
