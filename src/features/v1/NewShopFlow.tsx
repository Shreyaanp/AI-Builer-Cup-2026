import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent, ReactNode } from 'react'
import {
  Alert,
  AlertTitle,
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  Paper,
  Stack,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material'
import type { Theme } from '@mui/material'
import {
  ArrowLeft,
  ArrowUp,
  Camera,
  Check,
  Keyboard,
  Leaf,
  ListChecks,
  LocateFixed,
  Mic,
  MicOff,
  PhoneOff,
  ShieldCheck,
  SkipForward,
  Sparkles,
  Store,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import { gsap } from 'gsap'
import { visuallyHidden } from '@mui/utils'
import { chatBubbleStyle } from '../coach/bubbleStyle'
import { PlainText, RichText } from '../../design/RichText'
import { stripMarkdown } from '../../design/markdownUtils'
import { RateLimitError, streamCoach, TooSlowError, TURN_IDLE_MS } from '../../api/stream'
import type { CoachEvent } from '../../api/stream'
import { useIdentity } from '../../auth/useIdentity'
import { useLocale } from '../../state/hooks'
import { useChalkTimeline } from '../../design/chalkMotion'
import { enterRise, fieldFade, HAND_FONT, motion, shape } from '../../design/theme'
import { discoverCopy } from '../discover/strings'
import { HoursList } from '../shop/Hours'
import { useShopCopy } from '../shop/strings'
import { unitLabel } from '../shop/units'
import { ApiError } from './api'
import { photoHeaders, preparePhoto } from './photoPrep'
import type { Business, PhotoResult, Product, Proposal } from './api'
import { CameraCard, type Shot } from './CameraCard'
import { LocationPin } from './CurrentLocation'
import { GuidedDetails } from './GuidedDetails'
import { useInChatCopy } from './inChatCopy'
import { readablePlace, type OwnerLocation } from './location'
import { MapCard, type PinChoice } from './MapCard'
import { FactList } from './FactList'
import { defaultCurrency, formatPrice } from './format'
import { NewShopReady } from './NewShopStage'
import { useNewShopCopy } from './newShopCopy'
import { useNameSuggestion, useOnboardingCopy } from './onboardingCopy'
import { Sheet } from './Sheet'
import { dietaryMissing, factEntries } from './shopProgress'
import { useNextStepsCopy } from './nextStepsCopy'
import { useCopy } from './strings'
import { useVoice } from './useVoice'
import { useSpokenReveal } from './useSpokenReveal'
import { cardWords, mergeTranscript } from './speechReveal'
import type { VoiceProblem } from './useVoice'
import { ShopFill, VoiceAlert, VoiceOrb } from './VoiceStage'
import type { OrbPhase } from './VoiceStage'
import { useVoiceModeCopy } from './voiceModeCopy'
import { useWorkspace } from './workspaceContext'
import type { GalleryPhoto } from './screens/CoachScreen'
import { utter } from './phoneVoice'
import { useLanguageSwitch } from './languageSwitch'

const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp']
/** With no answer this long after the coach has spoken, the coach carries on by itself. */
const SILENCE_MS = 9_000

/** The browser's saved microphone choice for this site ('prompt' when it cannot tell). */
async function micPermission(): Promise<PermissionState> {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' as PermissionName })
    return status.state
  } catch {
    return 'prompt'
  }
}
/** It does so at most this many times in a row, then waits for the owner. */
const MAX_NUDGES = 2
const EMPTY_BUSINESS: Business['fields'] = {
  name: '',
  category: '',
  location: '',
  hours: '',
  phone: '',
}

type Draft = {
  business: Business['fields'] | null
  products: Product[]
  /** Steps the owner put off ("pata nahi", "baad mein", Skip): hours, photo. */
  skipped?: string[]
  /** The shop photo was taken. */
  photo?: boolean
  /** The shop went live by itself (name + kind + place known): its id. */
  live_id?: string | null
}
type Line =
  | { id: string; role: 'coach'; text: string }
  | { id: string; role: 'owner'; text: string; photo?: string }
  | { id: string; role: 'action'; title: string; items: string[] }
  // The camera and the map open as cards inside the conversation.
  | { id: string; role: 'camera'; shots: Shot[]; closed: boolean }
  | { id: string; role: 'map'; locate: boolean; done: string | null }
  // The one summary card at the end, with the optional face check.
  | { id: string; role: 'summary' }
type NewLine = Line extends infer L ? (L extends Line ? Omit<L, 'id'> : never) : never

const filled = (value: unknown) =>
  value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && !value.length)

/** The coach's proposals add to the draft; an empty value never erases what the owner said. */
function mergeDraft(previous: Draft, snapshot: Proposal['snapshot']): Draft {
  const products = new Map(
    previous.products.map((p) => [`${p.name.toLocaleLowerCase()}|${p.unit}`, p]),
  )
  snapshot.products.forEach((p) => products.set(`${p.name.toLocaleLowerCase()}|${p.unit}`, p))
  let business = previous.business
  if (snapshot.business) {
    const merged: Record<string, unknown> = { ...(previous.business ?? snapshot.business) }
    for (const [key, value] of Object.entries(snapshot.business))
      if (filled(value)) merged[key] = value
    business = merged as unknown as Business['fields']
  }
  return { ...previous, business, products: [...products.values()] }
}

/** The server's saved draft (a resumed conversation, a tool's save) joins what the screen has. */
function withServerDraft(previous: Draft, server: Draft): Draft {
  const merged = mergeDraft(previous, {
    kind: 'business',
    business_id: '',
    revision: 0,
    business: server.business,
    products: server.products ?? [],
  })
  return {
    ...merged,
    skipped: [...new Set([...(previous.skipped ?? []), ...(server.skipped ?? [])])],
    photo: Boolean(previous.photo || server.photo),
    live_id: server.live_id || previous.live_id || null,
  }
}

const hasPlace = (draft: Draft) =>
  Boolean(draft.business && (draft.business.lat != null || draft.business.location))
/** Everything onboarding asks is answered or skipped (owner decision, 17 Oct). */
function complete(draft: Draft) {
  const b = draft.business
  const skipped = new Set(draft.skipped ?? [])
  return Boolean(
    b?.name &&
    b.category &&
    hasPlace(draft) &&
    (b.hours || b.weekly_hours?.length || skipped.has('hours')) &&
    (draft.photo || skipped.has('photo')),
  )
}

export function NewShopFlow({
  setGalleryPhoto,
}: {
  setGalleryPhoto: (photo: GalleryPhoto | null) => void
}) {
  const ws = useWorkspace()
  const roles = useTheme().material
  return (
    <Box
      component="main"
      id="main"
      tabIndex={-1}
      data-testid="new-shop-flow"
      sx={{ minHeight: '100dvh', bgcolor: roles.surface, outline: 'none' }}
    >
      {ws.newShopReady ? (
        <NewShopReady />
      ) : (
        ws.creatingShop && <Journey setGalleryPhoto={setGalleryPhoto} />
      )}
    </Box>
  )
}

