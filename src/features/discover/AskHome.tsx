import { carried, pushEntry } from '../../app/history'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  IconButton,
  InputBase,
  Stack,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material'
import {
  ArrowRight,
  ArrowUp,
  ChevronDown,
  LocateFixed,
  MapPin,
  Mic,
  RotateCcw,
  Sparkles,
  Square,
  WifiOff,
} from 'lucide-react'
import { useLocale } from '../../state/hooks'
import type { Locale } from '../../i18n/locales'
import { chalkWrite, dealIn } from '../../design/chalkMotion'
import { RichText } from '../../design/RichText'
import { HAND_FONT, motion } from '../../design/theme'
import { customerNavigate, goTo } from '../frontdoors/navigation'
import type { CustomerLocation } from '../frontdoors/CustomerApp'
import { useCustomer } from '../customer/account'
import { accountCopyFor } from '../customer/copy'
import { preferenceChips } from '../customer/preferences'
import { openedShops } from './opened'
import { ProfileButton, ProfileSheet } from '../customer/Profile'
import { AppearanceToggle } from '../frontdoors/AppearanceToggle'
import { LanguagePicker } from '../frontdoors/LanguagePicker'
import { useFrontCopy } from '../frontdoors/strings'
import { usePassportCopy } from '../passport/copy'
import { TodayDeck } from '../passport/TodayDeck'
import { AreaAnswerCard, GoogleRows, PickCard, PickList, PickSkeleton } from './AnswerCards'
import type { AskPick } from './askThread'
import { AnswerMap, type MapSelection } from './AnswerMap'
import { askCopy } from './askStrings'
import {
  clearTurns,
  lastIntent,
  loadTurns,
  saveTurns,
  turnId,
  type AskAnswer,
  type Refine,
  type Suggestions,
  type Turn,
} from './askThread'
import { discoverCopy } from './strings'
import { fillIn, samplePrice, useConversationCopy, type ConversationCopy } from './conversationCopy'
import { ensureDemoWorld, isIndianArea } from './demoWorld'
import { localRankShops, prefetchAreaShops } from './shopCache'
import { recsEvent } from '../recs/events'
import { PlaceSearch, type FoundPlace } from './PlaceSearch'
import { areaCurrency, defaultCurrency } from '../v1/format'
import '../customer/customer.css'

const FILTERS = 'chalkboard.discover.filters'

function fallbackPlace(): FoundPlace {
  const currency = defaultCurrency()
  if (currency === 'INR') return { lat: 12.9716, lng: 77.5946, label: 'Indiranagar' }
  if (currency === 'MYR') return { lat: 3.1319, lng: 101.6841, label: 'Bangsar' }
  if (currency === 'JPY') return { lat: 35.658, lng: 139.7016, label: 'Shibuya' }
  if (currency === 'KRW') return { lat: 37.5665, lng: 126.978, label: 'Hongdae' }
  if (currency === 'IDR') return { lat: -6.2088, lng: 106.8456, label: 'Senopati' }
  if (currency === 'THB') return { lat: 13.7563, lng: 100.5018, label: 'Thonglor' }
  if (currency === 'VND') return { lat: 10.7769, lng: 106.7009, label: 'District 1' }
  if (currency === 'PHP') return { lat: 14.5547, lng: 121.0244, label: 'BGC' }
  if (currency === 'GBP') return { lat: 51.5074, lng: -0.1278, label: 'Soho' }
  if (currency === 'EUR') return { lat: 48.8566, lng: 2.3522, label: 'Le Marais' }
  if (currency === 'AUD') return { lat: -33.8688, lng: 151.2093, label: 'Surry Hills' }
  return { lat: 1.2847, lng: 103.832, label: 'Tiong Bahru' }
}
/** The bottom dock before it is measured: composer (56) and chips (2 x 52); no layout shift. */
const DOCK_ESTIMATE = 200
/** The navigation bar under the dock (hidden while typing on a phone). */
const NAV = 80

function savedPlace(): FoundPlace | null {
  try {
    const place = (JSON.parse(localStorage.getItem(FILTERS) || '{}') as { place?: FoundPlace })
      .place
    if (!place || !Number.isFinite(place.lat) || !Number.isFinite(place.lng)) return null
    if (place.label?.toLowerCase() === 'you') {
      return { ...place, label: 'Nearby' }
    }
    return place
  } catch {
    return null
  }
}

function rememberPlace(place: FoundPlace) {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTERS) || '{}') as object
    localStorage.setItem(FILTERS, JSON.stringify({ ...saved, place }))
  } catch {
    /* Optional storage. */
  }
}

type SpeechRecognitionLike = {
  lang: string
  interimResults: boolean
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
  start: () => void
  stop: () => void
}

function speechRecognition(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as Record<string, unknown>
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as
    (new () => SpeechRecognitionLike) | null
}

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

/** Singapore says MRT; elsewhere in English a station is a station. */
function transitLabel(copy: ConversationCopy, locale: Locale, place: FoundPlace) {
  const singapore = place.lat > 1.15 && place.lat < 1.48 && place.lng > 103.6 && place.lng < 104.1
  return locale === 'en' && !singapore ? 'Near a station?' : copy.transit
}

type Chip = { label: string; q: string; refine?: Refine; kind?: Turn['kind'] }

/**
 * The customer front door is a conversation (owner decision, 16 Oct): ask in your own words,
 * answers come back as cards with the exact item and price, and follow-ups keep the context
 * ("cheaper?", "open now?", "near the MRT?"). Today's 7 is one tap away in the same thread.
 */
