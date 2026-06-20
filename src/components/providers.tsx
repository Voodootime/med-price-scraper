'use client'

import * as React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster as SonnerToaster } from '@/components/ui/sonner'

/**
 * Глобальные провайдеры приложения.
 *
 * - QueryClientProvider: TanStack Query (квери-ключи: ['competitors'], ['stats'], ['health'])
 * - Sonner Toaster: тосты (toast.success / toast.error)
 *
 * QueryClient создаётся один раз на клиенте через useState, чтобы не было
 * ре-инициализации при каждом рендере (важно для HMR).
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      })
  )

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <SonnerToaster richColors position="top-right" />
    </QueryClientProvider>
  )
}