/** Hero, conversation and review share one draft; leaving the flow discards it. */
function Journey({ setGalleryPhoto }: { setGalleryPhoto: (photo: GalleryPhoto | null) => void }) {
  const t = useCopy()
  const f = useNewShopCopy()
  const v = useVoiceModeCopy()
  const ws = useWorkspace()
  const { api } = ws
  const identity = useIdentity()
  const language = useLocale()
  const switchLanguage = useLanguageSwitch()
  const roles = useTheme().material
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const wide = useMediaQuery((theme: Theme) => theme.breakpoints.up('md'))
  const o = useOnboardingCopy()
  const c = useInChatCopy()
  const phase = ws.newShopPhase

  const [lines, setLines] = useState<Line[]>([])
  const [live, setLiveText] = useState('')
  // What the owner is saying right now (live transcript), for the caption.
  const [heard, setHeard] = useState('')
  // The owner chose the keyboard; without a live voice session typing is the only way anyway.
  const [typing, setTyping] = useState(false)
  // A microphone the browser already blocks, found before any session opened.
  const [preflight, setPreflight] = useState<VoiceProblem | null>(null)
  const [orbPhase, setOrbPhase] = useState<OrbPhase>('connecting')
  const liveRef = useRef('')
  const [draft, setDraftState] = useState<Draft>({ business: null, products: [] })
  const draftRef = useRef(draft)
  // The last sealed server proposal; reused for review when nothing changed since.
  const [sealed, setSealed] = useState<Proposal | null>(null)
  const [ownerLocation, setOwnerLocation] = useState<PinChoice | OwnerLocation | null>(null)
  const [photoNotes, setPhotoNotes] = useState<string[]>([])
  // A name printed on a photo that differs from (or is missing in) the owner's: tap to use it.
  const [nameSuggestion, setNameSuggestion] = useState<string | null>(null)
  const suggestName = useNameSuggestion()
  const photoFile = useRef<File | null>(null)
  const [review, setReview] = useState<Proposal | null>(null)
  const [busy, setBusyState] = useState<'idle' | 'reply' | 'photo' | 'review'>('idle')
  const busyRef = useRef(busy)
  const [note, setNoteState] = useState('')
  const noteRef = useRef('')
  const [error, setError] = useState('')
  // "Review my shop": always one tap away, whatever the coach is doing.
  const [reviewOpen, setReviewOpen] = useState(false)
  // The owner ended the conversation ("bas", "that's all", or the End button): everything is
  // saved; no nudges, no reconnect, until they tap Continue.
  const [ended, setEndedState] = useState(false)
  const endedRef = useRef(false)
  const endAsked = useRef(false)
  const setEnded = (next: boolean) => {
    endedRef.current = next
    setEndedState(next)
  }
  /** The owner said stop (any language): the chat rests and Review my shop opens at once. */
  const endAfterStop = () => {
    setEnded(true)
    setReviewOpen(true)
  }
  // A turn that took too long (no event for TURN_IDLE_MS): what to send again on Retry.
  const [stalled, setStalled] = useState<string | null>(null)
  const turnTimer = useRef<number | undefined>(undefined)
  const lastTurn = useRef<string | null>(null)
  const summaryShown = useRef(false)
  // The current turn resumes a conversation already under way: its answer stays silent.
  const quiet = useRef(false)
  const [finishing, setFinishing] = useState(false)
  const [muted, setMuted] = useState(!ws.speakReplies)
  const mutedRef = useRef(muted)
  const [ttsText, setTtsText] = useState('')
  const session = useRef<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  const started = useRef(false)
  const startSent = useRef(false)
  const greeted = useRef(false)
  const wantVoice = useRef(false)
  // A turn sent into the live voice session that has not been answered yet.
  const pending = useRef<string | null>(null)
  const ownerTurnOpen = useRef(false)
  const silence = useRef<number | undefined>(undefined)
  const nudges = useRef(0)
  const speaking = useRef<HTMLAudioElement | null>(null)
  const messageInput = useRef<HTMLTextAreaElement>(null)
  const end = useRef<HTMLDivElement>(null)
  // Cards the coach offered by itself (each kind once), and cards still open on screen.
  const offered = useRef({ camera: false, map: false })
  const openCards = useRef(new Set<string>())
  // The live voice session, for handlers declared before it (set after each render).
  const voiceRef = useRef<ReturnType<typeof useVoice> | null>(null)
  // The live voice's words appear as they are said; the shop card, camera and map join in when
  // the voice reaches them (see speechReveal.ts).
  const reveal = useSpokenReveal({
    remaining: () => {
      const seconds = voiceRef.current?.playbackRemaining() ?? 0
      return seconds > 0 ? seconds * 1000 : null
    },
    reducedMotion,
    onDone: (text) => addCoachLine(text),
  })
  // A typed turn read aloud: the caption follows the voice the same way.
  const captionReveal = useSpokenReveal({
    remaining: () => {
      const audio = speaking.current
      return audio && Number.isFinite(audio.duration) && !audio.paused
        ? (audio.duration - audio.currentTime) * 1000
        : null
    },
    reducedMotion,
    onDone: () => undefined,
  })

  const setLive = (next: string | ((current: string) => string)) => {
    liveRef.current = typeof next === 'function' ? next(liveRef.current) : next
    setLiveText(liveRef.current)
  }
  const setDraft = (next: Draft) => {
    draftRef.current = next
    setDraftState(next)
  }
  // Thinking can never stay on: every "reply" state ends on the reply, an error, or after
  // TURN_IDLE_MS without any event (then Retry is offered).
  const setBusy = (next: typeof busy) => {
    busyRef.current = next
    setBusyState(next)
    if (next === 'reply') armTurn()
    else window.clearTimeout(turnTimer.current)
  }
  const setNote = (next: string) => {
    noteRef.current = next
    setNoteState(next)
  }
  const add = (line: NewLine) =>
    setLines((items) => [...items, { ...line, id: crypto.randomUUID() } as Line].slice(-80))

  function armTurn() {
    window.clearTimeout(turnTimer.current)
    turnTimer.current = window.setTimeout(onTurnStall, TURN_IDLE_MS)
  }
  /** No word from the coach for too long: stop thinking, keep what arrived, offer Retry. */
  function onTurnStall() {
    if (busyRef.current !== 'reply') return
    if (reveal.active()) addCoachLine(reveal.flush())
    if (liveRef.current.trim()) {
      // The words came but their end never did (the stream ended without a final event).
      commitCoach(true)
      return
    }
    const unanswered = pending.current ?? lastTurn.current
    pending.current = null
    controller.current?.abort()
    controller.current = null
    setBusy('idle')
    setStalled(unanswered ?? '')
  }
  function retryTurn() {
    const message = stalled
    setStalled(null)
    if (message) void say(message)
  }
  function clearSilence() {
    window.clearTimeout(silence.current)
  }
  function armSilence(extra = 0) {
    clearSilence()
    if (nudges.current >= MAX_NUDGES || endedRef.current) return
    silence.current = window.setTimeout(onSilence, SILENCE_MS + extra)
  }
  // No answer: the coach responds in the chat anyway (a suggestion or a default) and moves on.
  function onSilence() {
    // A paused mic is the owner taking a moment on purpose: no nudge then.
    // Onboarding is done (the summary is up): no more questions.
    if (summaryShown.current) return
    if (
      busyRef.current !== 'idle' ||
      noteRef.current.trim() ||
      document.hidden ||
      voiceRef.current?.micPaused ||
      openCards.current.size > 0
    ) {
      armSilence()
      return
    }
    nudges.current += 1
    void say(f.silence)
  }

  function silenceAudio() {
    speaking.current?.pause()
    speaking.current = null
    if ('speechSynthesis' in window) speechSynthesis.cancel()
  }
  function stopSpeaking() {
    silenceAudio()
    captionReveal.discard()
    setTtsText('')
  }
  // The coach's text replies read aloud (natural Google voice; the phone's voice otherwise).
  async function speak(text: string) {
    stopSpeaking()
    const cleanText = stripMarkdown(text)
    setTtsText(cleanText)
    const done = (resolve: () => void) => () => {
      setTtsText((current) => (current === cleanText ? '' : current))
      resolve()
    }
    try {
      const response = await api<Response>('/tts', {
        method: 'POST',
        body: JSON.stringify({ text: cleanText, language }),
        raw: true,
      })
      if (response.status === 200) {
        const url = URL.createObjectURL(await response.blob())
        const audio = new Audio(url)
        speaking.current = audio
        await new Promise<void>((resolve) => {
          const finish = done(resolve)
          audio.onended = audio.onpause = () => {
            URL.revokeObjectURL(url)
            finish()
          }
          // The caption follows the voice from its first sound.
          audio.onplaying = () => {
            captionReveal.push(text)
            captionReveal.finish()
          }
          audio.play().catch(finish)
        })
        return
      }
    } catch {
      // Fall through to on-device speech.
    }
    if (!('speechSynthesis' in window) || mutedRef.current) {
      setTtsText('')
      return
    }
    await new Promise<void>((resolve) => {
      const finish = done(resolve)
      const utterance = utter(cleanText, language)
      utterance.onend = utterance.onerror = finish
      // The phone's voice has no clock to follow: the caption comes at a speaking rate.
      utterance.onstart = () => {
        captionReveal.push(text)
        captionReveal.finish()
      }
      speechSynthesis.speak(utterance)
      // Some devices never report the end of speech.
      window.setTimeout(finish, 1500 + cleanText.length * 70)
    })
  }

  /** A coach line joins the chat (and the camera or map it asks for, once). */
  function addCoachLine(text: string) {
    if (!text.trim()) return
    add({ role: 'coach', text: text.trim() })
    offerCards(text)
  }
  /**
   * The coach's turn is in: it joins the chat, is spoken, and the silence clock starts. A live
   * voice turn's words join the chat from the reveal once spoken; only the turn ends here.
   */
  function commitCoach(finished: boolean) {
    if (quiet.current && finished) {
      quiet.current = false
      greeted.current = true
      pending.current = null
      setLive('')
      setBusy('idle')
      showNextStep()
      return
    }
    const text = liveRef.current.trim()
    setLive('')
    setHeard('')
    ownerTurnOpen.current = false
    addCoachLine(text)
    if (!finished) return
    pending.current = null
    if (startSent.current) greeted.current = true
    setBusy('idle')
    const live = voiceRef.current
    if (live && live.state !== 'idle') armSilence(live.playbackRemaining() * 1000)
    else if (text && !mutedRef.current) void speak(text).then(() => armSilence())
    else armSilence()
  }
  /**
   * The coach asked for a photo or for the place: the camera or the map opens in the chat. With
   * `spoken`, it opens when the voice says the words (not when the transcript arrives).
   */
  function offerCards(text: string, spoken = false) {
    const business = draftRef.current.business
    const show = (open: () => void, words: RegExp) =>
      spoken
        ? reveal.cue(
            () => {
              addCoachLine(reveal.split())
              open()
            },
            [words],
            0,
          )
        : open()
    const draft = draftRef.current
    if (
      c.photoWords.test(text) &&
      !offered.current.camera &&
      !draft.photo &&
      !draft.skipped?.includes('photo')
    ) {
      offered.current.camera = true
      show(() => openCamera(false), c.photoWords)
    } else if (
      c.placeWords.test(text) &&
      !offered.current.map &&
      !(business?.lat != null || business?.location)
    ) {
      offered.current.map = true
      show(() => openMap(false, false), c.placeWords)
    }
  }
  function openCamera(hold = true) {
    const id = crypto.randomUUID()
    // One camera at a time: an older open one closes.
    if (hold) openCards.current = new Set([id])
    clearSilence()
    setLines((items) =>
      [
        ...items.map((line) => (line.role === 'camera' ? { ...line, closed: true } : line)),
        { id, role: 'camera' as const, shots: ['front'] as Shot[], closed: false },
      ].slice(-80),
    )
  }
  /**
   * `quiet` (the X, a finished photo): the card just closes, nothing is sent or spoken and the
   * coach does not nudge. Skip says "later" to the coach, which carries on with the next question.
   */
  function closeCamera(id: string, quiet: boolean) {
    openCards.current.delete(id)
    // Closed without a photo: Today reminds them later.
    const draft = draftRef.current
    const skipping =
      busyRef.current !== 'photo' && !draft.photo && !draft.skipped?.includes('photo')
    if (skipping) {
      setDraft({ ...draft, skipped: [...(draft.skipped ?? []), 'photo'] })
      if (!quiet) void say(o.photoSkipped)
    }
    setLines((items) =>
      items.map((line) =>
        line.id === id && line.role === 'camera' ? { ...line, closed: true } : line,
      ),
    )
    if (!(quiet && skipping)) armSilence()
  }
  function openMap(locate: boolean, hold = true) {
    const id = crypto.randomUUID()
    if (hold) openCards.current = new Set([id])
    clearSilence()
    nudges.current = 0
    setLines((items) =>
      [
        ...items.filter((line) => line.role !== 'map' || line.done),
        { id, role: 'map' as const, locate, done: null },
      ].slice(-80),
    )
  }
  function hearOwner(text: string) {
    clearSilence()
    nudges.current = 0
    const open = ownerTurnOpen.current
    ownerTurnOpen.current = true
    setHeard((current) => (open ? mergeTranscript(current, text) : text))
    setLines((items) => {
      const last = items.at(-1)
      if (open && last?.role === 'owner' && !last.photo)
        return [...items.slice(0, -1), { ...last, text: mergeTranscript(last.text, text) }]
      return [...items, { id: crypto.randomUUID(), role: 'owner' as const, text }].slice(-80)
    })
  }
  function applyProposal(proposal: Proposal) {
    setSealed(proposal)
    setDraft(mergeDraft(draftRef.current, proposal.snapshot))
  }
  /** The coach opened a card of the flow (show_step): it appears at once. */
  function showStep(step: string) {
    if (step === 'location') openMap(true)
    else if (step === 'camera') openCamera()
    else if (step === 'review') setReviewOpen(true)
    else if (step === 'summary' || step === 'face_check') offerSummary()
  }
  /** After a resume: no greeting, just the card of the next step (the map, the camera). */
  function showNextStep() {
    const draft = draftRef.current
    const b = draft.business
    if (!b?.name || !b.category) return
    if (!hasPlace(draft)) openMap(false, false)
    else if (
      (b.hours || b.weekly_hours?.length || draft.skipped?.includes('hours')) &&
      !draft.photo &&
      !draft.skipped?.includes('photo')
    )
      openCamera(false)
  }
  function offerSummary() {
    if (summaryShown.current || !draftRef.current.live_id) return
    summaryShown.current = true
    clearSilence()
    // A camera card still open (the owner said "baad mein" instead of tapping Skip) closes.
    setLines((items) =>
      items.map((line) => (line.role === 'camera' ? { ...line, closed: true } : line)),
    )
    add({ role: 'summary' })
  }
  /** Done: the live shop opens (and the face check, when the owner chose it). */
  async function finish(face: boolean) {
    const bid = draftRef.current.live_id
    if (!bid || finishing) return
    setFinishing(true)
    wantVoice.current = false
    clearSilence()
    silenceAudio()
    stopVoice()
    if (photoFile.current) setGalleryPhoto({ file: photoFile.current, businessId: bid })
    try {
      await ws.finishNewShop(bid)
      if (face) ws.setFaceOpen(true)
    } catch {
      setError(t.actionFailed)
      setFinishing(false)
    }
  }
  function receive(event: CoachEvent) {
    switchLanguage(event)
    // Any word from the coach restarts the "took too long" clock.
    if (busyRef.current === 'reply') armTurn()
    if (event.kind === 'action' && event.data?.target === 'new_shop_step')
      showStep(String(event.data.step ?? ''))
    if (event.kind === 'action' && event.data?.target === 'end_conversation') {
      // The owner asked to stop: after the goodbye, the conversation rests.
      endAsked.current = true
      wantVoice.current = false
      clearSilence()
    }
    if (event.kind === 'ready' && event.session_id) session.current = event.session_id
    // Typed resume (the page reloaded mid-onboarding): the opening turn's answer is not shown or
    // spoken; the shop card and the next step's card carry on silently.
    if (event.kind === 'ready' && event.data?.continues && !greeted.current) quiet.current = true
    if (quiet.current && (event.kind === 'delta' || event.kind === 'reply')) return
    if (event.kind === 'delta') setLive((current) => current + (event.text ?? ''))
    if (event.kind === 'reply') setLive(event.text ?? '')
    if (event.kind === 'output_transcript')
      setLive((current) => mergeTranscript(current, event.text ?? ''))
    if (event.kind === 'input_transcript' && event.text?.trim()) hearOwner(event.text)
    if (event.kind === 'proposal') applyProposal(event.data as unknown as Proposal)
    // The conversation came back with answers this screen never received (the connection
    // dropped right after they were saved, or the page reloaded): the shop card catches up.
    if (event.kind === 'draft' && event.data)
      setDraft(withServerDraft(draftRef.current, event.data as unknown as Draft))
    if (event.kind === 'interrupted') commitCoach(false)
    if (event.kind === 'turn_complete') commitCoach(true)
    // Typed: the goodbye is in; the conversation ends here (voice ends on its own close).
    if (event.kind === 'turn_complete' && endAsked.current && voiceRef.current?.state === 'idle')
      endAfterStop()
  }
  /** The live voice: the same turn, its words and cards revealed in step with the audio. */
  function receiveVoice(event: CoachEvent) {
    if (event.kind === 'output_transcript' || event.kind === 'reply' || event.kind === 'delta') {
      const heard = reveal.heard()
      const spoken =
        event.kind === 'delta'
          ? heard + (event.text ?? '')
          : mergeTranscript(heard, event.text ?? '')
      reveal.push(spoken)
      offerCards(spoken, true)
      return
    }
    if (event.kind === 'proposal') {
      // The shop card fills in as the coach says what it added.
      const proposal = event.data as unknown as Proposal
      reveal.cue(() => {
        addCoachLine(reveal.split())
        applyProposal(proposal)
      }, cardWords(event.data))
      return
    }
    // The owner talks over the coach: the voice and its words stop together.
    if ((event.kind === 'input_transcript' && event.text?.trim()) || event.kind === 'interrupted')
      if (reveal.active()) addCoachLine(reveal.cut())
    if (event.kind === 'turn_complete') reveal.finish()
    receive(event)
  }

  const voice = useVoice(null, receiveVoice, draft, {
    onReady: (resumed, continues) => {
      // A socket ended (time cap, network) and the same session is back: what the coach had
      // started saying stays in the chat (that turn was answered).
      if (resumed && reveal.active()) addCoachLine(reveal.flush())
      if (resumed && liveRef.current.trim()) commitCoach(true)
      // The coach speaks first: the opening goes out as soon as the live session is ready.
      if (!startSent.current) {
        startSent.current = true
        if (continues) {
          // The conversation was already under way (the page reloaded): resume silently.
          greeted.current = true
          showNextStep()
          return
        }
        setBusy('reply')
        if (voiceRef.current?.sendText(f.start, draftRef.current)) pending.current = f.start
        return
      }
      // A turn sent while the session was (re)connecting, or one it never answered, goes now.
      if (pending.current) voiceRef.current?.sendText(pending.current, draftRef.current)
    },
    onEnded: () => {
      wantVoice.current = false
      endAfterStop()
    },
  })
  useEffect(() => {
    voiceRef.current = voice
  })
  const { muted: voiceMuted, toggleMute, stop: stopVoice } = voice
  useEffect(() => {
    if (voiceMuted !== muted) toggleMute()
  }, [muted, voiceMuted, toggleMute])

  /** Any turn: in the live voice session when one is open, otherwise a streamed text turn. */
  async function say(message: string) {
    clearSilence()
    // Typing always works: a word after the end simply carries the conversation on.
    if (endedRef.current) {
      endAsked.current = false
      setEnded(false)
    }
    setError('')
    setStalled(null)
    lastTurn.current = message
    if (voiceRef.current?.sendText(message, draftRef.current)) {
      pending.current = message
      setBusy('reply')
      return
    }
    // Voice is coming back in the same session: the turn waits for it (one stream per session).
    if (['connecting', 'reconnecting'].includes(voiceRef.current?.state ?? '')) {
      pending.current = message
      setBusy('reply')
      return
    }
    await sendText(message)
  }
  async function sendText(message: string) {
    lastTurn.current = message
    stopSpeaking()
    controller.current?.abort()
    const abort = new AbortController()
    controller.current = abort
    setBusy('reply')
    setLive('')
    try {
      await streamCoach(
        {
          message,
          language,
          currency: defaultCurrency(),
          session_id: session.current,
          business_id: null,
          new_shop: true,
          new_shop_draft: draftRef.current,
        },
        abort.signal,
        receive,
        identity.getToken,
        undefined,
        TURN_IDLE_MS,
      )
      if (controller.current === abort && (liveRef.current.trim() || quiet.current))
        commitCoach(true)
    } catch (cause) {
      if (!abort.signal.aborted) {
        if (liveRef.current.trim()) commitCoach(true)
        setLive('')
        if (cause instanceof TooSlowError) setStalled(message)
        else setError(cause instanceof RateLimitError ? t.rateLimited : t.replyFailed)
      }
    } finally {
      if (controller.current === abort) {
        controller.current = null
        setBusy('idle')
      }
    }
  }

  const canVoice =
    typeof window !== 'undefined' &&
    Boolean(navigator.mediaDevices) &&
    typeof AudioContext !== 'undefined' &&
    typeof AudioWorkletNode !== 'undefined'
  async function begin() {
    started.current = true
    ws.setNewShopPhase('chat')
    // A microphone the browser already blocks never opens: say how to allow it, carry on by text.
    const blocked = canVoice && (await micPermission()) === 'denied'
    if (blocked) setPreflight({ kind: 'mic-blocked' })
    if (canVoice && !blocked) {
      wantVoice.current = true
      void voice.start()
    } else {
      startSent.current = true
      void sendText(f.start)
    }
  }

  // Voice ended (time limit, microphone refused, connection lost): the chat carries on by text,
  // and if the greeting never arrived the coach still speaks first.
  const voiceState = voice.state
  const voiceEnded = useEffectEvent(() => {
    if (!started.current) return
    // A refused microphone is not retried by itself; the mic button still offers it. A lost
    // connection is: voice comes back when the network or the screen does.
    if (voice.error && voice.problem?.kind !== 'connection') wantVoice.current = false
    const unanswered = pending.current
    pending.current = null
    // Ended normally under words still catching up: the rest shows at once.
    if (reveal.active()) addCoachLine(reveal.flush())
    if (busyRef.current === 'reply' && !controller.current) {
      setLive('')
      setBusy('idle')
    }
    if (ws.newShopPhase !== 'chat') return
    // A turn the live session never answered goes again by text, so nothing the owner said is lost.
    if (unanswered) void sendText(unanswered)
    else if (!startSent.current) {
      startSent.current = true
      void sendText(f.start)
    }
  })
  useEffect(() => {
    if (voiceState === 'idle') voiceEnded()
  }, [voiceState])

  // Review is a page of its own: nobody listens there. Coming back resumes the voice.
  const enterPhase = useEffectEvent((next: typeof phase) => {
    if (next !== 'chat') {
      clearSilence()
      silenceAudio()
      stopVoice()
    } else if (started.current && wantVoice.current && greeted.current) {
      void voice.start(session.current, true)
    }
  })
  useEffect(() => {
    enterPhase(phase)
  }, [phase])
  useEffect(
    () => () => {
      window.clearTimeout(silence.current)
      controller.current?.abort()
      speaking.current?.pause()
      if ('speechSynthesis' in window) speechSynthesis.cancel()
    },
    [],
  )
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end', behavior: reducedMotion ? 'instant' : 'smooth' })
  }, [lines, live, reducedMotion])
  const summaryDue = complete(draft) && Boolean(draft.live_id)
  const showSummary = useEffectEvent(() => offerSummary())
  useEffect(() => {
    if (summaryDue) showSummary()
  }, [summaryDue])
  useEffect(() => () => window.clearTimeout(turnTimer.current), [])
  useLayoutEffect(() => {
    const field = messageInput.current
    if (!field) return
    field.style.height = '48px'
    if (note) field.style.height = `${Math.max(48, field.scrollHeight)}px`
  }, [note])

  async function submit() {
    const text = note.trim()
    if (!text || busy !== 'idle') return
    setNote('')
    nudges.current = 0
    ownerTurnOpen.current = false
    add({ role: 'owner', text })
    await say(text)
  }
  function skip() {
    if (busy !== 'idle') return
    nudges.current = 0
    add({ role: 'owner', text: f.skip })
    void say(f.silence)
  }

  async function uploadPhoto(file: File) {
    if (!PHOTO_TYPES.includes(file.type) || file.size > 20_000_000) {
      setError(t.photoType)
      return
    }
    clearSilence()
    nudges.current = 0
    stopSpeaking()
    setError('')
    setBusy('photo')
    add({ role: 'owner', text: f.photo, photo: URL.createObjectURL(file) })
    try {
      const photo = await preparePhoto(file)
      const result = await api<PhotoResult>(`/photos?currency=${defaultCurrency()}`, {
        method: 'POST',
        body: photo.file,
        headers: photoHeaders(photo),
        signal: AbortSignal.timeout(60_000),
      })
      const before = draftRef.current
      // A photo fills what the owner has not said yet, but never the shop's name: that is theirs
      // (said, typed or not yet synced). A different name on the photo is only offered as a chip.
      // Its items wait for the menu step on Today.
      const seen = result.proposal?.snapshot.business
      const after = {
        ...(seen
          ? mergeDraft(before, {
              ...result.proposal!.snapshot,
              business: Object.fromEntries(
                Object.entries(seen).filter(
                  ([key]) =>
                    key !== 'name' &&
                    !filled((before.business as Record<string, unknown> | null)?.[key]),
                ),
              ) as unknown as Business['fields'],
              products: [],
            })
          : before),
        photo: true,
      }
      setDraft(after)
      const printed = seen?.name?.trim() ?? ''
      setNameSuggestion(
        printed &&
          printed.toLocaleLowerCase() !== (after.business?.name ?? '').trim().toLocaleLowerCase()
          ? printed
          : null,
      )
      photoFile.current = file
      setPhotoNotes(result.extraction.uncertain.slice(0, 5))
      setBusy('idle')
      // In plain words for the coach (no "label: value" pairs it could mistake for answers). The
      // name is the owner's, never the one printed on the photo.
      const read = [after.business?.name, after.business?.category].filter(Boolean)
      void say(f.photoNote(read.join(', ') || o.photoAdded))
    } catch (cause) {
      setBusy('idle')
      const code = cause instanceof ApiError ? cause.code : ''
      add({
        role: 'coach',
        text:
          cause instanceof ApiError && cause.status === 429
            ? t.rateLimited
            : code === 'PHOTO_BLOCKED' || code === 'NOT_BUSINESS_PHOTO'
              ? t.photoRefused
              : t.photoFailed,
      })
    }
  }

  /** The owner confirmed the pin on the map card: sealed through the normal proposal path. */
  async function savePin(id: string, point: PinChoice) {
    const before = draftRef.current
    const pinned = await api<Proposal>('/proposals', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'business',
        business_id: null,
        revision: 0,
        business: before.business ?? EMPTY_BUSINESS,
        products: before.products,
        owner_location: point,
      }),
    })
    setOwnerLocation(point)
    applyProposal(pinned)
    openCards.current.delete(id)
    const business = draftRef.current.business
    const place = business ? readablePlace(business, f) : f.current
    setLines((items) =>
      items.map((line) =>
        line.id === id && line.role === 'map' ? { ...line, done: place } : line,
      ),
    )
    void say(f.locationNote(place))
  }

  async function openReview(location?: PinChoice | null) {
    const current = draftRef.current
    if (!current.business?.name || busy !== 'idle') return
    setBusy('review')
    setError('')
    try {
      const unchanged =
        sealed &&
        JSON.stringify(sealed.snapshot.business) === JSON.stringify(current.business) &&
        JSON.stringify(sealed.snapshot.products) === JSON.stringify(current.products)
      const pin = location === undefined ? ownerLocation : location
      const proposal =
        !pin && unchanged
          ? sealed
          : await api<Proposal>('/proposals', {
              method: 'POST',
              body: JSON.stringify({
                kind: 'business',
                business_id: null,
                revision: 0,
                ...current,
                owner_location: pin,
              }),
            })
      setReview({ ...proposal, photo_notes: photoNotes, new_shop: true })
      ws.setNewShopPhase('review')
    } catch {
      setError(t.actionFailed)
    } finally {
      setBusy('idle')
    }
  }

  // The orb reads real levels every frame (refs only: no re-render per frame).
  const ttsRef = useRef('')
  useEffect(() => {
    ttsRef.current = ttsText
  }, [ttsText])
  const sampleOrb = () => {
    const live = voiceRef.current
    const levels = live?.levels() ?? { input: 0, output: 0 }
    return {
      ...levels,
      speaking: (live?.playbackRemaining() ?? 0) > 0.05 || Boolean(ttsRef.current),
      awaiting: ownerTurnOpen.current || busyRef.current === 'reply',
    }
  }
  const [alertKey, setAlertKey] = useState(0)
  const focusComposer = useRef(false)
  useEffect(() => {
    if (!focusComposer.current) return
    focusComposer.current = false
    messageInput.current?.focus()
  })
  function dismissProblem() {
    setPreflight(null)
    voice.clearProblem()
  }
  function typeInstead() {
    dismissProblem()
    focusComposer.current = true
    setTyping(true)
  }
  /** From an alert or "Talk instead": voice again, in the same conversation. */
  async function retryVoice() {
    dismissProblem()
    setAlertKey((key) => key + 1)
    if ((await micPermission()) === 'denied') {
      setPreflight({ kind: 'mic-blocked' })
      return
    }
    wantVoice.current = true
    setTyping(false)
    void voice.start(session.current, startSent.current)
  }
  function talkInstead() {
    if (voice.state !== 'idle') setTyping(false)
    else void retryVoice()
  }
  /** End: the conversation stops at once (voice, typing, nudges); everything is saved. */
  function endConversation() {
    wantVoice.current = false
    endAsked.current = false
    clearSilence()
    if (reveal.active()) addCoachLine(reveal.cut())
    controller.current?.abort()
    controller.current = null
    pending.current = null
    setStalled(null)
    setLive('')
    setBusy('idle')
    stopSpeaking()
    stopVoice()
    setEnded(true)
  }
  /** Continue after an end: the same conversation, silently from where it stopped. */
  function continueConversation() {
    endAsked.current = false
    setEnded(false)
    nudges.current = 0
    if (!typing && canVoice) {
      wantVoice.current = true
      // The same session: the coach carries on silently (no new greeting).
      void voice.start(session.current, true)
    }
  }
  function endVoice() {
    wantVoice.current = false
    // The voice and its words stop together; only what was said stays.
    if (reveal.active()) addCoachLine(reveal.cut())
    stopVoice()
    setTyping(true)
  }
  // Voice paused after its retries (no network, the phone slept): when the network or the screen
  // comes back, it resumes by itself at the same step, as if the owner had tapped Retry.
  const resumeVoice = useEffectEvent(() => {
    if (
      started.current &&
      wantVoice.current &&
      phase === 'chat' &&
      voice.state === 'idle' &&
      voice.problem?.kind === 'connection' &&
      navigator.onLine &&
      document.visibilityState === 'visible'
    )
      void retryVoice()
  })
  useEffect(() => {
    const resume = () => resumeVoice()
    window.addEventListener('online', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      window.removeEventListener('online', resume)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [])
  const coral = useTheme().chalk.coral

  if (phase === 'hero') return <Hero onBegin={begin} onCancel={ws.cancelNewShop} />
  if (phase === 'manual')
    return (
      <GuidedDetails
        mode="new"
        initial={draft.business ?? { ...EMPTY_BUSINESS, currency: defaultCurrency() }}
        initialProducts={draft.products}
        busy={busy === 'review'}
        error={error}
        titleId="new-shop-manual-title"
        onCancel={() => window.history.back()}
        onSubmit={({ fields, products, location }) => {
          setDraft({ business: fields, products })
          if (location) setOwnerLocation(location)
          void openReview(location ?? undefined)
        }}
      />
    )
  if (phase === 'review' && review)
    return (
      <Review
        proposal={review}
        onChange={setReview}
        onBack={() => window.history.back()}
        onAddDietary={() => {
          // Back to the typed chat with the answer started; the coach records it like any other.
          wantVoice.current = false
          focusComposer.current = true
          setTyping(true)
          setNote(`${t.factNames.vegetarian_options}: `)
          window.history.back()
        }}
        onOpened={async (businessId) => {
          if (photoFile.current) setGalleryPhoto({ file: photoFile.current, businessId })
          await ws.finishNewShop(businessId)
        }}
      />
    )

  const voiceOn = voice.state !== 'idle'
  const typingView = typing || !voiceOn
  const problem = preflight ?? voice.problem
  const lastCoach = [...lines].reverse().find((line) => line.role === 'coach')
  // What the coach is saying, as it says it (the live voice, or a typed turn read aloud).
  const caption = (reveal.shown || live || (ttsText ? captionReveal.shown : '')).trim()
  const idle = busy === 'idle'
  const canSend = Boolean(note.trim()) && idle
  const orbBase: OrbPhase =
    voice.state === 'reconnecting'
      ? 'reconnecting'
      : voice.state === 'connecting'
        ? 'connecting'
        : !idle
          ? 'thinking'
          : !voiceOn
            ? 'off'
            : voice.micPaused
              ? 'paused'
              : 'listening'
  const status =
    orbPhase === 'thinking' && busy === 'photo'
      ? t.checkingPhoto
      : v[orbPhase === 'off' ? 'typing' : orbPhase]
  const toggleMuted = () => {
    mutedRef.current = !muted
    if (!muted) stopSpeaking()
    setMuted(!muted)
    // Remembered for the coach chat and the next visit.
    ws.setSpeakReplies(muted)
  }
  const roundButton = (size: number, bg: string, fg: string) => ({
    width: size,
    height: size,
    bgcolor: bg,
    color: fg,
    transition: `transform 160ms ${motion.easing.standard}, background-color 300ms`,
    '&:hover': { bgcolor: bg, filter: 'brightness(0.96)' },
    '&:active': { transform: 'scale(0.94)' },
  })
  const quickActions = (
    <Stack
      direction="row"
      sx={{ gap: 1, flexWrap: 'wrap', justifyContent: { md: 'center' }, flexShrink: 0 }}
    >
      {nameSuggestion && (
        <Chip
          icon={<Store size={18} />}
          label={suggestName(nameSuggestion)}
          data-testid="name-suggestion"
          disabled={!idle}
          color="primary"
          variant="outlined"
          onClick={() => {
            const next = nameSuggestion
            setNameSuggestion(null)
            setDraft({
              ...draftRef.current,
              business: { ...(draftRef.current.business ?? EMPTY_BUSINESS), name: next },
            })
            void say(next)
          }}
          onDelete={() => setNameSuggestion(null)}
          sx={{
            height: 48,
            px: 0.5,
            maxWidth: '100%',
            '& .MuiChip-icon': { color: roles.primary },
          }}
        />
      )}
      <Chip
        icon={<Camera size={18} />}
        label={o.shopPhoto}
        variant="outlined"
        disabled={!idle}
        onClick={() => openCamera()}
        sx={{ height: 48, px: 0.5, flexShrink: 0, '& .MuiChip-icon': { color: roles.primary } }}
      />
      <Chip
        icon={<LocateFixed size={18} />}
        label={f.location}
        variant="outlined"
        disabled={!idle}
        onClick={() => openMap(true)}
        sx={{ height: 48, px: 0.5, flexShrink: 0, '& .MuiChip-icon': { color: roles.primary } }}
      />
      <Chip
        icon={<SkipForward size={18} />}
        label={f.skip}
        variant="outlined"
        disabled={!idle || !lastCoach}
        onClick={skip}
        sx={{ height: 48, px: 0.5, flexShrink: 0, '& .MuiChip-icon': { color: roles.primary } }}
      />
    </Stack>
  )

  const hasActiveMap = lines.some((l) => l.role === 'map' && !l.done)
  const hasActiveCamera = lines.some((l) => l.role === 'camera' && !l.closed)
  const hasActiveCard = hasActiveMap || hasActiveCamera

  return (
    <Box
      data-view={typingView ? 'typing' : 'voice'}
      sx={{
        display: 'grid',
        height: '100dvh',
        width: '100%',
        maxWidth: 1440,
        mx: 'auto',
        px: { xs: hasActiveCard ? 2 : 4, sm: 4, md: 6 },
        columnGap: { md: 5, lg: 6 },
        rowGap: { xs: hasActiveCard ? 1 : 1.5, md: 3 },
        pt: 'env(safe-area-inset-top)',
        pb: 'calc(12px + env(safe-area-inset-bottom))',
        gridTemplateColumns: {
          xs: 'minmax(0, 1fr)',
          md: 'minmax(0, 1fr) minmax(0, 1fr)',
          lg: 'minmax(0, 1fr) minmax(0, 1.2fr) minmax(300px, 380px)',
        },
        // Phone: the conversation takes the height it needs and the stage the rest, so a short
        // conversation leaves a big orb (no dead space) and a long one a compact orb.
        gridTemplateRows: {
          xs: typingView
            ? 'auto auto minmax(0, 1fr) auto auto'
            : hasActiveCard
              ? 'auto auto minmax(0, 1fr) auto auto'
              : 'auto auto minmax(0, max-content) minmax(184px, 1fr) auto',
          md: 'auto auto minmax(0, 1fr) auto',
          lg: 'auto minmax(0, 1fr) auto',
        },
        gridTemplateAreas: {
          xs: '"header" "card" "log" "stage" "controls"',
          md: '"header header" "card stage" "log stage" "log controls"',
          lg: '"header header header" "log stage card" "log controls card"',
        },
        ...enterRise,
      }}
    >
      <Box
        component="header"
        sx={{ gridArea: 'header', display: 'flex', alignItems: 'center', gap: 1, minHeight: 56 }}
      >
        <Tooltip title={t.cancel}>
          <IconButton
            aria-label={t.cancel}
            // Once live, leaving opens the shop (it exists); before, nothing was saved.
            onClick={draft.live_id ? () => void finish(false) : ws.cancelNewShop}
            sx={{ ml: -1 }}
          >
            <X size={22} />
          </IconButton>
        </Tooltip>
        <Typography
          component="h1"
          variant="titleMedium"
          sx={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}
        >
          {t.newShopMode}
        </Typography>
        <Button
          startIcon={<ListChecks size={18} />}
          onClick={() => ws.setNewShopPhase('manual')}
          sx={{ flexShrink: 0, display: { xs: 'none', sm: 'inline-flex' } }}
        >
          {c.typeItIn}
        </Button>
        {/* A phone keeps the title on one line: the same action as a labelled icon (#83). */}
        <Tooltip title={c.typeItIn}>
          <IconButton
            aria-label={c.typeItIn}
            onClick={() => ws.setNewShopPhase('manual')}
            sx={{ flexShrink: 0, width: 48, height: 48, display: { sm: 'none' } }}
          >
            <ListChecks size={22} />
          </IconButton>
        </Tooltip>
        {/* Always there: the owner can end the conversation at any moment (all is saved). */}
        <Button
          color="inherit"
          startIcon={<PhoneOff size={18} />}
          data-testid="end-conversation"
          onClick={endConversation}
          disabled={ended}
          sx={{ mr: -1, flexShrink: 0 }}
        >
          {o.endChat}
        </Button>
      </Box>

      {/* On a phone only the conversation shrinks; the card never folds under it (#83). */}
      <Box
        sx={{
          gridArea: 'card',
          minHeight: { xs: 'auto', md: 0 },
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <ShopFill draft={draft} onReview={() => setReviewOpen(true)} />
      </Box>

      {/* The whole conversation stays on screen and scrolls; the newest line is at the bottom. */}
      <Box
        sx={{
          gridArea: 'log',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          borderRadius: { md: `${shape.lg}px` },
          bgcolor: { md: roles.surfaceContainerLow },
          px: { md: 4 },
          pt: { md: 3 },
        }}
      >
        <Typography
          component="h2"
          variant="labelLarge"
          color="text.secondary"
          sx={{ display: { xs: 'none', md: 'block' }, mb: 1 }}
        >
          {v.conversation}
        </Typography>
        {/* Focusable so the conversation scrolls from the keyboard as well. */}
        <Box
          role="region"
          aria-label={v.conversation}
          tabIndex={0}
          sx={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            '&:focus-visible': { outline: `2px solid ${roles.primary}`, outlineOffset: 2 },
            overscrollBehavior: 'contain',
            // The newest lines sit next to where the owner answers, like any chat.
            display: 'flex',
            flexDirection: 'column',
            '& > [role="log"]': { mt: 'auto' },
            py: 2,
            maskImage: 'linear-gradient(to bottom, transparent 0, #000 20px, #000 100%)',
          }}
        >
          <Box role="log" aria-live="polite" aria-label={t.navCoach}>
            <Stack component="ol" spacing={3} sx={{ listStyle: 'none', m: 0, p: 0 }}>
              {lines.map((line) =>
                line.role === 'camera' ? (
                  !line.closed && (
                    <Box component="li" key={line.id} sx={{ ml: { xs: 0, sm: 6 } }}>
                      <CameraCard
                        shots={line.shots}
                        onPhoto={uploadPhoto}
                        onClose={(quiet) => closeCamera(line.id, quiet)}
                        onActive={() => openCards.current.add(line.id)}
                      />
                    </Box>
                  )
                ) : line.role === 'map' ? (
                  <Box component="li" key={line.id} sx={{ ml: { xs: 0, sm: 6 } }}>
                    <MapCard
                      initial={
                        draft.business?.lat != null && draft.business.lng != null
                          ? { lat: draft.business.lat, lng: draft.business.lng }
                          : null
                      }
                      done={line.done}
                      autoLocate={line.locate}
                      onConfirm={(point) => savePin(line.id, point)}
                      onActive={() => openCards.current.add(line.id)}
                    />
                  </Box>
                ) : line.role === 'summary' ? (
                  <Box component="li" key={line.id} sx={{ ml: { xs: 0, sm: 6 } }}>
                    <SummaryCard
                      draft={draft}
                      busy={finishing}
                      onFace={() => void finish(true)}
                      onSkip={() => void finish(false)}
                    />
                  </Box>
                ) : (
                  <ChatLine key={line.id} line={line} />
                ),
              )}
              {ended && (
                <Box component="li" sx={{ ml: { xs: 0, sm: 6 } }}>
                  <Paper
                    variant="outlined"
                    role="status"
                    data-testid="conversation-ended"
                    sx={{ p: 3, borderRadius: `${shape.lg}px` }}
                  >
                    <Typography variant="titleMedium" component="h3">
                      {o.endedTitle}
                    </Typography>
                    <Typography variant="bodyMedium" color="text.secondary" sx={{ mt: 0.5 }}>
                      {o.endedBody}
                    </Typography>
                    <Button variant="contained" onClick={continueConversation} sx={{ mt: 2 }}>
                      {o.continueChat}
                    </Button>
                  </Paper>
                </Box>
              )}
              {busy === 'reply' && !live && !voiceOn && (
                <Box component="li" sx={{ pl: 6 }}>
                  <CircularProgress size={20} aria-label={t.speaking} />
                </Box>
              )}
            </Stack>
          </Box>
          <div ref={end} />
        </Box>
      </Box>

      {/* The stage: the coach as a chalk orb that reacts to who is talking, and live captions. */}
      <Box
        sx={{
          gridArea: 'stage',
          minHeight: { xs: typingView || hasActiveCard ? 'auto' : 0, md: 0 },
          containerType: { xs: typingView || hasActiveCard ? 'normal' : 'size', md: 'size' },
          // A phone typing with a voice alert open: the alert says what is happening, and the
          // conversation keeps the room (#83).
          display: { xs: problem && typingView ? 'none' : 'flex', md: 'flex' },
          flexDirection: { xs: typingView || hasActiveCard ? 'row' : 'column', md: 'column' },
          alignItems: 'center',
          justifyContent: 'center',
          gap: { xs: typingView || hasActiveCard ? 2 : 1, md: 4 },
          py: { md: 4 },
        }}
      >
        <VoiceOrb
          base={orbBase}
          sample={sampleOrb}
          onPhase={setOrbPhase}
          reducedMotion={reducedMotion}
          size={
            typingView || hasActiveCard
              ? { xs: 44, md: 'clamp(140px, calc(100cqh - 180px), 260px)' }
              : {
                  xs: 'clamp(104px, calc(100cqh - 72px), 220px)',
                  md: 'clamp(140px, calc(100cqh - 180px), 260px)',
                }
          }
        />
        <Box
          data-testid="captions"
          aria-hidden="true"
          sx={{
            minHeight: { xs: typingView || hasActiveCard ? 0 : 48, md: 96 },
            flex: { xs: typingView || hasActiveCard ? 1 : 'none', md: 'none' },
            maxWidth: 560,
            minWidth: 0,
            textAlign: { xs: typingView || hasActiveCard ? 'start' : 'center', md: 'center' },
          }}
        >
          {/* Typing on a phone: the words are already in the chat; the stage says what happens. */}
          {(caption || heard) && !(typingView && !wide) ? (
            <Typography
              component="div"
              key={caption ? 'coach' : 'owner'}
              sx={{
                typography: { xs: 'bodyLarge', md: 'titleLarge' },
                color: caption ? 'text.primary' : 'text.secondary',
                fontStyle: caption ? 'normal' : 'italic',
                overflowWrap: 'anywhere',
                display: '-webkit-box',
                WebkitLineClamp: { xs: 2, md: 4 },
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                ...fieldFade,
              }}
            >
              <Box component="span" sx={visuallyHidden}>
                {f.captions}:{' '}
              </Box>
              {caption ? <RichText content={caption} streaming /> : heard.trim()}
            </Typography>
          ) : (
            <Typography
              variant="labelLarge"
              color="text.secondary"
              key={status}
              sx={{ display: 'block', ...fieldFade }}
            >
              {status}
            </Typography>
          )}
        </Box>
      </Box>
      <Typography role="status" sx={visuallyHidden}>
        {status}
      </Typography>
      <Sheet
        open={reviewOpen}
        onClose={() => setReviewOpen(false)}
        titleId="shop-review-title"
        title={o.reviewTitle}
      >
        <DraftSummary draft={draft} />
      </Sheet>

      <Box
        sx={{
          gridArea: 'controls',
          display: 'flex',
          flexDirection: 'column',
          gap: 1.5,
          minWidth: 0,
          pb: { md: 2 },
        }}
      >
        {problem && (
          <VoiceAlert
            key={`${problem.kind}:${alertKey}`}
            problem={problem}
            onRetry={() => void retryVoice()}
            onType={typeInstead}
            onClose={dismissProblem}
          />
        )}
        {error && (
          <Alert severity="error" onClose={() => setError('')} closeText={v.close}>
            {error}
          </Alert>
        )}
        {stalled !== null && (
          <Alert
            severity="info"
            data-testid="turn-stalled"
            onClose={() => setStalled(null)}
            closeText={v.close}
            action={
              stalled ? (
                <Button color="inherit" size="small" onClick={retryTurn}>
                  {o.retry}
                </Button>
              ) : undefined
            }
          >
            {o.tooSlow}
          </Alert>
        )}
        {quickActions}
        {typingView ? (
          <Box
            component="form"
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
            sx={{
              display: 'flex',
              alignItems: 'flex-end',
              gap: 0.5,
              bgcolor: roles.surfaceContainerHigh,
              borderRadius: `${shape.xl}px`,
              p: 1,
              '&:has(textarea:focus-visible)': { outline: `2px solid ${roles.primary}` },
              ...fieldFade,
            }}
          >
            {canVoice && (
              <Tooltip title={v.talkInstead} disableTouchListener>
                <IconButton aria-label={v.talkInstead} onClick={talkInstead}>
                  <Mic size={22} />
                </IconButton>
              </Tooltip>
            )}
            <Box
              component="textarea"
              ref={messageInput}
              rows={1}
              name="message"
              autoComplete="off"
              value={note}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
                setNote(event.target.value)
                if (event.target.value.trim()) clearSilence()
              }}
              onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  !matchMedia('(pointer: coarse)').matches
                ) {
                  event.preventDefault()
                  void submit()
                }
              }}
              placeholder={t.messagePlaceholder}
              aria-label={t.message}
              maxLength={2000}
              sx={{
                flex: 1,
                minWidth: 0,
                boxSizing: 'border-box',
                height: '48px',
                maxHeight: 'calc(5 * 1.5rem + 24px)',
                m: 0,
                px: 1,
                py: 1.5,
                border: 0,
                outline: 0,
                resize: 'none',
                overflowY: 'auto',
                bgcolor: 'transparent',
                color: 'text.primary',
                font: 'inherit',
                fontSize: '1rem',
                lineHeight: '1.5rem',
                '&::placeholder': {
                  color: 'text.secondary',
                  opacity: 1,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                },
              }}
            />
            <Tooltip title={muted ? f.unmute : f.mute} disableTouchListener>
              <IconButton aria-label={muted ? f.unmute : f.mute} onClick={toggleMuted}>
                {muted ? <VolumeX size={22} /> : <Volume2 size={22} />}
              </IconButton>
            </Tooltip>
            <IconButton
              type="submit"
              onMouseDown={(event) => event.preventDefault()}
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
          </Box>
        ) : (
          // Voice mode controls, like a call: keyboard, the mic (always on unless paused), the
          // coach's voice, and end voice (the conversation carries on by typing).
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: { xs: hasActiveCard ? 2 : 3, md: 4 },
              py: hasActiveCard ? 0.5 : 1,
              ...fieldFade,
            }}
          >
            <Tooltip title={v.typeInstead}>
              <IconButton
                aria-label={v.typeInstead}
                onClick={typeInstead}
                sx={roundButton(
                  hasActiveCard ? 48 : 56,
                  roles.surfaceContainerHigh,
                  roles.onSurface,
                )}
              >
                <Keyboard size={hasActiveCard ? 20 : 24} />
              </IconButton>
            </Tooltip>
            <Tooltip title={v.pauseMic}>
              <IconButton
                aria-label={v.pauseMic}
                aria-pressed={voice.micPaused}
                onClick={() => voice.setMicPaused(!voice.micPaused)}
                sx={
                  voice.micPaused
                    ? {
                        ...roundButton(hasActiveCard ? 56 : 72, roles.surface, roles.onSurface),
                        border: `2px solid ${roles.outline}`,
                      }
                    : roundButton(hasActiveCard ? 56 : 72, roles.primary, roles.onPrimary)
                }
              >
                {voice.micPaused ? (
                  <MicOff size={hasActiveCard ? 24 : 30} />
                ) : (
                  <Mic size={hasActiveCard ? 24 : 30} />
                )}
              </IconButton>
            </Tooltip>
            <Tooltip title={muted ? f.unmute : f.mute}>
              <IconButton
                aria-label={muted ? f.unmute : f.mute}
                onClick={toggleMuted}
                sx={roundButton(
                  hasActiveCard ? 48 : 56,
                  roles.surfaceContainerHigh,
                  roles.onSurface,
                )}
              >
                {muted ? (
                  <VolumeX size={hasActiveCard ? 20 : 24} />
                ) : (
                  <Volume2 size={hasActiveCard ? 20 : 24} />
                )}
              </IconButton>
            </Tooltip>
            <Tooltip title={v.endVoice}>
              <IconButton
                aria-label={v.endVoice}
                onClick={endVoice}
                sx={roundButton(hasActiveCard ? 48 : 56, coral.container, coral.onContainer)}
              >
                <PhoneOff size={hasActiveCard ? 20 : 24} />
              </IconButton>
            </Tooltip>
          </Box>
        )}
      </Box>
    </Box>
  )
}

