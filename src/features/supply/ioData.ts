import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, type Proposal } from '../v1/api'
import { useWorkspace } from '../v1/workspaceContext'
import { useIoCopy } from './ioCopy'
import type { Board, IoDocument, IoOrder } from './ioTypes'

/** Every supply screen (Today, the sheet, Close the day, chat cards) refreshes together. */
const CHANGED = 'chalkboard:supply-changed'
export function supplyChanged() {
  window.dispatchEvent(new Event(CHANGED))
}

/** The supply board of the active shop: loading, error with retry, and refresh. */
export function useBoard(open = true) {
  const { api, activeId } = useWorkspace()
  const [state, setState] = useState<{ id: string; board: Board | null; failed: boolean } | null>(
    null,
  )
  const refresh = useCallback(async () => {
    if (!activeId) return
    try {
      const board = await api<Board>(`/businesses/${encodeURIComponent(activeId)}/supply/board`)
      setState({ id: activeId, board, failed: false })
    } catch {
      // Keep what is shown; the error state offers a retry.
      setState((old) =>
        old?.id === activeId
          ? { ...old, failed: true }
          : { id: activeId, board: null, failed: true },
      )
    }
  }, [api, activeId])
  useEffect(() => {
    if (!open) return
    const first = window.setTimeout(() => void refresh(), 0)
    const again = () => void refresh()
    window.addEventListener(CHANGED, again)
    return () => {
      window.clearTimeout(first)
      window.removeEventListener(CHANGED, again)
    }
  }, [open, refresh])
  const mine = state?.id === activeId ? state : null
  return { board: mine?.board ?? null, failed: mine?.failed ?? false, refresh }
}

/** Owner actions on partner documents. Each returns the updated order, or null after a notice. */
export function useIoActions() {
  const { api, activeId, notify, review } = useWorkspace()
  const c = useIoCopy()
  const base = `/businesses/${encodeURIComponent(activeId ?? '')}/supply`
  const run = useCallback(
    async <T>(path: string, body?: Record<string, unknown>): Promise<T | null> => {
      try {
        const result = await api<T>(`${base}/${path}`, {
          method: 'POST',
          body: body ? JSON.stringify(body) : undefined,
        })
        supplyChanged()
        return result
      } catch (cause) {
        const code = cause instanceof ApiError ? cause.code : ''
        notify(code === 'STALE' ? c.stale : code === 'DEMO_DONE' ? c.demoDone : c.actionFailed)
        supplyChanged()
        return null
      }
    },
    [api, base, notify, c],
  )
  const order = (o: IoOrder, action: string) => `orders/${encodeURIComponent(o.id)}/${action}`
  return {
    answer: (o: IoOrder, accept: boolean) =>
      run<IoOrder>(order(o, 'change'), { version: o.version, accept }),
    receipt: async (o: IoOrder, received: Record<number, number>) => {
      const result = await run<{ order: IoOrder; document: IoDocument; proposal: Proposal | null }>(
        order(o, 'receipt'),
        {
          version: o.version,
          received: Object.entries(received).map(([line, quantity]) => ({
            line: Number(line),
            quantity,
          })),
        },
      )
      if (result?.proposal) review(result.proposal)
      return result
    },
    asn: (o: IoOrder) =>
      run<{ order: IoOrder; document: IoDocument }>(order(o, 'asn'), { version: o.version }),
    send: (o: IoOrder, docId: string) =>
      run<IoOrder>(order(o, 'send'), { version: o.version, doc_id: docId }),
    approve: (o: IoOrder) => run<IoOrder>(order(o, 'approve'), { version: o.version }),
    sendAll: () => run<{ sent: unknown[] }>('send-all'),
    dismiss: (entryId: string) => run(`inbox/${encodeURIComponent(entryId)}/dismiss`),
    demoNext: () => run('demo/next'),
  }
}

/**
 * Sends after a few seconds unless the owner taps Undo (UX rule 9). Closing the screen during
 * the countdown is not an undo: the send goes out at once.
 */
export function useUndoableSend(seconds = 5) {
  const [left, setLeft] = useState<number | null>(null)
  const timer = useRef<number | null>(null)
  const pending = useRef<(() => Promise<unknown>) | null>(null)
  const undo = useCallback(() => {
    if (timer.current !== null) window.clearInterval(timer.current)
    timer.current = null
    pending.current = null
    setLeft(null)
  }, [])
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearInterval(timer.current)
      const send = pending.current
      pending.current = null
      if (send) void send()
    },
    [],
  )
  const start = useCallback(
    (send: () => Promise<unknown>) => {
      undo()
      pending.current = send
      let remaining = seconds
      setLeft(remaining)
      timer.current = window.setInterval(() => {
        remaining -= 1
        if (remaining > 0) {
          setLeft(remaining)
          return
        }
        const go = pending.current
        undo()
        if (go) void go()
      }, 1000)
    },
    [seconds, undo],
  )
  return { left, start, undo }
}