export default function AskHome({
  initialLocation,
  onLocationChange,
  interests = [],
}: {
  initialLocation?: CustomerLocation | null
  onLocationChange?: (location: CustomerLocation) => void
  interests?: string[]
}) {
  const locale = useLocale()
  const t = askCopy(locale)
  const front = useFrontCopy()
  const discover = discoverCopy(locale)
  const passport = usePassportCopy()
  const roles = useTheme().material
  const account = useCustomer()
  const [place, setPlace] = useState<FoundPlace>(() => {
    const initial =
      (initialLocation?.gps
        ? { lat: initialLocation.gps[0], lng: initialLocation.gps[1], label: t.here }
        : initialLocation?.place) ??
      savedPlace() ??
      fallbackPlace()
    if (initial.label?.toLowerCase() === 'you') {
      return { ...initial, label: t.here }
    }
    return initial
  })

  useEffect(() => {
    if (initialLocation?.gps) {
      const [lat, lng] = initialLocation.gps
      fetch(`/api/v1/discover/place?lat=${lat}&lng=${lng}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { label?: string; lat: number; lng: number } | null) => {
          if (data?.label && data.label.toLowerCase() !== 'you') {
            setPlace((current) => ({ ...current, lat, lng, label: data.label! }))
          }
        })
        .catch(() => undefined)
    }
  }, [initialLocation?.gps])

  const currency = areaCurrency(place)
  const c = useConversationCopy(currency)
  // A first visit has not said where yet: the page asks inline, never a wizard before it.
  const [located, setLocated] = useState(() => !!initialLocation || savedPlace() !== null)
  const [locating, setLocating] = useState(false)
  const [denied, setDenied] = useState(false)
  const [nearby, setNearby] = useState<{ key: string; shops: AskPick[] } | null>(null)
  const [turns, setTurns] = useState<Turn[]>(loadTurns)
  const [draft, setDraft] = useState('')
  const [changing, setChanging] = useState(false)
  const [listening, setListening] = useState(false)
  // The example on the opening page; in a conversation the composer is narrower, so plain words.
  const placeholderText = useMemo(() => {
    if (listening) return t.listening
    if (turns.length) return c.composer
    if (isIndianArea(place.lat, place.lng, place.label)) {
      return c.placeholder.replace(samplePrice(currency, locale), samplePrice('INR', locale))
    }
    return c.placeholder
  }, [
    listening,
    t.listening,
    turns.length,
    c.composer,
    c.placeholder,
    place.lat,
    place.lng,
    place.label,
    currency,
    locale,
  ])
  const [suggested, setSuggested] = useState<{ key: string; data: Suggestions } | null>(null)
  const placeKey = `${place.lat},${place.lng}`
  const suggestions = suggested?.key === placeKey ? suggested.data : null
  const [profileOpen, setProfileOpen] = useState(false)
  const [line, setLine] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const recognizer = useRef<SpeechRecognitionLike | null>(null)
  const requests = useRef(new Map<string, AbortController>())
  const Speech = speechRecognition()
  const busy = turns.some((turn) => turn.status === 'thinking')

  useEffect(() => {
    document.title = `${c.hello} · Chalkboard`
  }, [c.hello])

  useEffect(() => saveTurns(turns), [turns])

  // Back from a shop or a chat lands where you were in the conversation.
  useEffect(() => {
    const y = (history.state as { scrollY?: number } | null)?.scrollY
    if (!y) return
    let count = 0
    const attempt = () => {
      window.scrollTo({ top: y, behavior: 'instant' })
      if (Math.abs(window.scrollY - y) > 5 && count++ < 12) {
        requestAnimationFrame(attempt)
      }
    }
    requestAnimationFrame(attempt)
    const timer = setTimeout(attempt, 60)
    return () => clearTimeout(timer)
  }, [turns])

  useEffect(() => {
    if (!busy) return
    const timer = setInterval(() => setLine((n) => (n + 1) % t.thinking.length), 1100)
    return () => clearInterval(timer)
  }, [busy, t.thinking.length])

  // Route chunk prefetch: prefetch PublicShop and RescueScreen chunks during idle
  useEffect(() => {
    const prefetch = () => {
      void import('../public/PublicShop')
      void import('../rescue/RescueScreen')
    }
    const win = window as unknown as {
      requestIdleCallback?: (cb: () => void) => number
      cancelIdleCallback?: (id: number) => void
    }
    if (typeof win.requestIdleCallback === 'function') {
      const id = win.requestIdleCallback(prefetch)
      return () => win.cancelIdleCallback?.(id)
    }
    const timer = setTimeout(prefetch, 1200)
    return () => clearTimeout(timer)
  }, [])

  // Suggestion chips and shop data come from this area's own shops (labelled demo shops included).
  // The area's shops load after its demo world exists, so the first cards and the instant answers
  // see the whole neighbourhood.
  useEffect(() => {
    let live = true
    const key = `${place.lat},${place.lng}`
    void ensureDemoWorld(place.lat, place.lng, place.label)
      .catch(() => undefined)
      .then(() => prefetchAreaShops(place.lat, place.lng))
      .then((shops) => {
        if (live) setNearby({ key, shops: nearbyFirst(shops, place.lat, place.lng) })
      })
    fetch(
      `/api/v1/discover/suggest?${new URLSearchParams({ lat: String(place.lat), lng: String(place.lng) })}`,
    )
      .then((response) => (response.ok ? (response.json() as Promise<Suggestions>) : null))
      .catch(() => null)
      .then((data) => {
        if (live)
          setSuggested({
            key,
            data: data ?? { items: [], shops: 0, open_now: 0, locally_made: 0, deals: 0 },
          })
      })
    return () => {
      live = false
    }
  }, [place.lat, place.lng, place.label])

  const update = useCallback((id: string, patch: Partial<Turn>) => {
    setTurns((all) => all.map((turn) => (turn.id === id ? { ...turn, ...patch } : turn)))
  }, [])

  const run = useCallback(
    async (turn: Turn) => {
      if (turn.kind === 'today') {
        update(turn.id, { status: 'done' })
        return
      }
      if (!navigator.onLine) {
        update(turn.id, { status: 'offline' })
        return
      }
      const controller = new AbortController()
      requests.current.set(turn.id, controller)
      update(turn.id, { status: 'thinking' })

      try {
        // Allow the live status line and skeleton result cards to render
        await new Promise((resolve) => setTimeout(resolve, 150))
        if (controller.signal.aborted) {
          update(turn.id, { status: 'stopped' })
          return
        }

        // Instant path: answer immediately from our own shops (< 700 ms target)
        const localPicks = localRankShops(turn.q, turn.place.lat, turn.place.lng)
        if (localPicks.length > 0) {
          if (controller.signal.aborted) {
            update(turn.id, { status: 'stopped' })
            return
          }
          const instantAnswer: AskAnswer = {
            intent: {
              summary: fillIn(c.found, { place: turn.place.label }),
              keywords: [turn.q],
              category: '',
              max_price: null,
              halal: false,
              vegetarian: false,
              locally_made: false,
              open_now: false,
              followups: [],
              sort: 'best',
              near: '',
              deals: false,
              area: false,
            },
            mode: 'keywords',
            groups: [{ id: 'best', places: localPicks.slice(0, 8) }],
            anchor: null,
            // Ranked on this device, not by embeddings; the server's engine answer replaces it.
            engine: 'fixture',
          }
          update(turn.id, { status: 'done', answer: instantAnswer, streaming: true })
        }

        // Parallel demo world fetch: never blocks query dispatch
        void ensureDemoWorld(turn.place.lat, turn.place.lng, turn.place.label)
        recsEvent({ kind: 'ask', query: turn.q })

        const handleAnswer = (answer: AskAnswer) => {
          if (answer.command) {
            const { kind, shop_id } = answer.command
            const path =
              kind === 'my_stamps'
                ? '/explore/passport'
                : (kind === 'follow' || kind === 'ask_owner') && shop_id
                  ? `/explore/s/${encodeURIComponent(shop_id)}`
                  : null
            if (path) {
              goTo(path)
              return
            }
          }
          if (answer.personal) {
            void account
              .api<{ profile?: unknown }>('/api/v1/customer/me')
              .then((me) => {
                if (me.profile)
                  account.setProfile(me.profile as Parameters<typeof account.setProfile>[0])
              })
              .catch(() => undefined)
          }
        }

        const response = await account.raw('/api/v1/discover/ask', {
          method: 'POST',
          signal: controller.signal,
          headers: {
            Accept: 'text/event-stream, application/json',
          },
          body: JSON.stringify({
            q: turn.q,
            lat: turn.place.lat,
            lng: turn.place.lng,
            language: locale,
            context: turn.context ?? null,
            refine: turn.refine ?? null,
            opened: openedShops(),
          }),
        })

        if (controller.signal.aborted) {
          update(turn.id, { status: 'stopped' })
          return
        }
        if (!response.ok) throw new Error(String(response.status))

        const contentType = response.headers.get('content-type') || ''
        if (contentType.includes('text/event-stream') && response.body) {
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          let streamText = ''
          let lastAnswer: AskAnswer | undefined

          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              buffer += decoder.decode(value, { stream: true })
              buffer = buffer.replace(/\r\n/g, '\n')
              let boundary: number
              while ((boundary = buffer.indexOf('\n\n')) >= 0) {
                const frame = buffer.slice(0, boundary)
                buffer = buffer.slice(boundary + 2)
                const lines = frame.split('\n')
                const eventLine = lines.find((l) => l.startsWith('event:'))
                const eventType = eventLine ? eventLine.slice(6).trim() : 'message'
                const dataLines = lines
                  .filter((l) => l.startsWith('data:'))
                  .map((l) => l.slice(5).trimStart())
                  .join('\n')
                if (!dataLines) continue

                if (eventType === 'instant') {
                  const instant = JSON.parse(dataLines) as AskAnswer
                  lastAnswer = instant
                  update(turn.id, { status: 'done', answer: instant, streaming: true })
                } else if (eventType === 'delta') {
                  const delta = JSON.parse(dataLines) as { text?: string }
                  if (delta.text) {
                    streamText += delta.text
                    if (lastAnswer) {
                      lastAnswer = {
                        ...lastAnswer,
                        mode: 'ai',
                        intent: { ...lastAnswer.intent, summary: streamText },
                      }
                      update(turn.id, { status: 'done', answer: lastAnswer, streaming: true })
                    }
                  }
                } else if (eventType === 'complete' || eventType === 'command') {
                  const complete = JSON.parse(dataLines) as AskAnswer
                  lastAnswer = complete
                  update(turn.id, { status: 'done', answer: complete, streaming: false })
                }
              }
            }
          } finally {
            reader.releaseLock()
          }

          if (lastAnswer) {
            handleAnswer(lastAnswer)
            return
          }
        }

        // Standard JSON response fallback (e.g. tests or non-streaming servers)
        const answer = (await response.json()) as AskAnswer
        if (controller.signal.aborted) {
          update(turn.id, { status: 'stopped' })
          return
        }
        update(turn.id, { status: 'done', answer, streaming: false })
        handleAnswer(answer)
      } catch {
        if (controller.signal.aborted) update(turn.id, { status: 'stopped' })
        else update(turn.id, { status: navigator.onLine ? 'failed' : 'offline' })
      } finally {
        requests.current.delete(turn.id)
      }
    },
    [account, c.found, locale, update],
  )

  // Offline turns try again by themselves when the connection is back.
  const latestTurns = useRef(turns)
  useEffect(() => {
    latestTurns.current = turns
  }, [turns])
  useEffect(() => {
    const online = () => {
      for (const turn of latestTurns.current) if (turn.status === 'offline') void run(turn)
    }
    window.addEventListener('online', online)
    return () => window.removeEventListener('online', online)
  }, [run])

  function send(text: string, options: { refine?: Refine; kind?: Turn['kind'] } = {}) {
    const q = text.trim()
    if (!q || busy) return
    const turn: Turn = {
      id: turnId(),
      kind: options.kind ?? 'ask',
      q,
      refine: options.refine ?? null,
      context: options.kind === 'today' ? null : lastIntent(turns),
      status: 'thinking',
      place,
    }
    // The first question gets its own history entry: back returns to the opening page.
    if (turns.length === 0 && !(history.state as { ask?: boolean } | null)?.ask)
      pushEntry(null, { ...carried(), ask: true })
    setTurns((all) => [...all, turn])
    setDraft('')
    setLine(0)
    void run(turn)
    requestAnimationFrame(() =>
      document
        .getElementById(`turn-${turn.id}`)
        ?.scrollIntoView({ behavior: reduced() ? 'instant' : 'smooth', block: 'start' }),
    )
  }

  function stop() {
    for (const [id, controller] of requests.current.entries()) {
      controller.abort()
      update(id, { status: 'stopped' })
    }
    requests.current.clear()
  }

  function reset() {
    stop()
    clearTurns()
    setTurns([])
    setChanging(false)
    window.scrollTo({ top: 0, behavior: 'instant' })
  }

  // A fresh start is the history entry before the first question, so the back button and
  // "New conversation" both land on the opening page (and a further back leaves as usual).
  function restart() {
    if ((history.state as { ask?: boolean } | null)?.ask) history.back()
    else reset()
    requestAnimationFrame(() => input.current?.focus())
  }

  function choosePlace(found: FoundPlace, gps: [number, number] | null = null) {
    setPlace(found)
    onLocationChange?.({ gps, place: gps ? null : found })
    rememberPlace(found)
    setLocated(true)
    setChanging(false)
    setDenied(false)
    // An open question is asked again for the new area.
    const previous = [...turns].reverse().find((turn) => turn.kind === 'ask')
    if (previous && !busy) {
      const turn: Turn = {
        ...previous,
        id: turnId(),
        place: found,
        status: 'thinking',
        answer: undefined,
      }
      setTurns((all) => [...all, turn])
      void run(turn)
    }
  }

  function locate() {
    setDenied(false)
    if (!navigator.geolocation) {
      setDenied(true)
      return
    }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false)
        const { latitude: lat, longitude: lng } = position.coords
        choosePlace({ lat, lng, label: t.here }, [lat, lng])
        void placeLabel(lat, lng).then((label) => {
          if (!label) return
          setPlace((current) =>
            current.lat === lat && current.lng === lng ? { ...current, label } : current,
          )
          rememberPlace({ lat, lng, label })
        })
      },
      () => {
        setLocating(false)
        setDenied(true)
      },
      // Precise: "around me" should mean this street, not this district.
      { timeout: 15_000, maximumAge: 30_000, enableHighAccuracy: true },
    )
  }

  function listen() {
    if (!Speech) return
    if (listening) {
      recognizer.current?.stop()
      return
    }
    const recognition = new Speech()
    recognition.lang = locale
    recognition.interimResults = true
    let heard = ''
    recognition.onresult = (event) => {
      heard = Array.from(event.results)
        .map((result) => result[0]?.transcript ?? '')
        .join('')
      setDraft(heard)
    }
    recognition.onerror = () => setListening(false)
    recognition.onend = () => {
      setListening(false)
      if (heard.trim()) send(heard)
    }
    recognizer.current = recognition
    setListening(true)
    recognition.start()
  }

  // Back from an answer returns to the opening page (the entry before the first question).
  useEffect(() => {
    const toOpening = () => {
      if (!/^\/explore\/?$/.test(location.pathname)) return
      if ((history.state as { ask?: boolean } | null)?.ask) return
      for (const controller of requests.current.values()) controller.abort()
      requests.current.clear()
      clearTurns()
      setTurns([])
      setChanging(false)
    }
    window.addEventListener('popstate', toOpening)
    return () => window.removeEventListener('popstate', toOpening)
  }, [])

  // The dock (composer) is measured, so the page always ends just above it.
  const dock = useRef<HTMLDivElement>(null)
  const [dockHeight, setDockHeight] = useState(DOCK_ESTIMATE)
  useEffect(() => {
    const node = dock.current
    if (!node) return
    const measure = () => setDockHeight(Math.round(node.getBoundingClientRect().height))
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  // Typing on a phone: the navigation bar steps aside so the composer sits on the keyboard.
  // Browsers that cover the page with the keyboard (iOS) report it through visualViewport.
  const [typing, setTyping] = useState(false)
  useEffect(() => {
    const root = document.documentElement
    root.toggleAttribute('data-typing', typing)
    return () => root.removeAttribute('data-typing')
  }, [typing])
  useEffect(() => {
    const view = window.visualViewport
    if (!view) return
    const root = document.documentElement
    const sync = () => {
      const covered = view.scale > 1.01 ? 0 : innerHeight - view.height - view.offsetTop
      root.style.setProperty('--c-keyboard', `${Math.max(0, Math.round(covered))}px`)
    }
    sync()
    view.addEventListener('resize', sync)
    view.addEventListener('scroll', sync)
    return () => {
      view.removeEventListener('resize', sync)
      view.removeEventListener('scroll', sync)
      root.style.removeProperty('--c-keyboard')
    }
  }, [])

  const chips = startChips(suggestions, interests, c, t, discover, new Date().getHours())
  const last = turns.at(-1)
  const anyDemo = turns.some((turn) =>
    turn.answer?.groups.some((g) => g.places.some((p) => p.demo_shop || p.demo)),
  )
  const nearbyShops = nearby?.key === placeKey ? nearby.shops : null
  const opening = turns.length === 0
  // Chips appear once this area's suggestions are in (they grow up from the dock: no shift).
  const showChips = opening && suggestions !== null && !draft.trim() && !busy

  function submit() {
    send(draft)
    // A phone shows the answer full screen: the keyboard closes once the question is sent.
    if (matchMedia('(pointer: coarse)').matches) input.current?.blur()
  }

  return (
    <Box
      component="main"
      sx={{
        position: 'relative',
        minHeight: '100dvh',
        overflowX: 'clip',
        bgcolor: roles.surface,
        // The page ends just above the dock and the navigation bar, never under them.
        pb: `calc(${dockHeight + NAV + 16}px + env(safe-area-inset-bottom))`,
      }}
    >
      <ProfileSheet open={profileOpen} onClose={() => setProfileOpen(false)} />
      <Box sx={{ maxWidth: 720, mx: 'auto', px: 4 }}>
        {/* Where we are looking, then the person's own controls: one light row. */}
        <Stack
          direction="row"
          sx={{
            position: 'sticky',
            top: 0,
            zIndex: 1100,
            mx: -4,
            px: 4,
            alignItems: 'center',
            gap: 1,
            pt: 'max(8px, env(safe-area-inset-top))',
            pb: 1,
            minHeight: 64,
            bgcolor: roles.surface,
          }}
        >
          <Button
            onClick={() => setChanging((open) => !open)}
            aria-expanded={changing}
            aria-label={fillIn(c.area, { place: place.label })}
            startIcon={<MapPin size={18} aria-hidden="true" />}
            endIcon={<ChevronDown size={18} aria-hidden="true" />}
            sx={{
              minHeight: 48,
              minWidth: 0,
              px: 3,
              ml: -2,
              borderRadius: 999,
              color: roles.onSurface,
              bgcolor: roles.surfaceContainerLow,
              typography: 'titleSmall',
              '& .MuiButton-startIcon': { color: roles.primary },
              '&:hover': { bgcolor: roles.surfaceContainer },
            }}
          >
            <Box
              component="span"
              sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {place.label}
            </Box>
          </Button>
          <Stack direction="row" sx={{ ml: 'auto', flexShrink: 0, alignItems: 'center' }}>
            <ProfileButton inline />
            <LanguagePicker variant="inline" />
            <AppearanceToggle inline />
          </Stack>
        </Stack>
        {changing && (
          <Box className="c-rise" sx={{ mb: 4 }}>
            <PlaceSearch value={place.label} onFound={(found) => choosePlace(found)} />
          </Box>
        )}

        {/* One purpose: ask for what you want nearby. */}
        <Box component="section" aria-labelledby="ask-hello" sx={{ pt: opening ? 4 : 0 }}>
          <Typography
            id="ask-hello"
            component="h1"
            variant="headlineMedium"
            // In a conversation the answers need the room; the heading stays for screen readers.
            sx={
              opening
                ? {
                    fontWeight: 500,
                    letterSpacing: '-0.01em',
                    overflowWrap: 'break-word',
                    ...chalkWrite,
                  }
                : visuallyHidden
            }
          >
            {c.hello}
          </Typography>
          {opening && (
            <>
              <Typography
                variant="bodyMedium"
                color="text.secondary"
                // Two lines kept for the shop count, so it never pushes the page when it arrives.
                sx={{ mt: 2, minHeight: '2lh' }}
              >
                {suggestions?.shops
                  ? fillIn(c.helloBody, { count: suggestions.shops, place: place.label })
                  : fillIn(c.helloBodyEmpty, { place: place.label })}
              </Typography>
              {!located && (
                <Box
                  component="section"
                  aria-labelledby="ask-where"
                  className="c-rise"
                  sx={{
                    mt: 5,
                    p: 4,
                    borderRadius: '20px',
                    bgcolor: roles.secondaryContainer,
                    color: roles.onSecondaryContainer,
                  }}
                >
                  <Typography id="ask-where" component="h2" variant="titleMedium">
                    {front.location}
                  </Typography>
                  {denied && (
                    <Alert severity="info" sx={{ mt: 3 }}>
                      {discover.gpsError}
                    </Alert>
                  )}
                  <Button
                    variant="contained"
                    fullWidth
                    disabled={locating}
                    onClick={locate}
                    startIcon={<LocateFixed size={18} aria-hidden="true" />}
                    sx={{ mt: 3, minHeight: 48 }}
                  >
                    {discover.gps}
                  </Button>
                  <Box sx={{ mt: 3 }}>
                    <PlaceSearch onFound={(found) => choosePlace(found)} />
                  </Box>
                </Box>
              )}
              <NearbyShops shops={nearbyShops} copy={c} locale={locale} browse={t.browse} />
              <TodayEntry
                copy={c}
                onOpen={() => send(c.today, { kind: 'today' })}
                disabled={busy}
              />
              {showChips && (
                <Box
                  component="ul"
                  aria-label={c.composer}
                  data-chips
                  sx={{
                    listStyle: 'none',
                    p: 0,
                    m: 0,
                    mt: 5,
                    // In the page, not over it: they never cover the cards above them.
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                    gap: 2,
                  }}
                >
                  {chips.map((chip, index) => (
                    <Box
                      component="li"
                      key={chip.label}
                      sx={{ display: 'flex', ...dealIn, '--deal-index': index }}
                    >
                      <Button
                        variant="outlined"
                        fullWidth
                        onClick={() => send(chip.q, chip)}
                        sx={{
                          minHeight: 52,
                          borderRadius: '16px',
                          px: 3,
                          py: 2,
                          lineHeight: 1.25,
                          whiteSpace: 'normal',
                          overflowWrap: 'anywhere',
                          bgcolor: roles.surfaceContainerLow,
                          '&:hover': { bgcolor: roles.surfaceContainer },
                        }}
                      >
                        {chip.label}
                      </Button>
                    </Box>
                  ))}
                </Box>
              )}
            </>
          )}
        </Box>

        {/* The conversation so far. */}
        <Box sx={{ mt: opening ? 0 : 4, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {turns.map((turn) => (
            <Box
              key={turn.id}
              id={`turn-${turn.id}`}
              component="article"
              aria-label={turn.q}
              sx={{ scrollMarginTop: 80 }}
            >
              <UserBubble text={turn.q} copy={c} />
              <AssistantTurn
                turn={turn}
                latest={turn === last}
                copy={c}
                locale={locale}
                line={t.thinking[line] ?? t.thinking[0]!}
                transit={transitLabel(c, locale, turn.place)}
                onSend={send}
                onRetry={() => void run(turn)}
                onCancel={() => setTurns((all) => all.filter((x) => x.id !== turn.id))}
                onManage={() => setProfileOpen(true)}
              />
            </Box>
          ))}
        </Box>
        {anyDemo && (
          <Typography variant="bodySmall" color="text.secondary" sx={{ mt: 8 }}>
            {passport.demoLabel}
          </Typography>
        )}
        <Typography role="status" sx={visuallyHidden}>
          {last?.status === 'done' && last.answer
            ? count(last.answer)
              ? fillIn(c.found, { place: last.place.label })
              : fillIn(c.nothing, { q: last.q })
            : last?.status === 'failed'
              ? c.failed
              : last?.status === 'offline'
                ? c.offline
                : ''}
        </Typography>
      </Box>

      {/* The dock: big suggestion chips and the composer, in the thumb zone above the
          navigation bar, on the keyboard while typing, clear of the safe areas. */}
      <Box
        ref={dock}
        sx={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: typing ? 0 : `calc(${NAV}px + env(safe-area-inset-bottom))`,
          transform: 'translateY(calc(-1 * var(--c-keyboard, 0px)))',
          zIndex: 1050,
          pl: 'max(16px, env(safe-area-inset-left))',
          pr: 'max(16px, env(safe-area-inset-right))',
          pt: 6,
          pb: typing ? 'max(12px, env(safe-area-inset-bottom))' : 3,
          background: `linear-gradient(to bottom, transparent, ${roles.surface} 28px)`,
          viewTransitionName: 'customer-composer',
        }}
      >
        <Box sx={{ maxWidth: 720, mx: 'auto', position: 'relative' }}>
          <Stack direction="row" sx={{ alignItems: 'flex-end', gap: 2 }}>
            {!opening && (
              <Tooltip title={c.newChat}>
                <IconButton
                  aria-label={c.newChat}
                  onClick={restart}
                  sx={{
                    width: 56,
                    height: 56,
                    flexShrink: 0,
                    bgcolor: roles.surfaceContainerHigh,
                    border: `1px solid ${roles.outlineVariant}`,
                    '&:hover': { bgcolor: roles.surfaceContainerHighest },
                  }}
                >
                  <RotateCcw size={20} />
                </IconButton>
              </Tooltip>
            )}
            <Box
              component="form"
              role="search"
              onSubmit={(event) => {
                event.preventDefault()
                submit()
              }}
              sx={{
                flex: 1,
                minWidth: 0,
                display: 'flex',
                alignItems: 'flex-end',
                gap: 1,
                pl: 5,
                pr: 1,
                py: 1,
                minHeight: 56,
                borderRadius: '28px',
                bgcolor: roles.surfaceContainerHigh,
                border: `1px solid ${listening ? roles.primary : roles.outlineVariant}`,
                boxShadow: listening ? `0 0 0 2px ${roles.primary}` : '0 4px 16px rgba(0,0,0,0.08)',
                transition: `box-shadow ${motion.duration.short}ms ${motion.easing.standard}, border-color ${motion.duration.short}ms ${motion.easing.standard}`,
                '&:focus-within': {
                  borderColor: roles.primary,
                  boxShadow: `0 0 0 1px ${roles.primary}, 0 8px 24px rgba(0,0,0,0.12)`,
                },
              }}
            >
              <InputBase
                inputRef={input}
                multiline
                maxRows={3}
                value={draft}
                onChange={(event) => setDraft(event.target.value.replace(/\n/g, ' '))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    submit()
                  }
                }}
                onFocus={() => setTyping(matchMedia('(pointer: coarse)').matches)}
                onBlur={() => setTyping(false)}
                placeholder={placeholderText}
                inputProps={{ 'aria-label': c.composer, enterKeyHint: 'send', maxLength: 300 }}
                sx={{
                  flex: 1,
                  minWidth: 0,
                  minHeight: 48,
                  py: '12px',
                  fontSize: 16,
                  lineHeight: 1.5,
                  '& textarea::placeholder': { opacity: 1, color: roles.onSurfaceVariant },
                }}
              />
              {Speech && !busy && (
                <IconButton
                  aria-label={t.speak}
                  aria-pressed={listening}
                  onClick={listen}
                  onMouseDown={(event) => event.preventDefault()}
                  sx={{ width: 48, height: 48, color: listening ? roles.primary : undefined }}
                >
                  <Mic size={22} />
                </IconButton>
              )}
              {busy ? (
                <IconButton
                  aria-label={c.stop}
                  onClick={stop}
                  onMouseDown={(event) => event.preventDefault()}
                  sx={{
                    width: 48,
                    height: 48,
                    bgcolor: roles.surfaceContainerHighest,
                    color: roles.onSurface,
                    '&:hover': { bgcolor: roles.surfaceContainerHighest },
                  }}
                >
                  <Square size={16} fill="currentColor" />
                </IconButton>
              ) : (
                <IconButton
                  type="submit"
                  aria-label={c.send}
                  disabled={!draft.trim()}
                  onMouseDown={(event) => event.preventDefault()}
                  sx={{
                    width: 48,
                    height: 48,
                    bgcolor: roles.primary,
                    color: roles.onPrimary,
                    '&:hover': { bgcolor: roles.primary },
                    '&.Mui-disabled': {
                      bgcolor: roles.surfaceContainerHighest,
                      color: roles.onSurfaceVariant,
                    },
                  }}
                >
                  <ArrowUp size={20} />
                </IconButton>
              )}
            </Box>
          </Stack>
        </Box>
      </Box>
    </Box>
  )
}

/** The reverse-geocoded name of a point, or null. */
async function placeLabel(lat: number, lng: number): Promise<string | null> {
  try {
    const response = await fetch(`/api/v1/discover/place?lat=${lat}&lng=${lng}`)
    const data = response.ok ? ((await response.json()) as { label?: string }) : null
    return data?.label && data.label.toLowerCase() !== 'you' ? data.label : null
  } catch {
    return null
  }
}

/** The opening cards: deals and open shops first, then the closest; one card per shop and the
 * area's own currency (the server's rules for answers). */
function nearbyFirst(shops: AskPick[], lat: number, lng: number): AskPick[] {
  const inIndia = isIndianArea(lat, lng)
  const seen = new Set<string>()
  return shops
    .filter((shop) => {
      // Our own shops only: each card opens its Chalkboard page.
      if (shop.source !== 'chalkboard') return false
      if (inIndia && shop.currency === 'SGD') return false
      const key = shop.name
        .replace(/\s*\((Tour|Demo)\)$/i, '')
        .trim()
        .toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort(
      (a, b) =>
        Number(!!b.deal) - Number(!!a.deal) ||
        Number(!!b.open_now) - Number(!!a.open_now) ||
        (a.distance_m ?? Infinity) - (b.distance_m ?? Infinity),
    )
    .slice(0, 8)
}

/** This area's shops as large swipeable cards; a same-size skeleton while they load. */
function NearbyShops({
  shops,
  copy,
  locale,
  browse,
}: {
  shops: AskPick[] | null
  copy: ConversationCopy
  locale: Locale
  browse: string
}) {
  const all = (
    <Button
      component="a"
      href="/explore/browse"
      onClick={customerNavigate}
      endIcon={<ArrowRight size={18} />}
      sx={{ minHeight: 48, ml: -3 }}
    >
      {browse}
    </Button>
  )
  // Skeleton cards hold the carousel's height while it loads, so the Today card below never jumps.
  if (shops && shops.length === 0) return <Box sx={{ mt: 3 }}>{all}</Box>
  return (
    <Box component="section" aria-labelledby="ask-nearby" sx={{ mt: 6 }}>
      <Typography id="ask-nearby" component="h2" variant="titleMedium">
        {copy.nearbyNow}
      </Typography>
      {/* Big photos first: the neighbourhood's shops as cards the thumb swipes through. */}
      <PickList label={copy.nearbyNow} busy={shops === null} carousel>
        {shops
          ? shops.map((pick, index) => (
              <PickCard
                key={pick.id}
                pick={pick}
                index={index}
                anchor={null}
                copy={copy}
                locale={locale}
                numbered={false}
                tile
              />
            ))
          : [0, 1, 2].map((n) => <PickSkeleton key={n} tile />)}
      </PickList>
      {all}
    </Box>
  )
}

// Pixel strings: in sx a bare 1 means 100%, which made this "hidden" line a full screen tall
// and gave the opening page an empty scroll.
const visuallyHidden = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  margin: '-1px',
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const

function count(answer: AskAnswer) {
  return answer.groups.reduce((n, g) => n + g.places.length, 0)
}

/** First-message chips: this area's real items and states first, then the person's interests.
 * They follow the time: in the evening rescue deals and what is still open lead. */
function startChips(
  s: Suggestions | null,
  interests: string[],
  c: ConversationCopy,
  t: ReturnType<typeof askCopy>,
  discover: ReturnType<typeof discoverCopy>,
  hour: number,
): Chip[] {
  const chips: Chip[] = []
  const evening = hour >= 17 || hour < 4
  const deals = s?.deals ? [{ label: c.chipDeals, q: c.chipDeals, refine: 'deals' as const }] : []
  const open = s?.open_now ? [{ label: c.chipOpen, q: c.chipOpen, refine: 'open' as const }] : []
  if (evening) chips.push(...deals, ...open)
  for (const item of s?.items.slice(0, 2) ?? []) chips.push({ label: item, q: item })
  if (!evening) chips.push(...open, ...deals)
  if (s?.locally_made) chips.push({ label: c.chipLocal, q: c.chipLocal, refine: 'local' })
  for (const interest of interests) {
    const key = (interest === 'café' ? 'cafe' : interest) as keyof typeof discover
    const label = typeof discover[key] === 'string' ? (discover[key] as string) : interest
    chips.push({ label, q: label })
  }
  for (const text of t.suggestions) chips.push({ label: text, q: text })
  const seen = new Set<string>()
  return chips.filter((chip) => !seen.has(chip.label) && seen.add(chip.label)).slice(0, 4)
}

function TodayEntry({
  copy,
  onOpen,
  disabled,
}: {
  copy: ConversationCopy
  onOpen: () => void
  disabled: boolean
}) {
  const theme = useTheme()
  const tone = theme.chalk.sunflower
  return (
    <Box
      component="button"
      type="button"
      onClick={onOpen}
      disabled={disabled}
      sx={{
        mt: 5,
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 3,
        px: 4,
        py: 3,
        borderRadius: '20px',
        cursor: 'pointer',
        textAlign: 'start',
        font: 'inherit',
        // A calm card: the one sunflower accent is the small tile, not the whole surface.
        bgcolor: theme.material.surfaceContainerLow,
        color: theme.material.onSurface,
        border: `1px solid ${theme.material.outlineVariant}`,
        ...dealIn,
        '--deal-index': 5,
        '&:focus-visible': { outline: `3px solid ${theme.material.primary}`, outlineOffset: 2 },
        '&:disabled': { opacity: 0.6, cursor: 'default' },
      }}
    >
      <Box
        aria-hidden="true"
        sx={{
          width: 48,
          height: 48,
          flexShrink: 0,
          borderRadius: '14px',
          display: 'grid',
          placeItems: 'center',
          bgcolor: tone.main,
          color: tone.onMain,
          transform: 'rotate(-4deg)',
        }}
      >
        <Sparkles size={22} />
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography
          sx={{
            fontFamily: HAND_FONT,
            fontSize: 'clamp(1.125rem, 5vw, 1.5rem)',
            fontWeight: 700,
            lineHeight: 1.15,
            overflowWrap: 'break-word',
          }}
        >
          {copy.today}
        </Typography>
        <Typography variant="bodyMedium" color="text.secondary" sx={{ mt: 1 }}>
          {copy.todayHint}
        </Typography>
      </Box>
      <ArrowRight size={20} aria-hidden="true" />
    </Box>
  )
}

/** The AI paragraph stays before the cards (owner decision), but a long one is four lines
 * with "More", so the cards are never a long scroll away. */
function Summary({
  text,
  streaming,
  markdown,
  copy,
}: {
  text: string
  streaming: boolean
  markdown: boolean
  copy: ConversationCopy
}) {
  const [open, setOpen] = useState(false)
  const long = !streaming && text.length > 220
  const clamp =
    long && !open
      ? {
          display: '-webkit-box',
          WebkitLineClamp: 4,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }
      : {}
  return (
    <>
      {markdown ? (
        <RichText
          content={text}
          streaming={streaming}
          sx={{
            ...chalkWrite,
            ...(long && !open ? { maxHeight: '6.5em', overflow: 'hidden' } : {}),
          }}
        />
      ) : (
        <Typography variant="bodyLarge" sx={{ ...chalkWrite, ...clamp }}>
          {text}
        </Typography>
      )}
      {long && (
        <Button
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          sx={{ minHeight: 48, ml: -3 }}
        >
          {open ? copy.less : copy.more}
        </Button>
      )}
    </>
  )
}

function UserBubble({ text, copy }: { text: string; copy: ConversationCopy }) {
  const roles = useTheme().material
  return (
    <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
      <Typography
        className="c-send"
        sx={{
          maxWidth: '80%',
          px: 4,
          py: 2,
          borderRadius: '20px 20px 4px 20px',
          bgcolor: roles.primaryContainer,
          color: roles.onPrimaryContainer,
          overflowWrap: 'anywhere',
        }}
      >
        <Box component="span" sx={visuallyHidden}>
          {copy.you}:{' '}
        </Box>
        {text}
      </Typography>
    </Box>
  )
}

function AssistantTurn({
  turn,
  latest,
  copy,
  locale,
  line,
  transit,
  onSend,
  onRetry,
  onCancel,
  onManage,
}: {
  turn: Turn
  latest: boolean
  copy: ConversationCopy
  locale: Locale
  line: string
  transit: string
  onSend: (text: string, options?: { refine?: Refine }) => void
  onRetry: () => void
  onCancel: () => void
  onManage: () => void
}) {
  const roles = useTheme().material
  const t = askCopy(locale)
  const account = useCustomer()
  const accountCopy = accountCopyFor(locale)
  // Pins and cards are linked both ways: tap a pin, its card lights up; focus a card, its pin.
  const [selected, setSelected] = useState<MapSelection>(null)
  if (turn.kind === 'today')
    return (
      // The deck carries its own title ("Today near …"): no second heading above it.
      <Box className="c-receive" sx={{ mt: 2 }}>
        <TodayDeck place={turn.place} />
      </Box>
    )
  if (turn.status === 'thinking')
    return (
      <Box sx={{ mt: 4 }} aria-busy="true">
        <Stack direction="row" sx={{ alignItems: 'center', gap: 3, color: roles.onSurfaceVariant }}>
          <Box className="c-typing" aria-hidden="true">
            <span />
            <span />
            <span />
          </Box>
          <Typography
            key={line}
            className="c-rise"
            variant="bodyMedium"
            role="status"
            aria-live="polite"
          >
            {line || t.thinking[0]}
          </Typography>
        </Stack>
        <Box
          aria-hidden="true"
          sx={{
            mt: 4,
            display: 'grid',
            gridAutoFlow: 'column',
            gridAutoColumns: 'min(78vw, 272px)',
            gap: 3,
            overflow: 'hidden',
          }}
        >
          {[0, 1].map((n) => (
            <Box
              key={n}
              sx={{
                height: 240,
                borderRadius: '20px',
                bgcolor: roles.surfaceContainerLow,
                border: `1px solid ${roles.outlineVariant}`,
                p: 2,
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
              }}
            >
              <Box
                className="c-shimmer"
                sx={{ height: 120, borderRadius: '14px', bgcolor: roles.surfaceContainer }}
              />
              <Box
                className="c-shimmer"
                sx={{
                  height: 20,
                  width: '70%',
                  borderRadius: '6px',
                  bgcolor: roles.surfaceContainer,
                }}
              />
              <Box
                className="c-shimmer"
                sx={{
                  height: 16,
                  width: '45%',
                  borderRadius: '6px',
                  bgcolor: roles.surfaceContainer,
                }}
              />
            </Box>
          ))}
        </Box>
      </Box>
    )
  if (turn.status !== 'done' || !turn.answer)
    return (
      <Box
        role={turn.status === 'stopped' ? undefined : 'alert'}
        className="c-receive"
        sx={{
          mt: 4,
          p: 4,
          borderRadius: '16px',
          bgcolor: turn.status === 'stopped' ? roles.surfaceContainerLow : roles.errorContainer,
          color: turn.status === 'stopped' ? roles.onSurface : roles.onErrorContainer,
        }}
      >
        <Stack direction="row" sx={{ gap: 2, alignItems: 'center' }}>
          {turn.status === 'offline' && <WifiOff size={18} aria-hidden="true" />}
          <Typography variant="bodyMedium">
            {turn.status === 'offline'
              ? copy.offline
              : turn.status === 'stopped'
                ? copy.stopped
                : copy.failed}
          </Typography>
        </Stack>
        <Stack direction="row" sx={{ mt: 3, gap: 2 }}>
          <Button variant="contained" onClick={onRetry} sx={{ minHeight: 48 }}>
            {copy.retry}
          </Button>
          <Button onClick={onCancel} sx={{ minHeight: 48, color: 'inherit' }}>
            {copy.cancel}
          </Button>
        </Stack>
      </Box>
    )
  const answer = turn.answer
  if (answer.command?.kind === 'directions' && answer.command.maps_url) {
    return (
      <Box sx={{ mt: 4 }}>
        <Typography variant="titleLarge">{answer.command.shop_name}</Typography>
        <Button
          variant="contained"
          href={answer.command.maps_url}
          target="_blank"
          rel="noopener noreferrer"
          startIcon={<MapPin size={18} />}
          sx={{ mt: 2 }}
        >
          {discoverCopy(locale).maps}
        </Button>
      </Box>
    )
  }
  const intent = answer.intent
  const ours = answer.groups
    .filter((g) => g.id === 'for_you' || g.id === 'best')
    .flatMap((g) => g.places)
  const google = answer.groups
    .filter((g) => g.id === 'open' || g.id === 'more')
    .flatMap((g) => g.places)
    .slice(0, 3)
  const applied = [
    intent.sort === 'price' && copy.sortPrice,
    intent.sort === 'distance' && copy.sortDistance,
    intent.open_now && copy.openOnly,
    intent.deals && copy.dealsOnly,
    intent.near === 'transit' &&
      (answer.anchor ? fillIn(copy.nearStation, { station: answer.anchor.name }) : copy.noStation),
  ].filter(Boolean) as string[]
  const refinements: Chip[] = [
    intent.sort !== 'price' && { label: copy.cheaper, q: copy.cheaper, refine: 'price' as const },
    !intent.open_now && { label: copy.open, q: copy.open, refine: 'open' as const },
    intent.near !== 'transit' && { label: transit, q: transit, refine: 'transit' as const },
    !intent.deals && { label: copy.deals, q: copy.deals, refine: 'deals' as const },
  ].filter(Boolean) as Chip[]
  const followups: Chip[] = [
    ...refinements.slice(0, 3),
    ...(intent.followups ?? []).slice(0, 1).map((text) => ({ label: text, q: text })),
  ]
  const area = answer.area ?? null
  const nothing = ours.length === 0 && google.length === 0 && !(area?.status === 'ok')
  return (
    <Box sx={{ mt: 4 }}>
      <Summary
        text={
          nothing
            ? fillIn(copy.nothing, { q: intent.keywords?.join(' ') || turn.q })
            : answer.mode === 'ai' && intent.summary
              ? intent.summary
              : fillIn(copy.found, { place: turn.place.label })
        }
        streaming={!!turn.streaming}
        markdown={!nothing && answer.mode === 'ai' && !!intent.summary}
        copy={copy}
      />
      {applied.length > 0 && (
        <Typography variant="labelLarge" color="text.secondary" sx={{ mt: 1 }}>
          {applied.join(' · ')}
        </Typography>
      )}
      {nothing && (
        <Typography variant="bodyMedium" color="text.secondary" sx={{ mt: 1 }}>
          {copy.nothingHint}
        </Typography>
      )}
      {(answer.personal?.saved.length ?? 0) > 0 && (
        <Stack
          direction="row"
          role="status"
          sx={{ mt: 2, gap: 2, alignItems: 'center', flexWrap: 'wrap' }}
        >
          <Typography variant="labelLarge" color="text.secondary">
            {accountCopy.remembered.replace(
              '{items}',
              preferenceChips(account.profile, accountCopy, locale)
                .filter((chip) => answer.personal!.saved.includes(chip.key))
                .map((chip) => chip.label)
                .join(' · ') || answer.personal!.saved.join(' · '),
            )}
          </Typography>
          <Button onClick={onManage} sx={{ minHeight: 48 }}>
            {accountCopy.manage}
          </Button>
        </Stack>
      )}
      {/* Where first (a short map strip, pins numbered like the rows), then the list: our
          shops, then Google's, in one row shape that fits a 360px phone five to a screen. */}
      <AnswerMap
        answer={answer}
        ours={ours.slice(0, 8)}
        center={turn.place}
        locale={locale}
        selected={selected}
        onSelect={setSelected}
      />
      {ours.length > 0 && (
        <PickList label={fillIn(copy.found, { place: turn.place.label })}>
          {ours.slice(0, 8).map((pick, index) => (
            <PickCard
              key={pick.id}
              pick={pick}
              index={index}
              anchor={answer.anchor}
              copy={copy}
              locale={locale}
              selected={selected?.id === pick.id && selected.from === 'pin'}
              onFocusPin={() => setSelected({ id: pick.id, from: 'card' })}
            />
          ))}
        </PickList>
      )}
      {/* Google's area answer follows our shops, never above them. */}
      {area && <AreaAnswerCard area={area} locale={locale} />}
      {google.length > 0 && <GoogleRows places={google} copy={copy} locale={locale} />}
      {latest && (
        <>
          <Box
            component="ul"
            sx={{ listStyle: 'none', p: 0, m: 0, mt: 6, display: 'flex', flexWrap: 'wrap', gap: 2 }}
          >
            {followups.map((chip, index) => (
              <Box component="li" key={chip.label} sx={{ ...dealIn, '--deal-index': index + 2 }}>
                <Button
                  variant="outlined"
                  onClick={() => onSend(chip.q, chip)}
                  sx={{ minHeight: 48, borderRadius: 999, px: 4, py: 2 }}
                >
                  {chip.label}
                </Button>
              </Box>
            ))}
          </Box>
          <Button
            component="a"
            href="/explore/browse"
            onClick={customerNavigate}
            endIcon={<ArrowRight size={18} />}
            sx={{ mt: 4, minHeight: 48, ml: -3 }}
          >
            {t.browse}
          </Button>
        </>
      )}
    </Box>
  )
}
