import { useEffect, useState } from 'react'
import { useWorkspace } from '../workspaceContext'
import type { TodayFacts } from './todayPlan'

const REFRESH_MS = 5 * 60_000

function safeToday(value: unknown): TodayFacts | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Partial<TodayFacts>
  if (
    typeof row.date !== 'string' ||
    !row.yesterday ||
    typeof row.yesterday !== 'object' ||
    !row.today ||
    typeof row.today !== 'object'
  )
    return null
  const rawHints = row.hints && typeof row.hints === 'object' ? row.hints : null
  const hints = rawHints
    ? {
        ...rawHints,
        pulse: Array.isArray(rawHints.pulse)
          ? rawHints.pulse.filter((item) => typeof item === 'string')
          : [],
        needs_you: Array.isArray(rawHints.needs_you)
          ? rawHints.needs_you.filter((item) => typeof item === 'string')
          : [],
        metrics: Array.isArray(rawHints.metrics)
          ? rawHints.metrics.filter((item) => typeof item === 'string')
          : [],
        units: Array.isArray(rawHints.units)
          ? rawHints.units.filter((item) => typeof item === 'string')
          : [],
      }
    : null
  const forecast =
    row.forecast &&
    typeof row.forecast === 'object' &&
    typeof row.forecast.item === 'string' &&
    typeof row.forecast.quantity === 'number'
      ? row.forecast
      : null
  return {
    ...row,
    hints,
    forecast,
    low_stock: Array.isArray(row.low_stock)
      ? row.low_stock.filter(
          (item) => item && typeof item.name === 'string' && typeof item.stock === 'number',
        )
      : [],
  } as TodayFacts
}

/**
 * Server facts for the Today view (pulse, forecast, low stock, coach line). Reloads when the
 * shop changes (a saved edit, a sold-out switch, a confirmed menu) and every few minutes.
 * Null while loading or when the facts are unavailable: Today then shows what the app knows.
 */
export function useToday(): TodayFacts | null {
  const { api, active, products } = useWorkspace()
  const [facts, setFacts] = useState<{ id: string; value: TodayFacts } | null>(null)
  const id = active?.id
  const revision = active?.revision
  const confirmed = active?.last_confirmed
  const stock = products.map((p) => `${p.stock}:${p.available}`).join()
  useEffect(() => {
    if (!id) return
    const controller = new AbortController()
    const load = () =>
      void api<TodayFacts>(`/businesses/${encodeURIComponent(id)}/today`, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]),
      })
        .then((value) => {
          if (!controller.signal.aborted) {
            const safe = safeToday(value)
            if (safe) setFacts({ id, value: safe })
            else setFacts(null)
          }
        })
        .catch(() => undefined)
    load()
    const timer = window.setInterval(load, REFRESH_MS)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [api, id, revision, confirmed, stock])
  return facts && facts.id === id ? facts.value : null
}
