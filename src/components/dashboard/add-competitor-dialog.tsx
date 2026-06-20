'use client'

import * as React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

interface AddCompetitorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface AddCompetitorPayload {
  name: string
  baseUrl: string
}

interface AddCompetitorResponse {
  competitor?: {
    id: string
    name: string
    baseUrl: string
    status: string
  }
  error?: string
  details?: string
}

/**
 * Диалог "Добавить конкурента".
 *
 * Форма с двумя полями:
 *  - name — название (напр. "CMD Online")
 *  - baseUrl — базовый URL (https://...)
 *
 * После успеха:
 *  - POST /api/competitors (mutation)
 *  - invalidate query ['competitors']
 *  - toast.success
 *  - закрытие диалога и сброс формы
 *
 * Status=201 — успешно (создан, probe будет запущен отдельно в Phase 1).
 * Status=409 — дубликат URL (показать Alert).
 * Status=400 — невалидные данные.
 */
export function AddCompetitorDialog({
  open,
  onOpenChange,
}: AddCompetitorDialogProps) {
  const queryClient = useQueryClient()
  const [name, setName] = React.useState('')
  const [baseUrl, setBaseUrl] = React.useState('')
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null)

  // Сброс формы при закрытии
  React.useEffect(() => {
    if (!open) {
      // даём диалогу закрыться, потом чистим
      const t = setTimeout(() => {
        setName('')
        setBaseUrl('')
        setErrorMsg(null)
      }, 150)
      return () => clearTimeout(t)
    }
    setErrorMsg(null)
  }, [open])

  const mutation = useMutation({
    mutationFn: async (payload: AddCompetitorPayload) => {
      const res = await fetch('/api/competitors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = (await res.json()) as AddCompetitorResponse
      if (!res.ok) {
        const err = new Error(json.error ?? 'Failed to create competitor') as Error & {
          status?: number
          details?: string
        }
        err.status = res.status
        err.details = json.details
        throw err
      }
      return json
    },
    onSuccess: (data) => {
      toast.success('Конкурент добавлен', {
        description: data.competitor?.name
          ? `${data.competitor.name} — probe будет запущен автоматически.`
          : 'Запись создана. Probe будет запущен автоматически.',
      })
      void queryClient.invalidateQueries({ queryKey: ['competitors'] })
      onOpenChange(false)
    },
    onError: (err: Error & { status?: number; details?: string }) => {
      const msg =
        err.status === 409
          ? 'Конкурент с таким URL уже существует в базе.'
          : err.status === 400
            ? 'Некорректные данные. Проверьте название и URL.'
            : err.message ?? 'Не удалось добавить конкурента'
      setErrorMsg(msg)
      toast.error('Не удалось добавить конкурента', { description: msg })
    },
  })

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setErrorMsg(null)

    const trimmedName = name.trim()
    const trimmedUrl = baseUrl.trim()
    if (!trimmedName || !trimmedUrl) {
      setErrorMsg('Заполните все поля.')
      return
    }

    // Нормализуем URL: добавляем https:// если нет схемы
    const normalizedUrl = /^https?:\/\//i.test(trimmedUrl)
      ? trimmedUrl
      : `https://${trimmedUrl}`

    try {
      // validate
      new URL(normalizedUrl)
    } catch {
      setErrorMsg('Некорректный URL. Пример: https://example.ru')
      return
    }

    mutation.mutate({ name: trimmedName, baseUrl: normalizedUrl })
  }

  const isPending = mutation.isPending

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Добавить конкурента</DialogTitle>
          <DialogDescription>
            Укажите название сайта и базовый URL. После создания будет
            запущен Probe Engine для автоопределения тира и стратегии сбора.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="grid gap-4">
          {errorMsg && (
            <Alert variant="destructive">
              <AlertTitle>Ошибка</AlertTitle>
              <AlertDescription>{errorMsg}</AlertDescription>
            </Alert>
          )}

          <div className="grid gap-2">
            <Label htmlFor="competitor-name">Название</Label>
            <Input
              id="competitor-name"
              placeholder="Например: CMD Online"
              autoComplete="off"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isPending}
              autoFocus
              required
            />
            <p className="text-xs text-muted-foreground">
              Человеко-читаемое имя для таблицы и логов.
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="competitor-url">Базовый URL</Label>
            <Input
              id="competitor-url"
              placeholder="https://example.ru"
              autoComplete="off"
              inputMode="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              disabled={isPending}
              required
            />
            <p className="text-xs text-muted-foreground">
              Корень сайта. Схема https:// добавляется автоматически.
            </p>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              Отмена
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending && <Loader2 className="size-4 animate-spin" />}
              {isPending ? 'Создание…' : 'Добавить'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
