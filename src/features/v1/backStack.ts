import { createContext, use, useEffect, useRef, useSyncExternalStore } from 'react'
import { carried, entryState, lastDirection, pushEntry, replaceEntry } from '../../app/history'

/**
 * The phone's back button closes the top sheet or dialog first. Every open overlay owns one
 * same-URL history entry; Back pops the top one and closes it. Closing in-app removes the
 * entry again with history.back(), so the history never fills with stale entries.
 *
 * An entry with unsaved input (a typed draft, an open review) is not closed by Back: the
 * owner sees an in-app "Discard changes?" first, and leaving the page asks the browser's own
 * beforeunload question.
 *
 * Both apps turn this on (BackHistory). Pages and tabs are their own entries (app/history.ts);
 * Discover's ?view=map stays a URL of its own.
 */
export const BackHistory = createContext(false)

interface Entry {
  id: string
  close: () => void
  dirty: () => boolean
}

const stack: Entry[] = []
// Entries waiting for our own history.back() to land before they push.
const queued: Entry[] = []
// popstate events caused by our own history.back() calls.
let ignore = 0
let nextId = 1
// Ids are unique per page load: a marker left by an earlier load never matches a new sheet.
const loadTag = Math.random().toString(36).slice(2, 6)
let pending: Entry | null = null
// Entries closed in this commit whose history slot is not yet given back. An overlay opening in the
// same commit (a form handing over to its review) takes the slot over with replaceState instead
// of back() then pushState(): a Back pressed in between can no longer leave the app.
let handoff = 0
const listeners = new Set<() => void>()
const handledPops = new WeakSet<Event>()
/** Routes ignore a pop already consumed by an overlay (including its cleanup). */
export function overlayHandled(event: PopStateEvent) {
  return handledPops.has(event)
}
const emit = () => listeners.forEach((listener) => listener())

function pushState(entry: Entry) {
  stack.push(entry)
  // `sheet` marks the slot this entry owns; `overlay` is also carried by a feature URL above it.
  pushEntry(null, { ...carried(), overlay: entry.id, sheet: entry.id })
}

const live = (id: unknown) =>
  stack.some((entry) => entry.id === id) ||
  queued.some((entry) => entry.id === id) ||
  pending?.id === id

function onPopState(event: PopStateEvent) {
  if (ignore > 0) {
    handledPops.add(event)
    ignore -= 1
    if (ignore === 0) queued.splice(0).forEach(pushState)
    return
  }
  // A sheet's slot whose sheet is gone (a link inside it opened a page, or the page was
  // refreshed) is skipped in the direction of travel, so no Back press lands on nothing.
  const { sheet } = entryState()
  if (sheet !== undefined && !live(sheet)) {
    handledPops.add(event)
    history.go(lastDirection() > 0 ? 1 : -1)
    return
  }
  // A feature URL can sit above this entry without closing it. Landing back on
  // its marker returns to the draft; it does not discard the draft itself.
  if (stack.at(-1)?.id === entryState().overlay) return
  const top = stack.pop()
  if (!top) return
  handledPops.add(event)
  if (top.dirty()) {
    // The entry is gone from history; "Keep editing" puts it back.
    pending = top
    emit()
  } else top.close()
}

function onBeforeUnload(event: BeforeUnloadEvent) {
  if ([...stack, ...queued].some((entry) => entry.dirty())) event.preventDefault()
}

let listening = false
function listen() {
  if (listening) return
  listening = true
  window.addEventListener('popstate', onPopState, true)
  window.addEventListener('beforeunload', onBeforeUnload)
}

function flushReleases() {
  if (handoff === 0) return
  const steps = handoff
  handoff = 0
  ignore += 1
  history.go(-steps)
}

function register(close: () => void, dirty: () => boolean): string {
  listen()
  const entry = { id: `${loadTag}-${nextId++}`, close, dirty }
  if (handoff > 0) {
    handoff -= 1
    stack.push(entry)
    replaceEntry(null, { overlay: entry.id, sheet: entry.id })
  } else if (ignore > 0) queued.push(entry)
  else pushState(entry)
  return entry.id
}

function release(id: string) {
  const waiting = queued.findIndex((entry) => entry.id === id)
  if (waiting >= 0) {
    queued.splice(waiting, 1)
    return
  }
  const index = stack.findIndex((entry) => entry.id === id)
  // Already popped by Back (or waiting on "Discard changes?").
  if (index < 0) {
    if (pending?.id === id) {
      pending = null
      emit()
    }
    return
  }
  stack.splice(index, 1)
  // A route may already have been pushed above this overlay. Never pop that new page
  // while cleaning up a hidden coach's draft guard or an older sheet.
  if (entryState().overlay !== id) return
  handoff += 1
  queueMicrotask(flushReleases)
}

/** Answer to "Discard changes?": keep editing (restore the entry) or discard (close). */
export function resolvePending(discard: boolean) {
  const entry = pending
  pending = null
  emit()
  if (!entry) return
  if (discard) entry.close()
  else if (ignore > 0) queued.push(entry)
  else pushState(entry)
}

export function usePendingDiscard(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => pending !== null,
  )
}

/**
 * While `open`, Back calls `onClose` instead of leaving the page. With `dirty`, Back asks
 * "Discard changes?" first and leaving the page asks the browser to confirm.
 */
export function useBackClose(open: boolean, onClose: () => void, dirty = false) {
  const enabled = use(BackHistory)
  const latest = useRef({ onClose, dirty })
  useEffect(() => {
    latest.current = { onClose, dirty }
  })
  useEffect(() => {
    if (!open || !enabled) return
    const id = register(
      () => latest.current.onClose(),
      () => latest.current.dirty,
    )
    return () => release(id)
  }, [open, enabled])
}