/** The big welcome: a shop drawn in chalk, the title written out, then one way in. */
function Hero({ onBegin, onCancel }: { onBegin: () => void; onCancel: () => void }) {
  const t = useCopy()
  const f = useNewShopCopy()
  const roles = useTheme().material
  const root = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    heading.current?.focus()
  }, [])
  useChalkTimeline(root, () => {
    const strokes = gsap.utils.toArray<SVGPathElement>('[data-hero-stroke]')
    strokes.forEach((path) => {
      const length = path.getTotalLength()
      gsap.set(path, { strokeDasharray: length, strokeDashoffset: length })
    })
    gsap
      .timeline()
      .to(strokes, { strokeDashoffset: 0, duration: 0.9, ease: 'power2.inOut', stagger: 0.14 })
      .from(
        '[data-hero-title]',
        { clipPath: 'inset(0 100% 0 0)', duration: 0.8, ease: 'power2.out' },
        '-=0.6',
      )
      .from(
        '[data-hero-spark]',
        { scale: 0, rotate: -40, opacity: 0, duration: 0.45, stagger: 0.1, ease: 'back.out(2.2)' },
        '-=0.4',
      )
      .from('[data-hero-rise]', { opacity: 0, y: 18, duration: 0.5, stagger: 0.12 }, '-=0.3')
  })
  return (
    <Box
      ref={root}
      sx={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        px: { xs: 4, sm: 8 },
        pt: 'env(safe-area-inset-top)',
        pb: 'calc(24px + env(safe-area-inset-bottom))',
      }}
    >
      <Box sx={{ minHeight: 56, display: 'flex', alignItems: 'center' }}>
        <Tooltip title={t.cancel}>
          <IconButton aria-label={t.cancel} onClick={onCancel} sx={{ ml: -1 }}>
            <X size={22} />
          </IconButton>
        </Tooltip>
      </Box>
      <Stack
        sx={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          maxWidth: 640,
          mx: 'auto',
          gap: 3,
        }}
      >
        <Box aria-hidden="true" sx={{ position: 'relative', color: roles.primary }}>
          <Box
            data-hero-spark
            sx={{ position: 'absolute', top: -6, left: -18, color: roles.tertiary }}
          >
            <Sparkles size={28} />
          </Box>
          <Box
            data-hero-spark
            sx={{ position: 'absolute', top: 18, right: -22, color: roles.secondary }}
          >
            <Sparkles size={22} />
          </Box>
          <Box
            component="svg"
            viewBox="0 0 160 120"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            sx={{ width: { xs: 200, md: 260 }, height: 'auto', display: 'block' }}
          >
            <path data-hero-stroke d="M28 49L39 22L123 20L135 47" />
            <path
              data-hero-stroke
              d="M28 49Q39 62 50 49Q61 62 72 49Q83 61 94 49Q105 61 116 49Q126 60 135 47"
            />
            <path data-hero-stroke d="M52 25L50 49M75 24L72 49M97 23L94 49M117 23L116 49" />
            <path data-hero-stroke d="M32 52L34 96L130 94L132 52" />
            <path data-hero-stroke d="M48 70L75 69L75 86L48 87Z" />
            <path data-hero-stroke d="M94 96L93 68L115 68L117 95M105 80L108 80" />
            <path data-hero-stroke d="M22 102L141 100" />
            <path data-hero-stroke d="M54 66L58 58L66 66M52 110Q80 116 108 109" />
            <path data-hero-stroke d="M12 28L5 21M144 19L151 12M17 66L8 69M67 12Q80 2 94 11" />
          </Box>
        </Box>
        <Typography
          ref={heading}
          tabIndex={-1}
          component="h1"
          data-hero-title
          sx={{
            fontFamily: HAND_FONT,
            fontSize: { xs: '3.2rem', md: '4.6rem' },
            lineHeight: 1.05,
            textWrap: 'balance',
            color: roles.onSurface,
            '&:focus': { outline: 'none' },
          }}
        >
          {f.title}
        </Typography>
        <Typography
          data-hero-rise
          variant="bodyLarge"
          color="text.secondary"
          sx={{ maxWidth: 440 }}
        >
          {f.heroBody}
        </Typography>
        <Button
          data-hero-rise
          variant="contained"
          size="large"
          startIcon={<Mic size={22} />}
          onClick={onBegin}
          sx={{ minHeight: 56, px: 5, mt: 2, borderRadius: `${shape.full}px`, fontSize: '1.05rem' }}
        >
          {f.begin}
        </Button>
      </Stack>
    </Box>
  )
}

