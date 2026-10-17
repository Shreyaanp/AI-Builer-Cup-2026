import { chatBubbleStyle } from '../../coach/bubbleStyle'
import { photoCopy } from '../../coach/photoCopy'
import { photoHeaders, preparePhoto } from '../photoPrep'
import { PlainText, RichText } from '../../../design/RichText'
import { stripMarkdown } from '../../../design/markdownUtils'
import {
  isPhotoRoute,
  PHOTO_ROUTES,
  photoRouteCopy,
  type PhotoRoute,
} from '../../coach/photoRouteCopy'
import { CloseDay, type Kind as DayKind } from '../../closeday/CloseDay'
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent, ReactElement } from 'react'
import {
  Alert,
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  Menu,
  MenuItem,
  Stack,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material'
import {
  ArrowUp,
  Camera,
  History,
  ImagePlus,
  ImageUp,
  FileSpreadsheet,
  Layers,
  Paperclip,
  Leaf,
  MessageSquare,
  MessageSquarePlus,
  Mic,
  PackagePlus,
  Share2,
  Square,
  Store,
  Tag,
  Volume2,
  VolumeX,
  ZapOff,
} from 'lucide-react'
import { visuallyHidden } from '@mui/utils'
import { CoachChart, type CoachChartData } from '../CoachChart'
import { RateLimitError, streamCoach, TooSlowError, TURN_IDLE_MS } from '../../../api/stream'
import type { CoachEvent } from '../../../api/stream'
import { useIdentity } from '../../../auth/useIdentity'
import { useLocale } from '../../../state/hooks'
import { ApiError } from '../api'
import type { Conversation, PhotoResult, Proposal } from '../api'
import { defaultCurrency } from '../format'
import { useCopy } from '../strings'
import { Sheet } from '../Sheet'
import { useBackClose } from '../backStack'
import { ConnectSheet } from '../../connect/ConnectSheet'
import { useConnectCopy } from '../../connect/strings'
import { SalesImportSheet } from '../ImportMenu'
import { DOCUMENT_ACCEPT, useImport, type SalesImport } from '../useImport'
import { StartCard } from '../ShopCard'
import { TourOffer } from '../../tour/Tour'
import { ShopSheets } from '../ShopTiles'
import { NeedsPill, TodayView, type TodayActions } from '../today/TodayView'
import type { ShopSheetKind } from '../ShopTiles'
import { useUnread } from '../useUnread'
import { useVoice } from '../useVoice'
import { useOnboardingCopy } from '../onboardingCopy'
import { useSpokenReveal } from '../useSpokenReveal'
import { cardWords, mergeTranscript } from '../speechReveal'
import { useOnline } from '../useOnline'
import { useWorkspace } from '../workspaceContext'
import { OwnerJourney } from '../../frontdoors/OwnerJourney'
import { LoadError } from '../LoadError'
import { enterRise, shape } from '../../../design/theme'
import { useSourcingCopy } from '../../sourcing/copy'
import { OrdersSheet } from '../../sourcing/Orders'
import { useReceiveOrder } from '../../sourcing/orderData'
import { OrderCard, SearchingSuppliers, SupplierCarousel } from '../../sourcing/SourcingCards'
import type { Order, SupplierResult } from '../../sourcing/types'
import { PurchaseOrderCard } from '../../supply/PurchaseOrderCard'
import { RulesChangeCard } from '../../supply/Supply'
import type { PurchaseOrder, Relationship } from '../../supply/types'
import { utter } from '../phoneVoice'
import { useLanguageSwitch } from '../languageSwitch'
import { ActionChip, MenuLinkChip, ReplyCard } from '../CoachActions'
import { useNextStepsCopy } from '../nextStepsCopy'
import { asCoachAction, NEEDS_TAP, type CoachAction } from '../coachAction'
import type { Destination } from '../workspaceContext'
import { GuideChips } from '../../owner-tools/CoachGuide'
import { openOwnerFeature } from '../../owner-tools/entry'
import { PaymentCard } from '../../owner-tools/PaymentsScreen'
import type { PaymentLink } from '../../owner-tools/links'

const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp']
// The composer grows with multi-line text up to this many lines, then scrolls.
const COMPOSER_ROWS = 6
type Message =
  | { role: 'user' | 'assistant'; text: string }
  // Sourcing cards live in the conversation; an order card always shows the order's latest state.
  | { role: 'suppliers'; result: SupplierResult; key: string }
  | { role: 'order'; orderId: string }
  // Supply chain: a purchase order (always its latest state) and a supplier rule change.
  | { role: 'po'; poId: string }
  | { role: 'rules'; row: Relationship; key: string }
  // A chart beside a forecast or "how is business" answer.
  | { role: 'chart'; chart: CoachChartData; key: string }
  // An app action the coach prepared: a screen it opened, or a customer reply to send.
  | { role: 'action'; action: CoachAction; key: string }
  | { role: 'payment'; payment: PaymentLink; key: string }
  // A menu item the coach changed; the link shows once the owner saved that proposal.
  | { role: 'menuLink'; proposalId: string; item: string; key: string }
/** Cards a spoken reply refers to: shown when the voice reaches them, not before. */
const SPOKEN_CARDS = new Set<CoachEvent['kind']>([
  'proposal',
  'suppliers',
  'chart',
  'order',
  'action',
  'workflow',
  'payment_link',
])
// Coach actions that open a My shop sheet.
const SHEETS: Partial<Record<CoachAction['target'], ShopSheetKind>> = {
  messages: 'messages',
  share: 'customer',
  sold_out: 'soldOut',
  menu: 'menu',
  details: 'details',
  // The shop icon card sits at the top of the details sheet.
  icon: 'details',
  stamps: 'details',
  plan: 'plan',
  games: 'customer',
}
const DESTINATIONS: Partial<Record<CoachAction['target'], Destination>> = {
  today: 'coach',
  shop: 'shop',
  grow: 'grow',
  you: 'you',
  trust: 'you',
  games: 'grow',
  close_day: 'grow',
  google: 'google',
  privacy: 'privacy',
  supply: 'grow',
  // The playbook sheet lives under Your data.
  playbook: 'privacy',
  // Payments & rides opens over Grow, so Back returns there.
  payments: 'grow',
}
const REPLY_POLL_MS = 1500
const REPLY_WAIT_MS = 45_000

/** A shop photo the owner may later choose to show customers (offered once, never automatic). */
export type GalleryPhoto = { file: File; businessId: string }

// The extraction file survives a new shop's approval (the flow hands it over with the new ID).
// It stays local to this coach workspace and never enters preference storage.
export function CoachWorkspace({
  galleryPhoto,
  setGalleryPhoto,
}: {
  galleryPhoto: GalleryPhoto | null
  setGalleryPhoto: (value: GalleryPhoto | null) => void
}) {
  const t = useCopy()
  const { activeId, loading, loadError } = useWorkspace()
  if (loading) return <CircularProgress aria-label={t.loading} sx={{ m: 3 }} />
  if (loadError) return <LoadError />
  return (
    <CoachScreen key={activeId} galleryPhoto={galleryPhoto} setGalleryPhoto={setGalleryPhoto} />
  )
}

function CoachScreen({
  galleryPhoto,
  setGalleryPhoto,
}: {
  galleryPhoto: GalleryPhoto | null
  setGalleryPhoto: (value: GalleryPhoto | null) => void
}) {
  const t = useCopy()
  const o = useOnboardingCopy()
  const theme = useTheme()
  const roles = theme.material
  const identity = useIdentity()
  const language = useLocale()
  const switchLanguage = useLanguageSwitch()
  const photoText = photoCopy(language)
  const ws = useWorkspace()
  // Hidden behind the full-screen new-shop flow: no voice, no pickers, no draft prompts.
  const visible = !ws.creatingShop && !ws.newShopReady
  const [messages, setMessages] = useState<Message[]>([])
  const [showToday, setShowToday] = useState(false)
  const [reply, setReply] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<'idle' | 'reply' | 'photo'>('idle')
  const [error, setError] = useState('')
  const [photoPin, setPhotoPin] = useState<Proposal | null>(null)
  const online = useOnline()
  const [reconnecting, setReconnecting] = useState(false)
  const [mode, setMode] = useState<'offline' | 'gemini' | null>(null)
  const [history, setHistory] = useState<Conversation[]>([])
  const s = useSourcingCopy()
  // Sourcing: the item being searched for, every order shown in the chat, the open thread.
  const [searching, setSearching] = useState<string | null>(null)
  const [orders, setOrders] = useState<Record<string, Order>>({})
  const [pos, setPos] = useState<Record<string, PurchaseOrder>>({})
  const [thread, setThread] = useState<string | null>(null)
  const watching = useRef(new Set<string>())
  const receiveOrder = useReceiveOrder()
  // My shop sheets opened from suggestion chips.
  const [shopSheet, setShopSheet] = useState<ShopSheetKind | null>(null)
  const [closeDayOpen, setCloseDayOpen] = useState(false)
  const menuLinks = useRef<Message[]>([])
  // The menu item a "See … in your menu" link opened the menu at.
  const [menuFocus, setMenuFocus] = useState<string | null>(null)
  const next = useNextStepsCopy()
  const { unread, refresh: refreshUnread } = useUnread()
  const messageInput = useRef<HTMLTextAreaElement>(null)
  const session = useRef<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  const photoController = useRef<AbortController | null>(null)
  const alive = useRef(false)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      controller.current?.abort()
      photoController.current?.abort()
      speechSynthesis.cancel()
      speaking.current?.pause()
    }
  }, [])
  const photoInput = useRef<HTMLInputElement>(null)
  const photoButton = useRef<HTMLButtonElement>(null)
  // One attach button: Take photo (phones: there is no camera capture on a desktop), Photo
  // library, and Document (PDF/Excel/CSV, once there is a shop to import into).
  const touch = useMediaQuery('(pointer: coarse)')
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const [photoMenu, setPhotoMenu] = useState<HTMLElement | null>(null)
  const [sales, setSales] = useState<SalesImport | null>(null)
  const [connectOpen, setConnectOpen] = useState(false)
  const connectCopy = useConnectCopy()
  // A chat photo waiting for the owner's one-line confirmation (kept until they choose).
  const [sorting, setSorting] = useState<{ file: File; guess: PhotoRoute | null } | null>(null)
  const [dayPhoto, setDayPhoto] = useState<{ kind: DayKind; file: File } | null>(null)
  const routeText = photoRouteCopy(language)
  const importer = useImport({ onSales: setSales })
  const picking = useRef<'photo' | 'document'>('photo')
  const choices = touch || Boolean(ws.active)
  function choosePhoto(anchor: HTMLElement | null) {
    if (choices && anchor) setPhotoMenu(anchor)
    else pick('library')
  }
  // One file input for every choice (`capture` opens the rear camera directly, `accept` picks
  // photos or documents), so the page keeps a single picker.
  function pick(kind: 'camera' | 'library' | 'document') {
    setPhotoMenu(null)
    const input = photoInput.current
    if (!input) return
    picking.current = kind === 'document' ? 'document' : 'photo'
    input.accept = kind === 'document' ? DOCUMENT_ACCEPT : PHOTO_TYPES.join(',')
    if (kind === 'camera') input.setAttribute('capture', 'environment')
    else input.removeAttribute('capture')
    input.click()
  }
  const speaking = useRef<HTMLAudioElement | null>(null)
  const end = useRef<HTMLDivElement>(null)
  const { api, activeId, review, setFaceOpen, go, speakReplies } = ws
  // One "+" sheet (opened from the top bar) holds every coach action: add shop/product, new
  // chat, earlier chats.
  const actionsOpen = ws.coachActions && visible
  const setActionsOpen = ws.setCoachActions

  const receive = useCallback(
    (event: CoachEvent) => {
      switchLanguage(event)
      if (event.kind === 'ready') {
        session.current = event.session_id ?? session.current
        setMode(event.mode ?? 'offline')
        if (event.code === 'CONVERSATION_ROLLED_OVER')
          setMessages((items) => [...items, { role: 'assistant', text: t.conversationRolledOver }])
      }
      if (event.kind === 'delta') setReply((text) => text + (event.text ?? ''))
      if (event.kind === 'reply' || event.kind === 'output_transcript') setReply(event.text ?? '')
      if (event.kind === 'input_transcript') {
        setShowToday(false)
        setMessages((items) => [...items, { role: 'user', text: event.text ?? '' }])
      }
      if (event.kind === 'proposal') {
        const proposal = event.data as unknown as Proposal
        review(proposal)
        // E.g. after "per cup or per pot?": once saved, one tap shows the item in the menu.
        const items = proposal.snapshot?.kind === 'inventory' ? proposal.snapshot.products : []
        // The links follow the coach's words, so they wait for the end of the turn.
        if (items.length > 0 && items.length <= 3)
          menuLinks.current.push(
            ...items.map((product) => ({
              role: 'menuLink' as const,
              proposalId: proposal.id,
              item: product.name,
              key: crypto.randomUUID(),
            })),
          )
      }
      if (event.kind === 'payment_link' && event.data) {
        const payment = event.data as unknown as PaymentLink
        setMessages((items) =>
          [...items, { role: 'payment' as const, payment, key: crypto.randomUUID() }].slice(-40),
        )
      }
      if (event.kind === 'sourcing') setSearching(String(event.data?.item ?? ''))
      if (event.kind === 'suppliers') {
        setSearching(null)
        const result = event.data as unknown as SupplierResult
        setMessages((items) =>
          [...items, { role: 'suppliers' as const, result, key: crypto.randomUUID() }].slice(-40),
        )
      }
      if (event.kind === 'chart' && event.data) {
        const chart = event.data as unknown as CoachChartData
        setMessages((items) =>
          [...items, { role: 'chart' as const, chart, key: crypto.randomUUID() }].slice(-40),
        )
      }
      if (event.kind === 'order') {
        const order = event.data as unknown as Order
        setOrders((known) => ({ ...known, [order.id]: order }))
        // One card per order, moved to the end when the coach updates it.
        setMessages((items) =>
          [
            ...items.filter((item) => !(item.role === 'order' && item.orderId === order.id)),
            { role: 'order' as const, orderId: order.id },
          ].slice(-40),
        )
      }
      if (event.kind === 'action') {
        const action = asCoachAction(event.data)
        if (action) {
          setMessages((items) =>
            [...items, { role: 'action' as const, action, key: crypto.randomUUID() }].slice(-40),
          )
          // Screens open at once (everything by voice); pickers and Send wait for a tap.
          if (!NEEDS_TAP.has(action.target)) {
            setShowToday(action.target === 'today')
            const sheet = SHEETS[action.target]
            if (action.target === 'games') go('grow')
            if (action.target === 'connect') setConnectOpen(true)
            if (sheet) setShopSheet(sheet)
            else if (DESTINATIONS[action.target]) go(DESTINATIONS[action.target]!)
            if (action.target === 'payments') openOwnerFeature('payments')
          }
        }
      }
      if (event.kind === 'purchase_order') {
        const po = event.data as unknown as PurchaseOrder
        setPos((known) => ({ ...known, [po.id]: po }))
        setMessages((items) =>
          [
            ...items.filter((item) => !(item.role === 'po' && item.poId === po.id)),
            { role: 'po' as const, poId: po.id },
          ].slice(-40),
        )
      }
      if (event.kind === 'supply_rules') {
        const row = event.data as unknown as Relationship
        setMessages((items) =>
          [...items, { role: 'rules' as const, row, key: crypto.randomUUID() }].slice(-40),
        )
      }
      if (event.kind === 'turn_complete') setSearching(null)
      if (event.kind === 'workflow' && event.data?.status === 'verification_required') {
        go('you')
        setFaceOpen(true)
      }
    },
    [review, go, setFaceOpen, t.conversationRolledOver, switchLanguage],
  )
  const restored = useRef<Promise<unknown>>(Promise.resolve())
  /** The coach's reply text (if any), then the menu links its proposals earned so far. */
  const addReply = useCallback((text: string) => {
    const links = menuLinks.current
    menuLinks.current = []
    if (!text && !links.length) return
    setMessages((items) =>
      [...items, ...(text ? [{ role: 'assistant' as const, text }] : []), ...links].slice(-40),
    )
  }, [])
  // The spoken reply appears word by word as it is said; its cards when the voice reaches them.
  const playback = useRef<() => number>(() => 0)
  const reveal = useSpokenReveal({
    remaining: () => {
      const seconds = playback.current()
      return seconds > 0 ? seconds * 1000 : null
    },
    reducedMotion,
    onDone: addReply,
    // Menu links still waiting (the reply ended at the card) show at the end of the turn.
    onEnd: () => addReply(''),
  })
  const voice = useVoice(activeId, (event) => {
    if (event.kind === 'output_transcript' || event.kind === 'reply' || event.kind === 'delta') {
      const heard = reveal.heard()
      reveal.push(
        event.kind === 'delta'
          ? heard + (event.text ?? '')
          : mergeTranscript(heard, event.text ?? ''),
      )
      return
    }
    if (SPOKEN_CARDS.has(event.kind)) {
      // Words said before the card stay above it; the rest of the reply continues below.
      reveal.cue(() => {
        addReply(reveal.split())
        receive(event)
      }, cardWords(event.data))
      return
    }
    if (event.kind === 'input_transcript' && reveal.active()) {
      // The owner is talking: what the coach already said stays, in order, above it.
      addReply(reveal.cut())
    }
    if (event.kind === 'interrupted') addReply(reveal.cut())
    if (event.kind === 'ready') reveal.flush()
    receive(event)
    if (event.kind === 'turn_complete') reveal.finish()
  })
  useEffect(() => {
    playback.current = voice.playbackRemaining
  })
  /** Stop: the voice and its words stop together; only what was said stays. */
  function stopTalking() {
    addReply(reveal.cut())
    voice.stop()
  }
  const stopVoice = voice.stop
  useEffect(() => {
    if (!visible) {
      controller.current?.abort()
      stopVoice()
    }
  }, [visible, stopVoice])

  // Each shop has its own conversation thread.
  useEffect(() => {
    const abort = new AbortController()
    controller.current?.abort()
    session.current = null
    // The mic waits for this before connecting, so voice joins the restored conversation; the
    // button itself stays enabled (no disabled flash while history loads).
    restored.current = api<Conversation[]>('/conversations', { signal: abort.signal })
      .then(async (items) => {
        if (abort.signal.aborted) return
        setHistory(items)
        // Coming back (reload, another day) continues this shop's latest conversation instead of
        // a blank screen. Once per visit: "New chat" still starts fresh.
        const latest = items.find((entry) => (entry.business_id ?? null) === activeId)
        if (latest && !session.current) await restore(latest.session_id)
      })
      .catch(() => undefined)
    return () => {
      abort.abort()
      speechSynthesis.cancel()
      speaking.current?.pause()
    }
    // `restore` is a plain function re-created each render; this runs once per shop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, activeId])
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end', behavior: reducedMotion ? 'instant' : 'smooth' })
  }, [messages, reply, reveal.shown, reducedMotion])
  const revealReply = useEffectEvent(() => {
    if (visible && (messages.length || reply || reveal.shown))
      end.current?.scrollIntoView({ block: 'end', behavior: 'instant' })
  })
  useEffect(() => {
    const scroller = end.current?.parentElement
    if (!scroller) return
    const observer = new ResizeObserver(() => revealReply())
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [])
  // The composer is one line until the text itself needs more. Sized from the text only: the
  // old autosize also measured the placeholder, so a long translated hint made an empty
  // composer two or three lines tall (B3).
  useLayoutEffect(() => {
    const field = messageInput.current
    if (!field) return
    const base = language === 'ta' ? 56 : 48
    field.style.height = `${base}px`
    if (note) field.style.height = `${Math.max(base, field.scrollHeight)}px`
  }, [note, voice.state, language])
  // A pending request (e.g. "Start from a photo" on My shop) opens the chooser once, from the
  // composer's photo button.
  const { photoPending, consumePhotoRequest } = ws
  useEffect(() => {
    if (!photoPending || !visible) return
    consumePhotoRequest()
    if (choices && photoButton.current) setPhotoMenu(photoButton.current)
    else {
      photoInput.current?.removeAttribute('capture')
      photoInput.current?.click()
    }
  }, [photoPending, consumePhotoRequest, choices, visible])
  // A chat starter from My shop ("Customers ask: halal?") lands in the composer once.
  const { coachDraft, consumeCoachDraft } = ws
  const [seenDraft, setSeenDraft] = useState<string | null>(null)
  if (visible && coachDraft !== seenDraft) {
    setSeenDraft(coachDraft)
    if (coachDraft !== null) setNote(coachDraft)
  }
  const sendDraft = useEffectEvent((text: string) => {
    void send(text)
  })
  const { coachDraftSend } = ws
  useEffect(() => {
    // A guide chip can be tapped while the previous reply/voice turn is finishing.
    // Keep its sentence queued until send() can accept it.
    if (coachDraft === null || !visible || busy !== 'idle' || voice.state !== 'idle') return
    consumeCoachDraft()
    if (coachDraftSend) sendDraft(coachDraft)
    else messageInput.current?.focus()
  }, [coachDraft, coachDraftSend, consumeCoachDraft, visible, busy, voice.state])

  // A typed draft: Back asks "Discard changes?" before leaving, and so does closing the tab.
  useBackClose(
    visible && Boolean(note.trim()),
    () => {
      setNote('')
      window.history.back()
    },
    true,
  )

  function resetThread() {
    setShowToday(false)
    controller.current?.abort()
    reveal.discard()
    voice.stop()
    session.current = null
    setSearching(null)
    setMessages([])
    setReply('')
    setError('')
  }

  // Natural Google voice for replies; the phone's own voice if that isn't available.
  async function speakReply(text: string) {
    speechSynthesis.cancel()
    speaking.current?.pause()
    const cleanText = stripMarkdown(text)
    try {
      const response = await api<Response>('/tts', {
        method: 'POST',
        body: JSON.stringify({ text: cleanText, language }),
        raw: true,
      })
      if (response.status === 200) {
        const url = URL.createObjectURL(await response.blob())
        const audio = new Audio(url)
        audio.onended = () => URL.revokeObjectURL(url)
        speaking.current = audio
        await audio.play()
        return
      }
    } catch {
      // Fall through to on-device speech.
    }
    const utterance = utter(cleanText, language)
    speechSynthesis.speak(utterance)
  }

  async function send(text = note) {
    const message = text.trim()
    if (!message || busy !== 'idle' || voice.state !== 'idle') return
    setShowToday(false)
    const abort = new AbortController()
    controller.current = abort
    setBusy('reply')
    setReply('')
    setError('')
    setMessages((items) => [...items, { role: 'user' as const, text: message }].slice(-40))
    setNote('')
    let finalReply = ''
    let proposed = false
    try {
      await streamCoach(
        {
          message,
          language,
          currency: defaultCurrency(),
          session_id: session.current,
          business_id: activeId,
        },
        abort.signal,
        (event) => {
          receive(event)
          if (event.kind === 'delta') finalReply += event.text ?? ''
          if (event.kind === 'reply') finalReply = event.text ?? ''
          if (event.kind === 'proposal') proposed = true
        },
        identity.getToken,
        (state) => setReconnecting(state === 'reconnecting'),
        // No word for this long: thinking stops with "took too long" and the message to resend.
        TURN_IDLE_MS,
      )
      if (controller.current !== abort) return
      // The model occasionally returns an empty turn; treat it like a failed reply so the
      // owner sees why and can resend, instead of an empty bubble.
      if (!finalReply.trim() && !proposed) throw new Error('EMPTY_REPLY')
      addReply(finalReply.trim() ? finalReply : '')
      setReply('')
      if (speakReplies && finalReply) void speakReply(finalReply)
      // History is supplemental; a failed refresh must never roll back a completed turn.
      const items = await api<Conversation[]>('/conversations').catch(() => null)
      if (items && controller.current === abort) setHistory(items)
    } catch (cause) {
      if (!abort.signal.aborted) {
        setError(
          cause instanceof TooSlowError
            ? o.tooSlow
            : cause instanceof RateLimitError
              ? t.rateLimited
              : t.replyFailed,
        )
        // Keep the unsent message available for a retry.
        setMessages((items) => items.slice(0, -1))
        setNote(message)
      }
    } finally {
      if (controller.current === abort) {
        controller.current = null
        setBusy('idle')
        setSearching(null)
        setReconnecting(false)
      }
    }
  }

  const orderPath = (id: string) =>
    `/businesses/${encodeURIComponent(activeId ?? '')}/orders/${encodeURIComponent(id)}`

  // After Send, wait for the supplier's answer and announce it in this conversation.
  async function watchReply(order: Order) {
    if (watching.current.has(order.id)) return
    watching.current.add(order.id)
    const before = order.messages.filter((message) => message.author === 'supplier').length
    const until = Date.now() + REPLY_WAIT_MS
    try {
      while (Date.now() < until) {
        await new Promise((resolve) => window.setTimeout(resolve, REPLY_POLL_MS))
        const latest = await api<Order>(orderPath(order.id)).catch(() => null)
        if (!latest) continue
        setOrders((known) => ({ ...known, [latest.id]: latest }))
        const replies = latest.messages.filter((message) => message.author === 'supplier')
        if (replies.length > before) {
          const reply = replies[replies.length - 1]!
          const text = s.replied(latest.supplier.name, reply.text)
          setMessages((items) => [...items, { role: 'assistant' as const, text }].slice(-40))
          if (speakReplies) void speakReply(text)
          void api(`${orderPath(latest.id)}/read`, { method: 'POST' }).catch(() => undefined)
          return
        }
      }
    } finally {
      watching.current.delete(order.id)
    }
  }

  function openAction(action: CoachAction) {
    setShowToday(action.target === 'today')
    if (action.target === 'games') go('grow')
    if (action.target === 'connect') setConnectOpen(true)
    if (action.target === 'photo') pick('library')
    else if (action.target === 'import') pick('document')
    else if (action.target === 'reply') return
    else if (SHEETS[action.target]) setShopSheet(SHEETS[action.target]!)
    else if (DESTINATIONS[action.target]) go(DESTINATIONS[action.target]!)
    if (action.target === 'payments') openOwnerFeature('payments')
  }
  async function sendReply(action: CoachAction): Promise<boolean> {
    if (!activeId || !action.thread_id || !action.text) return false
    try {
      await api(`/businesses/${activeId}/inquiries/${action.thread_id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ text: action.text }),
      })
      refreshUnread()
      return true
    } catch {
      return false
    }
  }
  async function sendOrder(order: Order): Promise<boolean> {
    setError('')
    try {
      const sent = await api<Order>(`${orderPath(order.id)}/send`, {
        method: 'POST',
        body: JSON.stringify({ version: order.version }),
      })
      setOrders((known) => ({ ...known, [sent.id]: sent }))
      void watchReply(sent)
      return true
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.code === 'ADD_SHOP_PHONE' ? s.addPhone : s.sendFailed,
      )
      return false
    }
  }

  async function discardOrder(order: Order) {
    try {
      const dropped = await api<Order>(`${orderPath(order.id)}/discard`, {
        method: 'POST',
        body: JSON.stringify({ version: order.version }),
      })
      setOrders((known) => ({ ...known, [dropped.id]: dropped }))
    } catch {
      setError(t.actionFailed)
    }
  }

  // A photo in the normal chat: Gemini says what it shows, the owner confirms (or corrects) in one
  // line, then it goes to the existing action. Before a shop exists the photo starts one directly.
  async function receivePhoto(file: File) {
    if (busy !== 'idle') return
    setError('')
    if (!PHOTO_TYPES.includes(file.type) || file.size > 20_000_000) {
      setError(t.photoType)
      return
    }
    if (!activeId) return uploadPhoto(file)
    setBusy('photo')
    setSorting(null)
    const operation = new AbortController()
    photoController.current = operation
    let guess: PhotoRoute | null = null
    try {
      const result = await api<{ kind: string }>('/photos/classify', {
        method: 'POST',
        body: file,
        headers: { 'Content-Type': file.type },
        signal: AbortSignal.any([operation.signal, AbortSignal.timeout(60_000)]),
      })
      if (isPhotoRoute(result.kind)) guess = result.kind
    } catch (cause) {
      if (!alive.current || operation.signal.aborted) return
      if (cause instanceof ApiError && cause.status === 429) setError(t.rateLimited)
      else if (cause instanceof ApiError && cause.code === 'PHOTO_BLOCKED') {
        setError(t.photoRefused)
        return
      }
      // Any other failure: nobody guesses; the photo stays and the owner picks.
    } finally {
      setBusy('idle')
      if (photoInput.current) photoInput.current.value = ''
    }
    if (alive.current && !operation.signal.aborted) setSorting({ file, guess })
  }

  function routePhoto(kind: PhotoRoute) {
    if (!sorting) return
    const { file } = sorting
    setSorting(null)
    if (kind === 'receipt') setDayPhoto({ kind: 'delivery', file })
    else if (kind === 'till') setDayPhoto({ kind: 'sales', file })
    else if (kind === 'shop_photo' && activeId) setGalleryPhoto({ file, businessId: activeId })
    else void uploadPhoto(file)
  }

  async function uploadPhoto(picked: File) {
    let file = picked
    if (busy !== 'idle') return
    setError('')
    if (!PHOTO_TYPES.includes(file.type) || file.size > 20_000_000) {
      setError(t.photoType)
      return
    }
    setBusy('photo')
    const operation = new AbortController()
    photoController.current = operation
    setGalleryPhoto(null)
    try {
      // Shrunk on the phone first: the spinner is already up, the upload is a fraction of the bytes.
      const photo = await preparePhoto(file)
      if (!alive.current || operation.signal.aborted) return
      file = photo.file
      // A new shop takes the phone region's currency; an existing shop keeps its own.
      const query = activeId
        ? `?business_id=${encodeURIComponent(activeId)}`
        : `?currency=${defaultCurrency()}`
      // The notes about anything unclear come back in the owner's language.
      const result = await api<PhotoResult>(`/photos${query}&language=${language}`, {
        method: 'POST',
        body: file,
        headers: photoHeaders(photo),
        signal: AbortSignal.any([operation.signal, AbortSignal.timeout(60_000)]),
      })
      if (!alive.current || operation.signal.aborted) return
      const uncertain = Array.isArray(result?.extraction?.uncertain)
        ? result.extraction.uncertain.filter((note): note is string => typeof note === 'string')
        : []
      const notes = uncertain.slice(0, 3).join(' · ')
      setPhotoPin(result?.pin_proposal ?? null)
      const businessId = activeId ?? result?.proposal?.snapshot?.business_id
      if (
        businessId &&
        ['storefront', 'signboard', 'menu', 'price_list'].includes(result?.photo_kind ?? '')
      )
        setGalleryPhoto({ file, businessId })
      setMessages((items) =>
        [
          ...items,
          {
            role: 'assistant' as const,
            text: result?.proposal ? t.photoRead + (notes ? `\n${notes}` : '') : t.photoNothing,
          },
        ].slice(-40),
      )
      // The review sheet carries the reader's doubts, so the decision surface discloses them.
      if (result?.proposal) review({ ...result.proposal, photo_notes: uncertain.slice(0, 5) })
    } catch (cause) {
      const code = cause instanceof ApiError ? cause.code : ''
      setError(
        cause instanceof ApiError && cause.status === 429
          ? t.rateLimited
          : code === 'PHOTO_BLOCKED' || code === 'NOT_BUSINESS_PHOTO'
            ? t.photoRefused
            : t.photoFailed,
      )
    } finally {
      setBusy('idle')
      if (photoInput.current) photoInput.current.value = ''
    }
  }

  async function restore(id: string) {
    setShowToday(false)
    setActionsOpen(false)
    reveal.discard()
    voice.stop()
    try {
      const data = await api<{ messages: Message[] }>(`/conversations/${id}`)
      controller.current?.abort()
      session.current = id
      setMessages(data.messages)
      setReply('')
    } catch {
      setError(t.actionFailed)
    }
  }

  const shopHistory = history.filter((entry) => (entry.business_id ?? null) === activeId)
  // A typed reply streams as tokens; a spoken one appears as it is said.
  const liveReply = reply || reveal.shown
  const empty = messages.length === 0 && !liveReply
  // Suggestion chips are rules only (no AI): they come from the current shop state, never a
  // fixed list, and at most three show. Each one either opens the right sheet or starts a note.
  type Suggestion = 'reply' | 'menu' | 'soldOut' | 'price' | 'share' | 'photo' | 'name'
  const shop = ws.active
  const rules: [Suggestion, boolean][] = shop
    ? [
        // On an empty thread the pending card already says customers are waiting.
        ['reply', Boolean(unread) && !empty],
        ['menu', ws.products.length === 0],
        ['soldOut', ws.products.length > 0],
        ['price', ws.products.length > 0],
        ['share', !shop.public],
      ]
    : [
        ['photo', true],
        ['name', true],
      ]
  const chipCopy: Record<Suggestion, { label: string; icon: ReactElement }> = {
    reply: { label: t.chipReply(unread ?? 0), icon: <MessageSquare size={18} /> },
    menu: { label: t.chipAddMenu, icon: <ImagePlus size={18} /> },
    soldOut: { label: t.chipSoldOut, icon: <ZapOff size={18} /> },
    price: { label: t.chipPrice, icon: <Tag size={18} /> },
    share: { label: t.chipShare, icon: <Share2 size={18} /> },
    photo: { label: t.chipBoardPhoto, icon: <ImagePlus size={18} /> },
    name: { label: t.chipShopName, icon: <Store size={18} /> },
  }
  const suggestions = rules
    .filter(([, applies]) => applies)
    .slice(0, 3)
    .map(([id]) => ({ id, ...chipCopy[id] }))
  function suggest(id: Suggestion, anchor: HTMLElement) {
    if (id === 'reply') setShopSheet('messages')
    else if (id === 'soldOut') setShopSheet('soldOut')
    else if (id === 'share') setShopSheet('customer')
    else if (id === 'menu' || id === 'photo') choosePhoto(anchor)
    else {
      setNote(`${id === 'price' ? t.chipPrice : t.fields.name}: `)
      messageInput.current?.focus()
    }
  }
  const chips = (
    <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 2 }}>
      {suggestions.map((item) => (
        <Chip
          key={item.label}
          icon={item.icon}
          label={item.label}
          variant="outlined"
          onClick={(event) => suggest(item.id, event.currentTarget)}
          sx={{
            height: 48,
            px: 1,
            borderColor: roles.outlineVariant,
            '& .MuiChip-icon': { color: roles.primary },
            ...enterRise,
          }}
        />
      ))}
    </Stack>
  )
  const today: TodayActions = {
    unread,
    ask: (text) => void send(text),
    draft: (text) => {
      setNote(text)
      messageInput.current?.focus()
    },
    openMessages: () => setShopSheet('messages'),
    openSoldOut: () => setShopSheet('soldOut'),
    talk: () => void restored.current.then(() => voice.start(session.current)),
    openCloseDay: () => setCloseDayOpen(true),
  }
  const lastIsReply =
    messages.at(-1)?.role === 'assistant' && !liveReply && !reveal.active() && busy === 'idle'
  const canSend = Boolean(note.trim()) && busy === 'idle' && voice.state === 'idle'
  const voiceText =
    voice.state === 'recording' ? t.listening : voice.state === 'replying' ? t.speaking : ''

  return (
    <Box
      id={visible ? 'coach' : undefined}
      component="section"
      aria-label={t.navCoach}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        maxWidth: 760,
        mx: 'auto',
      }}
    >
      {!ws.active && <OwnerJourney />}
      {/* One quiet line: which coach is answering. Every other action is behind the top bar's +. */}
      {!empty && (
        <Typography
          variant="labelMedium"
          color="text.secondary"
          noWrap
          sx={{ display: 'block', minHeight: 32, pt: 2 }}
        >
          {mode ? (mode === 'gemini' ? t.geminiMode : t.offlineMode) : ''}
        </Typography>
      )}
      <Sheet
        open={actionsOpen}
        onClose={() => setActionsOpen(false)}
        titleId="coach-actions-title"
        title={t.newChat}
        dismissInActions
        actions={<Button onClick={() => setActionsOpen(false)}>{t.cancel}</Button>}
      >
        <Stack spacing={1} sx={{ alignItems: 'flex-start' }}>
          <Button
            startIcon={<Store size={18} />}
            onClick={() => {
              setActionsOpen(false)
              ws.startNewShop()
            }}
          >
            {t.addShop}
          </Button>
          {ws.active && (
            <Button
              startIcon={<PackagePlus size={18} />}
              onClick={() => {
                setActionsOpen(false)
                ws.openEditor({ kind: 'product', product: null })
              }}
            >
              {t.addProduct}
            </Button>
          )}
          <Button
            startIcon={<MessageSquarePlus size={18} />}
            disabled={empty}
            onClick={() => {
              setActionsOpen(false)
              resetThread()
            }}
          >
            {t.newChat}
          </Button>
        </Stack>
        {shopHistory.length > 0 && (
          <List
            dense
            subheader={
              <ListSubheader sx={{ bgcolor: 'transparent', px: 0, lineHeight: '36px' }}>
                {t.history}
              </ListSubheader>
            }
            sx={{ mt: 4 }}
          >
            {shopHistory.map((entry) => (
              <ListItemButton key={entry.session_id} onClick={() => void restore(entry.session_id)}>
                <ListItemIcon sx={{ minWidth: 36 }}>
                  <History size={18} />
                </ListItemIcon>
                <ListItemText
                  primary={new Date(entry.updated * 1000).toLocaleString(language, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                />
              </ListItemButton>
            ))}
          </List>
        )}
      </Sheet>

      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', pb: 4 }}>
        {ws.loadError && <LoadError />}
        {sorting && (
          <Alert severity="info" icon={false} sx={{ mb: 2 }}>
            <Typography variant="titleSmall" role="status">
              {sorting.guess ? routeText.looks(routeText.kinds[sorting.guess]) : routeText.unsure}
            </Typography>
            <Stack
              direction="row"
              role="group"
              aria-label={routeText.group}
              sx={{ gap: 2, flexWrap: 'wrap', mt: 2 }}
            >
              {PHOTO_ROUTES.map((kind) => (
                <Chip
                  key={kind}
                  label={routeText.kinds[kind]}
                  color={kind === sorting.guess ? 'primary' : 'default'}
                  variant={kind === sorting.guess ? 'filled' : 'outlined'}
                  onClick={() => routePhoto(kind)}
                  sx={{
                    minHeight: 48,
                    height: 'auto',
                    '& .MuiChip-label': { whiteSpace: 'normal', py: 2 },
                  }}
                />
              ))}
              <Chip
                label={routeText.notNow}
                variant="outlined"
                onClick={() => setSorting(null)}
                sx={{
                  minHeight: 48,
                  height: 'auto',
                  '& .MuiChip-label': { whiteSpace: 'normal', py: 2 },
                }}
              />
            </Stack>
          </Alert>
        )}
        {galleryPhoto && galleryPhoto.businessId === ws.active?.id && (
          <Alert severity="info" sx={{ mb: 2 }}>
            <Typography variant="titleSmall">{photoText.galleryOffer}</Typography>
            <Typography variant="bodySmall">{photoText.galleryNote}</Typography>
            <Stack direction="row" sx={{ gap: 1, flexWrap: 'wrap' }}>
              <Button
                disabled={busy !== 'idle'}
                onClick={async () => {
                  setBusy('photo')
                  setError('')
                  try {
                    await api(
                      `/businesses/${encodeURIComponent(galleryPhoto.businessId)}/gallery`,
                      {
                        method: 'POST',
                        body: galleryPhoto.file,
                        headers: { 'Content-Type': galleryPhoto.file.type },
                        signal: AbortSignal.timeout(150_000),
                      },
                    )
                    setGalleryPhoto(null)
                    await ws.reload()
                  } catch {
                    setError(t.actionFailed)
                  } finally {
                    setBusy('idle')
                  }
                }}
              >
                {photoText.galleryAdd}
              </Button>
              <Button disabled={busy !== 'idle'} onClick={() => setGalleryPhoto(null)}>
                {photoText.later}
              </Button>
            </Stack>
          </Alert>
        )}
        {photoPin &&
          ws.active?.id === photoPin.snapshot.business_id &&
          // A precise photo location also replaces an approximate demo pin.
          (ws.active.fields.lat == null || ws.active.fields.pin_demo) && (
            <Alert severity="info" sx={{ mb: 2 }}>
              {photoText.pinOffer}
              <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1 }}>
                <Button
                  disabled={busy !== 'idle'}
                  onClick={async () => {
                    if (!ws.active || !photoPin.snapshot.business) return
                    setBusy('photo')
                    setError('')
                    try {
                      // Keep the photo coordinates, but review current shop details and revision.
                      // Any concurrent change is rejected by the normal sealed proposal endpoint.
                      const { lat, lng, place_id, pin_label, pin_demo } = photoPin.snapshot.business
                      const next = await api<Proposal>('/proposals', {
                        method: 'POST',
                        body: JSON.stringify({
                          kind: 'business',
                          business_id: ws.active.id,
                          revision: ws.active.revision,
                          business: {
                            ...ws.active.fields,
                            lat,
                            lng,
                            place_id,
                            pin_label,
                            pin_demo,
                          },
                        }),
                      })
                      review(next)
                    } catch {
                      setError(t.actionFailed)
                      await ws.reload()
                    } finally {
                      setBusy('idle')
                    }
                  }}
                >
                  {photoText.reviewPin}
                </Button>
                <Button onClick={() => setPhotoPin(null)}>{photoText.dismiss}</Button>
              </Stack>
            </Alert>
          )}
        {empty || showToday ? (
          ws.loading || ws.loadError ? null : ws.active ? (
            // Today: how the shop is doing and what needs the owner now. Anything complete
            // goes away; the top bar already names the shop.
            <Stack spacing={3}>
              <TodayView key={ws.active.id} actions={today} />
              <GuideChips
                compact
                disabled={busy !== 'idle' || voice.state !== 'idle'}
                onSend={(sentence) => void send(sentence)}
              />
            </Stack>
          ) : (
            <Stack spacing={{ xs: 3, sm: 5 }} sx={{ pt: { xs: 1, sm: 10 }, pb: 4 }}>
              {/* Before a shop exists the greeting introduces the coach. */}
              <Typography
                component="h1"
                variant="headlineMedium"
                sx={{
                  fontSize: { xs: '1.5rem', sm: undefined },
                  lineHeight: { xs: '2rem', sm: undefined },
                }}
              >
                {t.coachGreeting}
              </Typography>
              <StartCard />
              {/* First visit: see the product working on a filled demo shop. */}
              {ws.businesses.length === 0 && <TourOffer />}
            </Stack>
          )
        ) : (
          <>
            {ws.active && (
              // While chatting the conversation gets the screen: what still needs the owner
              // shrinks to one pill under the app bar (hidden when nothing does).
              <Box
                sx={{
                  position: 'sticky',
                  top: 0,
                  zIndex: 2,
                  bgcolor: 'background.default',
                }}
              >
                <NeedsPill key={ws.active.id} actions={today} />
              </Box>
            )}
            {/* The live region wraps the list: role="log" on the <ol> itself removed its list semantics. */}
            <Box role="log" aria-live="polite">
              <Stack component="ol" spacing={3} sx={{ listStyle: 'none', m: 0, p: 0, pt: 2 }}>
                {messages.map((message, index) =>
                  message.role === 'menuLink' ? (
                    ws.savedProposals.includes(message.proposalId) && (
                      <MenuLinkChip
                        key={message.key}
                        label={next.seeInMenu(message.item)}
                        onOpen={() => {
                          setMenuFocus(message.item)
                          setShopSheet('menu')
                        }}
                      />
                    )
                  ) : message.role === 'action' ? (
                    message.action.target === 'reply' ? (
                      <ReplyCard key={message.key} action={message.action} onSend={sendReply} />
                    ) : (
                      <ActionChip
                        key={message.key}
                        action={message.action}
                        onOpen={() => openAction(message.action)}
                      />
                    )
                  ) : message.role === 'payment' ? (
                    <Box component="li" key={message.key}>
                      <PaymentCard payment={message.payment} />
                    </Box>
                  ) : message.role === 'chart' ? (
                    <Box component="li" key={message.key} sx={{ display: 'flex' }}>
                      <CoachChart chart={message.chart} />
                    </Box>
                  ) : message.role === 'suppliers' ? (
                    <SupplierCarousel
                      key={message.key}
                      result={message.result}
                      onChoose={(card) => {
                        const amount = message.result.quantity
                          ? `${message.result.quantity} ${message.result.unit} `
                          : ''
                        setNote(s.chooseDraft(card.rank, `${amount}${message.result.item}`))
                        messageInput.current?.focus()
                      }}
                    />
                  ) : message.role === 'po' ? (
                    pos[message.poId] && (
                      <Box component="li" key={message.poId} sx={{ pl: { xs: 0, sm: 10 } }}>
                        <PurchaseOrderCard
                          order={pos[message.poId]!}
                          onChange={(po) => setPos((known) => ({ ...known, [po.id]: po }))}
                        />
                      </Box>
                    )
                  ) : message.role === 'rules' ? (
                    <Box component="li" key={message.key} sx={{ pl: { xs: 0, sm: 10 } }}>
                      <RulesChangeCard
                        row={message.row}
                        onChange={(row) =>
                          setMessages((items) =>
                            items.map((item) =>
                              item.role === 'rules' && item.key === message.key
                                ? { ...item, row }
                                : item,
                            ),
                          )
                        }
                      />
                    </Box>
                  ) : message.role === 'order' ? (
                    orders[message.orderId] && (
                      <OrderCard
                        key={message.orderId}
                        order={orders[message.orderId]!}
                        onSend={sendOrder}
                        onDiscard={discardOrder}
                        onOpen={(order) => setThread(order.id)}
                        onReceived={(order) =>
                          void receiveOrder(order).then((received) => {
                            if (received)
                              setOrders((known) => ({ ...known, [received.id]: received }))
                          })
                        }
                      />
                    )
                  ) : (
                    <Bubble key={index} message={message} you={t.you} coach={t.coach} />
                  ),
                )}
                {searching !== null && <SearchingSuppliers item={searching} />}
                {liveReply && (
                  <Bubble
                    message={{ role: 'assistant', text: liveReply }}
                    you={t.you}
                    coach={t.coach}
                    streaming
                  />
                )}
                {busy === 'reply' && !reply && searching === null && (
                  <Box component="li" sx={{ pl: 10 }}>
                    <CircularProgress size={20} aria-label={t.speaking} />
                  </Box>
                )}
              </Stack>
            </Box>
            {lastIsReply && <Box sx={{ pt: 4, pl: 10 }}>{chips}</Box>}
          </>
        )}
        <div ref={end} />
      </Box>
      <SalesImportSheet imported={sales} onClose={() => setSales(null)} />
      {dayPhoto && <CloseDay initial={dayPhoto} onClose={() => setDayPhoto(null)} />}
      <OrdersSheet open={thread !== null} orderId={thread} onClose={() => setThread(null)} />
      <ConnectSheet open={connectOpen} onClose={() => setConnectOpen(false)} />
      <ShopSheets
        kind={shopSheet}
        menuFocus={menuFocus}
        onClose={() => {
          if (shopSheet === 'messages') refreshUnread()
          setShopSheet(null)
          setMenuFocus(null)
        }}
      />
      {closeDayOpen && (
        <CloseDay
          onClose={() => {
            setCloseDayOpen(false)
            void ws.reload()
          }}
        />
      )}

      <Box
        sx={{
          position: 'relative',
          flexShrink: 0,
          pb: 2,
          pt: 1,
          bgcolor: 'background.default',
          zIndex: 2,
        }}
      >
        {error && (
          <Alert severity="error" onClose={() => setError('')} sx={{ mb: 1.5 }}>
            {error}
          </Alert>
        )}
        {voice.error && (
          <Alert severity="info" sx={{ mb: 1.5 }}>
            {voice.error}
          </Alert>
        )}
        <Typography
          variant="labelMedium"
          color="text.secondary"
          role="status"
          sx={{ display: 'block', px: 4, '&:not(:empty)': { pb: 2 } }}
        >
          {/* Listening and speaking show inside the composer, so this line stays empty for
              voice and the composer never jumps. */}
          {!online
            ? t.connectionOffline
            : reconnecting || voice.state === 'reconnecting'
              ? t.connectionReconnecting
              : busy === 'photo'
                ? t.checkingPhoto
                : ''}
        </Typography>
        {/* One-line composer: attach, text, mic, send. Grows upward only for multi-line text.
            Voice swaps contents in place (mute for attach, status for text), so the row keeps
            its size and the buttons never move. */}
        <Box
          component="form"
          data-tour="composer"
          onSubmit={(event) => {
            event.preventDefault()
            void send()
          }}
          sx={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: 0.5,
            bgcolor: roles.surfaceContainerHigh,
            borderRadius: `${shape.xl}px`,
            p: 1,
            '&:has(textarea:focus-visible)': { outline: `2px solid ${roles.primary}` },
          }}
        >
          {voice.state !== 'idle' ? (
            <IconButton
              aria-label={voice.muted ? t.unmute : t.mute}
              onClick={voice.toggleMute}
              sx={{ minWidth: 48, minHeight: 48 }}
            >
              {voice.muted ? <VolumeX size={20} /> : <Volume2 size={20} />}
            </IconButton>
          ) : (
            <Tooltip title={t.attach} disableTouchListener>
              <span>
                <IconButton
                  aria-label={t.attach}
                  disabled={busy !== 'idle' || importer.busy}
                  ref={photoButton}
                  aria-haspopup={choices ? 'menu' : undefined}
                  onClick={(event) => choosePhoto(event.currentTarget)}
                  sx={{ minWidth: 48, minHeight: 48 }}
                >
                  {busy === 'photo' || importer.busy ? (
                    <CircularProgress size={20} aria-label={t.checkingPhoto} />
                  ) : (
                    <Paperclip size={22} />
                  )}
                </IconButton>
              </span>
            </Tooltip>
          )}
          {visible && (
            <input
              ref={photoInput}
              type="file"
              accept={PHOTO_TYPES.join(',')}
              hidden
              aria-hidden="true"
              tabIndex={-1}
              onChange={(event) => {
                const input = event.currentTarget
                const file = input.files?.[0]
                const document = picking.current === 'document'
                // Back to photos for the next pick (and for anything that reads the input).
                picking.current = 'photo'
                input.accept = PHOTO_TYPES.join(',')
                if (!file) return
                if (document)
                  void importer.upload(file).finally(() => {
                    input.value = ''
                  })
                else void receivePhoto(file)
              }}
            />
          )}
          <Menu
            anchorEl={photoMenu}
            open={Boolean(photoMenu)}
            onClose={() => setPhotoMenu(null)}
            anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
            transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
          >
            {touch && (
              <MenuItem onClick={() => pick('camera')} sx={{ minHeight: 48 }}>
                <ListItemIcon>
                  <Camera size={20} />
                </ListItemIcon>
                <ListItemText primary={t.photoTake} />
              </MenuItem>
            )}
            <MenuItem onClick={() => pick('library')} sx={{ minHeight: 48 }}>
              <ListItemIcon>
                <ImageUp size={20} />
              </ListItemIcon>
              <ListItemText primary={t.photoUpload} />
            </MenuItem>
            {ws.active && (
              <MenuItem onClick={() => pick('document')} sx={{ minHeight: 48 }}>
                <ListItemIcon>
                  <FileSpreadsheet size={20} />
                </ListItemIcon>
                <ListItemText primary={t.photoDocument} />
              </MenuItem>
            )}
            {ws.active && (
              <MenuItem
                onClick={() => {
                  setPhotoMenu(null)
                  setConnectOpen(true)
                }}
                sx={{ minHeight: 48 }}
              >
                <ListItemIcon>
                  <Layers size={20} />
                </ListItemIcon>
                <ListItemText primary={connectCopy.connectTitle} />
              </MenuItem>
            )}
          </Menu>
          {voiceText ? (
            <Typography
              role="status"
              variant="bodyLarge"
              noWrap
              sx={{ flex: 1, minWidth: 0, px: 1, py: 3, lineHeight: '1.5rem' }}
            >
              {voiceText}
            </Typography>
          ) : (
            <Box
              component="textarea"
              ref={messageInput}
              rows={1}
              name="message"
              autoComplete="off"
              value={note}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setNote(event.target.value)}
              onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
                // Desktop: Enter sends (Shift+Enter = new line). Touch keyboards: Enter is a new
                // line and the Send button sends, so half-typed messages aren't sent by accident.
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  !matchMedia('(pointer: coarse)').matches
                ) {
                  event.preventDefault()
                  void send()
                }
              }}
              placeholder={t.messagePlaceholder}
              disabled={voice.state !== 'idle'}
              aria-label={visible ? t.message : undefined}
              maxLength={2000}
              // 16px keeps iOS from zooming on focus; 12 + 24 + 12 matches the 48dp buttons.
              sx={{
                flex: 1,
                minWidth: 0,
                boxSizing: 'border-box',
                height: language === 'ta' ? '56px' : '48px',
                maxHeight: `calc(${COMPOSER_ROWS} * ${language === 'ta' ? '2rem' : '1.5rem'} + 24px)`,
                m: 0,
                px: 1,
                py: 3,
                border: 0,
                outline: 0,
                resize: 'none',
                overflowY: 'auto',
                bgcolor: 'transparent',
                color: 'text.primary',
                font: 'inherit',
                fontSize: '1rem',
                lineHeight: language === 'ta' ? '2rem' : '1.5rem',
                fontFamily: language === 'ta' ? '"Noto Sans Tamil", sans-serif' : 'inherit',
                '&:disabled': { color: 'text.disabled' },
                // The hint stays on one line on narrow phones (truncated, never wrapped).
                '&::placeholder': {
                  color: 'text.secondary',
                  opacity: 1,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                },
              }}
            />
          )}
          {/* Tap to talk, tap again to finish: the icon and its container show the state. No
              tooltip on touch, which would pop over the composer on a long press. */}
          <Tooltip
            title={
              voice.state === 'recording'
                ? t.finishTalking
                : voice.state === 'idle'
                  ? t.talk
                  : t.stopVoice
            }
            disableTouchListener
          >
            <span>
              <IconButton
                aria-label={
                  voice.state === 'recording'
                    ? t.finishTalking
                    : voice.state === 'idle'
                      ? t.talk
                      : t.stopVoice
                }
                aria-pressed={voice.state === 'recording'}
                disabled={busy !== 'idle'}
                onClick={() => {
                  if (voice.state === 'recording') voice.finishRecording()
                  else if (voice.state === 'idle')
                    void restored.current.then(() => voice.start(session.current))
                  else stopTalking()
                }}
                sx={
                  voice.state === 'recording'
                    ? {
                        bgcolor: roles.primaryContainer,
                        color: roles.onPrimaryContainer,
                        '&:hover': { bgcolor: roles.primaryContainer },
                      }
                    : undefined
                }
              >
                {voice.state === 'idle' || voice.state === 'recording' ? (
                  <Mic size={22} />
                ) : (
                  <Square size={18} />
                )}
              </IconButton>
            </span>
          </Tooltip>
          {busy === 'reply' ? (
            <IconButton
              aria-label={t.stop}
              // A blur on press would bring back the nav bar and move this button before the tap
              // lands; keep focus until the click, then let go so the nav returns.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                messageInput.current?.blur()
                controller.current?.abort()
                setBusy('idle')
              }}
              sx={{
                bgcolor: roles.secondaryContainer,
                color: roles.onSecondaryContainer,
                '&:hover': { bgcolor: roles.secondaryContainer },
              }}
            >
              <Square size={18} />
            </IconButton>
          ) : (
            <IconButton
              type="submit"
              onMouseDown={(event) => event.preventDefault()}
              // The form still submits after this click; the nav comes back once it has landed.
              onClick={() => messageInput.current?.blur()}
              aria-label={t.send}
              disabled={!canSend}
              sx={{
                bgcolor: canSend ? roles.primary : 'transparent',
                color: canSend ? roles.onPrimary : undefined,
                '&:hover': { bgcolor: canSend ? roles.primary : undefined },
              }}
            >
              <ArrowUp size={22} />
            </IconButton>
          )}
        </Box>
        {/* Phones: the review sheet already says this, so the coach screen stays quiet. */}
        <Typography
          variant="bodySmall"
          color="text.secondary"
          sx={{ display: { xs: 'none', sm: 'block' }, textAlign: 'center', mt: 2 }}
        >
          {t.reviewNote}
        </Typography>
      </Box>
    </Box>
  )
}

function Bubble({
  message,
  you,
  coach,
  streaming = false,
}: {
  message: { role: 'user' | 'assistant'; text: string }
  you: string
  coach: string
  streaming?: boolean
}) {
  const roles = useTheme().material
  if (message.role === 'user')
    return (
      <Box component="li" sx={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Box sx={chatBubbleStyle(roles)}>
          <Typography component="span" sx={visuallyHidden}>
            {you}:{' '}
          </Typography>
          <PlainText text={message.text} />
        </Box>
      </Box>
    )
  return (
    <Stack component="li" direction="row" spacing={2} sx={{ alignItems: 'flex-start' }}>
      <Avatar
        sx={{
          width: 32,
          height: 32,
          bgcolor: roles.primaryContainer,
          color: roles.onPrimaryContainer,
        }}
        aria-hidden="true"
      >
        <Leaf size={18} />
      </Avatar>
      <Box sx={{ minWidth: 0, pt: 0.5, flex: 1 }}>
        <Typography component="span" sx={visuallyHidden}>
          {coach}:{' '}
        </Typography>
        <RichText content={message.text} streaming={streaming} />
      </Box>
    </Stack>
  )
}
