import { useCallback, useEffect, useState } from 'react'
import { ApiError, type Proposal } from '../v1/api'
import { useWorkspace } from '../v1/workspaceContext'
import { useSupplyCopy } from './copy'
import type { PurchaseOrder, Relationship, RuleSet } from './types'

interface SupplyOverview {
  suppliers: Relationship[]
  orders: PurchaseOrder[]
  needs?: { item: string; runs_out: string; stock: number }[]
}

/** The shop's supplier relationships and purchase orders (newest first). */
export function useSupply(open: boolean) {
  const { api, activeId, active } = useWorkspace()
  const [loaded, setLoaded] = useState<{ id: string; data: SupplyOverview } | null>(null)
  const refresh = useCallback(async () => {
    if (!activeId) return
    try {
      const data = await api<SupplyOverview>(`/businesses/${encodeURIComponent(activeId)}/supply`)
      setLoaded({ id: activeId, data })
    } catch {
      // Keep what is shown; the next refresh tries again.
    }
  }, [api, activeId])
  useEffect(() => {
    if (!open) return
    // Async on purpose: the list arrives after this effect, never synchronously inside it.
    const first = window.setTimeout(() => void refresh(), 0)
    return () => window.clearTimeout(first)
  }, [open, refresh, active?.revision])
  return { data: loaded?.id === activeId ? loaded.data : null, refresh }
}

export type SimVariant = 'full' | 'partial' | 'substitute' | 'match' | 'price_mismatch'

/**
 * Every owner action on a purchase order. Each returns the updated order (or null after a
 * visible error); a stale version reloads the latest so the card never shows an old state.
 */
export function usePoActions(onChange: (order: PurchaseOrder) => void) {
  const { api, activeId, notify, review } = useWorkspace()
  const s = useSupplyCopy()
  const base = `/businesses/${encodeURIComponent(activeId ?? '')}/supply`
  const explain = useCallback(
    (cause: unknown): string => {
      const detail = cause instanceof ApiError ? cause.code : ''
      if (detail === 'RULES_BROKEN') return s.rulesBroken
      if (detail === 'RESOLVE_FLAGS') return s.resolveFirst
      if (detail === 'RECEIVE_FIRST') return s.receiveFirst
      if (detail === 'UNREADABLE_DOCUMENT') return s.unreadable
      if (detail.startsWith('EXPECTED_'))
        return s.expected(s.step[detail.slice(9) as keyof typeof s.step] ?? detail.slice(9))
      if (detail === 'STALE') return s.stale
      return s.failed
    },
    [s],
  )
  const run = useCallback(
    async (order: PurchaseOrder, path: string, body: Record<string, unknown> = {}) => {
      try {
        const result = await api<PurchaseOrder | { order: PurchaseOrder; proposal: Proposal }>(
          `${base}/orders/${encodeURIComponent(order.id)}/${path}`,
          { method: 'POST', body: JSON.stringify({ version: order.version, ...body }) },
        )
        const next = 'order' in result ? result.order : result
        onChange(next)
        if ('proposal' in result && result.proposal) review(result.proposal)
        return next
      } catch (cause) {
        notify(explain(cause))
        if (cause instanceof ApiError && cause.code === 'STALE') {
          try {
            onChange(await api<PurchaseOrder>(`${base}/orders/${encodeURIComponent(order.id)}`))
          } catch {
            // The notice already told the owner; the next refresh brings the latest.
          }
        }
        return null
      }
    },
    [api, base, notify, onChange, review, explain],
  )
  return {
    approve: (order: PurchaseOrder) => run(order, 'approve'),
    cancel: (order: PurchaseOrder) => run(order, 'cancel'),
    fix: (order: PurchaseOrder, fix: unknown) => run(order, 'fix', { fix }),
    simulate: (order: PurchaseOrder, variant: SimVariant) => run(order, 'simulate', { variant }),
    inbound: (order: PurchaseOrder, text: string) => run(order, 'inbound', { text }),
    resolve: (order: PurchaseOrder, flagId: string, value: string) =>
      run(order, `flags/${encodeURIComponent(flagId)}`, { value }),
    accept: (order: PurchaseOrder) => run(order, 'accept'),
    received: (order: PurchaseOrder) => run(order, 'received'),
  }
}

export function useDraftReorder() {
  const { api, activeId, notify } = useWorkspace()
  const s = useSupplyCopy()
  return useCallback(
    async (item = ''): Promise<PurchaseOrder | null> => {
      try {
        const result = await api<{ status: string; order?: PurchaseOrder }>(
          `/businesses/${encodeURIComponent(activeId ?? '')}/supply/reorder`,
          { method: 'POST', body: JSON.stringify(item ? { item } : {}) },
        )
        if (!result.order) notify(s.noOrders)
        return result.order ?? null
      } catch {
        notify(s.failed)
        return null
      }
    },
    [api, activeId, notify, s],
  )
}

export function useRulesActions() {
  const { api, activeId, notify } = useWorkspace()
  const s = useSupplyCopy()
  const base = `/businesses/${encodeURIComponent(activeId ?? '')}/supply/suppliers`
  const save = useCallback(
    async (row: Relationship, rules: RuleSet): Promise<Relationship | null> => {
      try {
        const saved = await api<Relationship>(
          `${base}/${encodeURIComponent(row.supplier.id)}/rules`,
          { method: 'PUT', body: JSON.stringify({ version: row.version, rules }) },
        )
        notify(s.saved)
        return saved
      } catch (cause) {
        notify(cause instanceof ApiError && cause.code === 'STALE' ? s.stale : s.failed)
        return null
      }
    },
    [api, base, notify, s],
  )
  const confirm = useCallback(
    async (row: Relationship, apply: boolean): Promise<Relationship | null> => {
      try {
        const saved = await api<Relationship>(
          `${base}/${encodeURIComponent(row.supplier.id)}/rules/confirm`,
          { method: 'POST', body: JSON.stringify({ version: row.version, apply }) },
        )
        notify(apply ? s.ruleConfirmed : s.ruleKept)
        return saved
      } catch {
        notify(s.failed)
        return null
      }
    },
    [api, base, notify, s],
  )
  return { save, confirm }
}

/** "Fri 17 Oct" in the owner's language, from an ISO date. */
export function dayLabel(iso: string, locale: string): string {
  if (!iso) return ''
  const day = new Date(`${iso.slice(0, 10)}T12:00:00`)
  if (Number.isNaN(day.getTime())) return iso
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(day)
}