/** The shop as it stands: name, kind, place, hours, photo (and Live once it is). */
function DraftSummary({ draft }: { draft: Draft }) {
  const t = useCopy()
  const o = useOnboardingCopy()
  const roles = useTheme().material
  const b = draft.business
  const skipped = new Set(draft.skipped ?? [])
  const row = (key: string, label: string, value: ReactNode, filled: boolean) => (
    <Box
      component="li"
      data-field={key}
      data-filled={filled}
      sx={{ display: 'grid', gridTemplateColumns: 'minmax(88px, auto) 1fr', gap: 2, py: 1 }}
    >
      <Typography variant="labelLarge" color="text.secondary">
        {label}
      </Typography>
      <Box sx={{ color: filled ? 'text.primary' : 'text.secondary', overflowWrap: 'anywhere' }}>
        {value}
      </Box>
    </Box>
  )
  const hours = b?.hours || b?.weekly_hours?.length
  return (
    <Stack spacing={1} data-testid="draft-summary">
      {draft.live_id && (
        <Chip
          icon={<Store size={16} />}
          label={o.liveNow}
          sx={{ alignSelf: 'flex-start', bgcolor: roles.primaryContainer }}
        />
      )}
      <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
        {row('name', t.fields.name, b?.name || o.notYet, Boolean(b?.name))}
        {row('category', t.fields.category, b?.category || o.notYet, Boolean(b?.category))}
        {row(
          'location',
          t.fields.location,
          b && b.lat != null ? <LocationPin fields={b} /> : b?.location || o.notYet,
          hasPlace(draft),
        )}
        {row(
          'hours',
          t.fields.hours,
          hours ? (
            <>
              {b?.hours && <Typography>{b.hours}</Typography>}
              <HoursList hours={b?.weekly_hours} />
            </>
          ) : skipped.has('hours') ? (
            o.addLater
          ) : (
            o.notYet
          ),
          Boolean(hours),
        )}
        {row(
          'photo',
          o.shopPhoto,
          draft.photo ? o.photoAdded : skipped.has('photo') ? o.addLater : o.notYet,
          Boolean(draft.photo),
        )}
      </Box>
    </Stack>
  )
}

/** The one summary at the end, then the optional face check (skippable; Today reminds). */
function SummaryCard({
  draft,
  busy,
  onFace,
  onSkip,
}: {
  draft: Draft
  busy: boolean
  onFace: () => void
  onSkip: () => void
}) {
  const o = useOnboardingCopy()
  const roles = useTheme().material
  return (
    <Box
      data-testid="shop-summary"
      sx={{
        p: 3,
        borderRadius: `${shape.lg}px`,
        bgcolor: roles.surfaceContainerLow,
        border: `1px solid ${roles.outlineVariant}`,
        ...enterRise,
      }}
    >
      <Typography component="h2" variant="titleLarge" sx={{ mb: 1 }}>
        {o.summaryTitle}
      </Typography>
      <DraftSummary draft={draft} />
      <Divider sx={{ my: 2 }} />
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'flex-start', mb: 2 }}>
        <ShieldCheck size={20} color={roles.primary} aria-hidden="true" />
        <Typography variant="bodyMedium">{o.faceOffer}</Typography>
      </Stack>
      <Stack direction="row" sx={{ gap: 1, flexWrap: 'wrap' }}>
        <Button
          variant="contained"
          disabled={busy}
          startIcon={
            busy ? <CircularProgress size={18} color="inherit" /> : <ShieldCheck size={18} />
          }
          onClick={onFace}
          sx={{ minHeight: 48 }}
        >
          {o.faceStart}
        </Button>
        <Button disabled={busy} onClick={onSkip} sx={{ minHeight: 48 }}>
          {o.skipForNow}
        </Button>
      </Stack>
    </Box>
  )
}

function ChatLine({ line }: { line: Exclude<Line, { role: 'camera' | 'map' | 'summary' }> }) {
  const t = useCopy()
  const f = useNewShopCopy()
  const roles = useTheme().material
  if (line.role === 'owner')
    return (
      <Box component="li" sx={{ display: 'flex', justifyContent: 'flex-end', ...enterRise }}>
        <Box sx={chatBubbleStyle(roles)}>
          <Typography component="span" sx={visuallyHidden}>
            {t.you}:{' '}
          </Typography>
          {line.photo ? (
            <Box
              component="img"
              src={line.photo}
              alt={f.photo}
              sx={{
                display: 'block',
                maxWidth: 200,
                maxHeight: 200,
                borderRadius: `${shape.md}px`,
              }}
            />
          ) : (
            <PlainText text={line.text} />
          )}
        </Box>
      </Box>
    )
  if (line.role === 'action')
    return (
      <Box
        component="li"
        data-testid="agent-action"
        sx={{
          ml: 6,
          p: 2,
          borderRadius: `${shape.md}px`,
          borderInlineStart: `3px solid ${roles.primary}`,
          bgcolor: roles.surfaceContainerLow,
          ...enterRise,
        }}
      >
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', color: roles.primary }}>
          <Check size={18} aria-hidden="true" />
          <Typography variant="labelLarge">{line.title}</Typography>
        </Stack>
        <Box component="ul" sx={{ m: 0, mt: 1, pl: 3.5 }}>
          {line.items.map((item) => (
            <Typography
              component="li"
              variant="bodyMedium"
              key={item}
              sx={{ overflowWrap: 'anywhere' }}
            >
              {item}
            </Typography>
          ))}
        </Box>
      </Box>
    )
  return (
    <Stack
      component="li"
      direction="row"
      spacing={2}
      sx={{ alignItems: 'flex-start', ...enterRise }}
    >
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
          {t.coach}:{' '}
        </Typography>
        <RichText content={line.text} />
      </Box>
    </Stack>
  )
}

/** The one sealed review, as a page of the flow. Saving happens only from its one button. */
function Review({
  proposal,
  onChange,
  onBack,
  onAddDietary,
  onOpened,
}: {
  proposal: Proposal
  onChange: (proposal: Proposal) => void
  onBack: () => void
  onAddDietary: () => void
  onOpened: (businessId: string) => Promise<void>
}) {
  const t = useCopy()
  const next = useNextStepsCopy()
  const f = useNewShopCopy()
  const ws = useWorkspace()
  const shopCopy = useShopCopy()
  const pinCopy = discoverCopy(useLocale())
  const roles = useTheme().material
  const title = useRef<HTMLHeadingElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fields = proposal.snapshot.business ?? EMPTY_BUSINESS
  const currency = fields.currency ?? defaultCurrency()
  useEffect(() => {
    title.current?.focus()
  }, [])
  async function findPin() {
    setBusy(true)
    setError('')
    try {
      const pinned = await ws.api<Proposal>('/proposals', {
        method: 'POST',
        body: JSON.stringify({ ...proposal.snapshot, business_id: null, geocode_confirmed: true }),
      })
      onChange({ ...pinned, new_shop: true, photo_notes: proposal.photo_notes })
    } catch {
      setError(pinCopy.pinError)
    } finally {
      setBusy(false)
    }
  }
  async function open() {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const receipt = await ws.api<{ business_id: string }>(`/proposals/${proposal.id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ digest: proposal.digest }),
      })
      await onOpened(receipt.business_id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.actionFailed)
      setBusy(false)
    }
  }
  const section = (label: string, children: ReactNode) => (
    <Box>
      <Typography component="h3" variant="titleSmall" color="text.secondary" sx={{ mb: 1 }}>
        {label}
      </Typography>
      {children}
    </Box>
  )
  return (
    <Box
      component="section"
      aria-labelledby="new-shop-review-title"
      data-testid="new-shop-review"
      sx={{
        maxWidth: 720,
        mx: 'auto',
        px: { xs: 4, sm: 6 },
        pt: 'env(safe-area-inset-top)',
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        ...enterRise,
      }}
    >
      <Box sx={{ minHeight: 56, display: 'flex', alignItems: 'center' }}>
        <Button
          startIcon={<ArrowLeft size={20} />}
          onClick={onBack}
          disabled={busy}
          sx={{ ml: -1 }}
        >
          {f.backToChat}
        </Button>
      </Box>
      <Typography
        ref={title}
        tabIndex={-1}
        id="new-shop-review-title"
        component="h1"
        sx={{
          fontFamily: HAND_FONT,
          fontSize: { xs: '2.6rem', md: '3.4rem' },
          lineHeight: 1.1,
          '&:focus': { outline: 'none' },
        }}
      >
        {f.reviewTitle}
      </Typography>
      <Typography variant="bodyMedium" color="text.secondary" sx={{ mt: 1, mb: 3 }}>
        {t.reviewNote}
      </Typography>
      <Box
        sx={{
          border: `1px solid ${roles.outlineVariant}`,
          borderRadius: `${shape.lg}px`,
          overflow: 'hidden',
        }}
      >
        <Box
          sx={{
            p: { xs: 3, sm: 4 },
            bgcolor: roles.primaryContainer,
            color: roles.onPrimaryContainer,
          }}
        >
          <Typography component="h2" variant="headlineMedium" sx={{ overflowWrap: 'anywhere' }}>
            {fields.name}
          </Typography>
          {fields.category && (
            <Typography variant="bodyLarge" sx={{ mt: 1 }}>
              {fields.category}
            </Typography>
          )}
        </Box>
        <Stack spacing={3} divider={<Divider flexItem />} sx={{ p: { xs: 3, sm: 4 } }}>
          {(fields.description || fields.phone || fields.hours || fields.weekly_hours?.length) && (
            <Stack spacing={1}>
              {fields.description && (
                <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {fields.description}
                </Typography>
              )}
              {fields.phone && <Typography>{fields.phone}</Typography>}
              {fields.hours && <Typography>{fields.hours}</Typography>}
              <HoursList hours={fields.weekly_hours} />
            </Stack>
          )}
          {section(
            t.products,
            proposal.snapshot.products.length ? (
              <Stack component="ul" spacing={1.5} sx={{ p: 0, m: 0, listStyle: 'none' }}>
                {proposal.snapshot.products.map((product) => (
                  <Box
                    component="li"
                    key={product.name + product.unit}
                    sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}
                  >
                    <Typography sx={{ overflowWrap: 'anywhere', minWidth: 0 }}>
                      {product.name}
                    </Typography>
                    <Typography sx={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                      {formatPrice(product.price, currency)} / {unitLabel(product.unit, shopCopy)}
                    </Typography>
                  </Box>
                ))}
              </Stack>
            ) : (
              <Typography color="text.secondary">{t.itemCount(0)}</Typography>
            ),
          )}
          {section(
            t.fields.location,
            <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
              {fields.lat != null ? (
                <LocationPin fields={fields} />
              ) : (
                <Typography color={fields.location ? 'text.primary' : 'text.secondary'}>
                  {fields.location || '—'}
                </Typography>
              )}
              {fields.pin_demo && <Typography variant="bodySmall">{pinCopy.demo}</Typography>}
              {fields.location && (fields.lat == null || fields.pin_demo) && (
                <Button disabled={busy} onClick={() => void findPin()}>
                  {pinCopy.findPin}
                </Button>
              )}
            </Stack>,
          )}
          {factEntries(fields, t).length > 0 && <FactList fields={fields} />}
          {dietaryMissing(fields) &&
            section(
              next.dietaryTitle,
              <Stack spacing={1} sx={{ alignItems: 'flex-start' }} data-testid="dietary-optional">
                <Typography color="text.secondary">{next.dietaryOptional}</Typography>
                <Button
                  variant="outlined"
                  startIcon={<Leaf size={18} />}
                  disabled={busy}
                  onClick={onAddDietary}
                >
                  {next.addDietary}
                </Button>
              </Stack>,
            )}
        </Stack>
      </Box>
      {Boolean(proposal.photo_notes?.length) && (
        <Alert severity="info" sx={{ mt: 3 }}>
          <AlertTitle>{t.photoReviewNotes}</AlertTitle>
          {proposal.photo_notes?.map((item) => (
            <Typography key={item} variant="bodySmall">
              {item}
            </Typography>
          ))}
        </Alert>
      )}
      {error && (
        <Alert severity="error" sx={{ mt: 3 }}>
          {error}
        </Alert>
      )}
      <Box
        sx={{
          position: 'sticky',
          bottom: 0,
          mt: 'auto',
          pt: 3,
          pb: 'calc(16px + env(safe-area-inset-bottom))',
          bgcolor: roles.surface,
        }}
      >
        <Button
          fullWidth
          variant="contained"
          size="large"
          disabled={busy}
          startIcon={busy ? <CircularProgress size={20} color="inherit" /> : <Store size={22} />}
          onClick={() => void open()}
          sx={{ minHeight: 56, borderRadius: `${shape.full}px` }}
        >
          {f.open}
        </Button>
      </Box>
    </Box>
  )
}
