import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  IconButton,
  InputBase,
  Skeleton,
  Stack,
  Typography,
  useTheme,
} from '@mui/material'
import { ArrowLeft, ArrowUp, Check, MessageCircle, RotateCcw, Sparkles, Store } from 'lucide-react'
import { followInquiries } from '../../api/inquiryStream'
import { useLocale } from '../../state/hooks'
import { customerBack, customerNavigate } from '../frontdoors/navigation'
import { PlaceImage } from '../frontdoors/PlaceImage'
import { useCustomer } from './account'
import { clockTime, useAccountCopy } from './copy'
import type { AccountCopy } from './copy'
import { PlainText, RichText } from '../../design/RichText'
import { SignInButton } from './SignIn'
import { fill } from '../passport/copy'
import { useRescueCopy } from '../rescue/copy'
import type { RescueStrings } from '../rescue/copy'
import { rescueMarker } from '../rescue/marker'
import { formatMoneyText } from '../inquiries/formatMoneyText'
import { chatPath, reduceMotion } from './paths'
import './customer.css'

import type { ChatSummary, Message, ShopCard, Thread } from './types'
export type { ChatSummary }

export function ShopAvatar({
  shop,
  size = 52,
  name,
}: {
  shop: Pick<ShopCard, 'id' | 'category' | 'photo_url'>
  size?: number
  /** A view-transition name: the avatar morphs between the list and the thread header. */
  name?: string
}) {
  const roles = useTheme().material
  return (
    <Box
      aria-hidden="true"
      sx={{
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: '50%',
        overflow: 'hidden',
        bgcolor: roles.surfaceContainerHigh,
        viewTransitionName: name,
      }}
    >
      <PlaceImage id={shop.id} category={shop.category ?? ''} photo={shop.photo_url} compact />
    </Box>
  )
}

/** A rescue hold's chat marker, in the reader's words; any other message as written. */
function shown(text: string, r: RescueStrings) {
  const hold = rescueMarker(text)
  return hold ? fill(r.holdRequest, { n: hold.qty, item: hold.item }) : text
}

function preview(message: Message | undefined, t: AccountCopy, r: RescueStrings) {
  if (!message) return ''
  const prefix =
    message.author === 'customer'
      ? `${t.you}: `
      : message.kind === 'ai'
        ? `${t.aiLabel}: `
        : message.kind === 'demo'
          ? `${t.demoReply}: `
          : ''
  return prefix + shown(message.text, r)
}

/** The Chats tab: one row per shop, newest first, like a messaging app. */
export function ChatList() {
  const roles = useTheme().material
  const locale = useLocale()
  const account = useCustomer()
  const t = useAccountCopy()
  const r = useRescueCopy()
  const [chats, setChats] = useState<ChatSummary[] | null>(null)
  const [failed, setFailed] = useState(false)
  const signedIn = account.status === 'signed-in' || account.status === 'guest'
  const { api } = account
  const load = useCallback(
    () =>
      api<ChatSummary[]>('/api/v1/customer/threads').then(
        (value) => {
          setChats(value)
          setFailed(false)
        },
        () => setFailed(true),
      ),
    [api],
  )
  useEffect(() => {
    document.title = `${t.chatsTitle} · Chalkboard`
  }, [t])
  useEffect(() => {
    if (!signedIn) return
    void load()
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, 8_000)
    return () => clearInterval(timer)
  }, [signedIn, load])

  return (
    <Box component="main" sx={{ maxWidth: 720, mx: 'auto', px: 2, pb: 14 }}>
      <Typography
        component="h1"
        variant="headlineMedium"
        sx={{ pt: 1, pb: 2, px: 1, fontWeight: 600 }}
      >
        {t.chatsTitle}
      </Typography>
      {account.status === 'loading' ? null : !signedIn ? (
        <Stack spacing={3} className="c-rise" sx={{ px: 1, pt: 4, textAlign: 'center' }}>
          <Box
            aria-hidden="true"
            sx={{
              mx: 'auto',
              width: 88,
              height: 88,
              borderRadius: '28px',
              display: 'grid',
              placeItems: 'center',
              bgcolor: roles.secondaryContainer,
              color: roles.onSecondaryContainer,
            }}
          >
            <MessageCircle size={40} />
          </Box>
          <Typography component="h2" variant="titleLarge">
            {t.chatsSignedOut}
          </Typography>
          <Typography color="text.secondary">{t.signInBody}</Typography>
          <SignInButton />
        </Stack>
      ) : failed && !chats ? (
        <Alert
          severity="error"
          action={
            <Button
              color="inherit"
              size="small"
              startIcon={<RotateCcw size={16} />}
              onClick={() => void load()}
            >
              {t.retry}
            </Button>
          }
        >
          {t.chatsFailed}
        </Alert>
      ) : !chats ? (
        <Stack spacing={1}>
          {[0, 1, 2].map((n) => (
            <Stack key={n} direction="row" spacing={2} sx={{ p: 2, alignItems: 'center' }}>
              <Skeleton variant="circular" width={52} height={52} />
              <Box sx={{ flex: 1 }}>
                <Skeleton width="50%" />
                <Skeleton width="80%" />
              </Box>
            </Stack>
          ))}
        </Stack>
      ) : chats.length === 0 ? (
        <Stack spacing={2} className="c-rise" sx={{ px: 1, pt: 4, textAlign: 'center' }}>
          <Typography component="h2" variant="titleLarge">
            {t.noChats}
          </Typography>
          <Typography color="text.secondary">{t.noChatsBody}</Typography>
          <Button
            component="a"
            href="/explore/"
            onClick={customerNavigate}
            variant="contained"
            sx={{ alignSelf: 'center' }}
          >
            {t.findShops}
          </Button>
        </Stack>
      ) : (
        <Box component="ul" aria-label={t.chatsTitle} sx={{ listStyle: 'none', m: 0, p: 0 }}>
          {chats.map((chat, index) => {
            const last = chat.thread.messages.at(-1)
            const href = chatPath(chat.shop.id, chat.thread.id)
            return (
              <li key={chat.thread.id} className="c-rise" style={{ ['--i' as string]: index }}>
                <Box
                  component="a"
                  href={href}
                  className="c-press"
                  onClick={(event: MouseEvent<HTMLAnchorElement>) => {
                    // Only the opened row's avatar takes part in the morph.
                    const avatar = event.currentTarget.querySelector<HTMLElement>('[data-avatar]')
                    if (avatar) avatar.style.viewTransitionName = 'chat-avatar'
                    customerNavigate(event)
                  }}
                  sx={{
                    display: 'flex',
                    gap: 2,
                    alignItems: 'center',
                    p: 2,
                    borderRadius: '20px',
                    color: 'inherit',
                    textDecoration: 'none',
                    '&:hover': { bgcolor: roles.surfaceContainerLow },
                    '&:focus-visible': { outline: `3px solid ${roles.primary}`, outlineOffset: -2 },
                  }}
                >
                  <Box data-avatar sx={{ borderRadius: '50%' }}>
                    <ShopAvatar shop={chat.shop} />
                  </Box>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline' }}>
                      <Typography
                        variant="titleMedium"
                        noWrap
                        sx={{ flex: 1, fontWeight: chat.unread ? 700 : 500 }}
                      >
                        {chat.shop.name}
                      </Typography>
                      {last && (
                        <Typography
                          variant="labelSmall"
                          sx={{
                            color: chat.unread ? roles.primary : 'text.secondary',
                            fontWeight: chat.unread ? 700 : 400,
                          }}
                        >
                          {clockTime(last.created, locale)}
                        </Typography>
                      )}
                    </Stack>
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 0.25 }}>
                      {chat.shop.demo && (
                        <Chip
                          label={t.demoShop}
                          size="small"
                          sx={{
                            height: 20,
                            fontSize: 11,
                            bgcolor: roles.tertiaryContainer,
                            color: roles.onTertiaryContainer,
                          }}
                        />
                      )}
                      <Typography
                        variant="bodyMedium"
                        noWrap
                        sx={{
                          flex: 1,
                          color: chat.unread ? roles.onSurface : 'text.secondary',
                          fontWeight: chat.unread ? 600 : 400,
                        }}
                      >
                        {preview(last, t, r)}
                      </Typography>
                      {chat.unread > 0 && (
                        <Box
                          key={chat.unread}
                          className="c-pop"
                          aria-label={t.unread(chat.unread)}
                          role="img"
                          sx={{
                            minWidth: 22,
                            height: 22,
                            px: 1,
                            borderRadius: 999,
                            bgcolor: roles.primary,
                            color: roles.onPrimary,
                            fontSize: 12,
                            fontWeight: 700,
                            display: 'grid',
                            placeItems: 'center',
                          }}
                        >
                          {chat.unread}
                        </Box>
                      )}
                    </Stack>
                  </Box>
                </Box>
              </li>
            )
          })}
        </Box>
      )}
    </Box>
  )
}

type Pending = { id: string; text: string; state: 'sending' | 'failed' }

/** One WhatsApp-style thread: bubbles, labelled AI and demo replies, live owner replies. */
export function ChatThread({ shop: shopId, thread: threadId }: { shop: string; thread: string }) {
  const roles = useTheme().material
  const locale = useLocale()
  const account = useCustomer()
  const t = useAccountCopy()
  const [summary, setSummary] = useState<ChatSummary | null>(null)
  const [lost, setLost] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [live, setLive] = useState(true)
  const [text, setText] = useState('')
  const [pending, setPending] = useState<Pending[]>([])
  // Messages already there on open don't animate; new ones do.
  const [initial, setInitial] = useState<Set<string> | null>(null)
  const end = useRef<HTMLLIElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const sent = useRef(0)
  const path = `/api/v1/customer/shops/${encodeURIComponent(shopId)}/threads/${encodeURIComponent(threadId)}`
  const signedIn = account.status === 'signed-in' || account.status === 'guest'
  const { api, raw, refreshUnread } = account

  const apply = useCallback((next: ChatSummary | Thread) => {
    setSummary((current) => {
      if ('shop' in next) return next
      return current ? { ...current, thread: next } : current
    })
  }, [])

  useEffect(() => {
    if (!signedIn) return
    const abort = new AbortController()
    api<ChatSummary>(path, { signal: abort.signal })
      .then((value) => {
        setLoadFailed(false)
        setInitial((current) => current ?? new Set(value.thread.messages.map((m) => m.id)))
        apply(value)
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return
        if (error instanceof Error && error.message === '404') setLost(true)
        else setLoadFailed(true)
      })
    // Owner replies arrive live over the same thread signal the owner app uses.
    void followInquiries(
      (init) => raw(path + '/stream', init),
      abort.signal,
      (value) => {
        if (abort.signal.aborted) return
        if (value && typeof value === 'object' && 'unavailable' in value) {
          setLost(true)
          return
        }
        setLive(true)
        apply(value as Thread)
      },
    ).catch(() => {
      if (abort.signal.aborted) return
      setLive(false)
    })
    return () => abort.abort()
  }, [signedIn, path, api, raw, apply, attempt])
  const shopName = summary?.shop.name
  useEffect(() => {
    if (shopName) document.title = `${shopName} · ${t.chatsTitle}`
  }, [shopName, t])

  // Fallback polling only when the live stream is unavailable.
  useEffect(() => {
    if (live || !signedIn) return
    const timer = setInterval(() => {
      void api<ChatSummary>(path)
        .then((value) => {
          apply(value)
          setLoadFailed(false)
        })
        .catch(() => setLoadFailed(true))
    }, 5_000)
    return () => clearInterval(timer)
  }, [live, signedIn, api, path, apply])

  const messages = summary?.thread.messages ?? []
  const lastId = messages.at(-1)?.id
  useEffect(() => {
    if (!lastId || document.visibilityState !== 'visible') return
    void api(path + '/seen', { method: 'POST', body: JSON.stringify({ message_id: lastId }) })
      .then(refreshUnread)
      .catch(() => undefined)
  }, [lastId, api, path, refreshUnread])

  useLayoutEffect(() => {
    end.current?.scrollIntoView({ block: 'end', behavior: reduceMotion() ? 'auto' : 'smooth' })
  }, [messages.length, pending.length])

  async function send(value = text, retry?: string) {
    const body = value.trim()
    if (
      !body ||
      Array.from(body).length > 500 ||
      !summary ||
      lost ||
      summary.thread.done ||
      summary.thread.blocked
    )
      return
    const id = retry ?? `pending-${++sent.current}`
    setPending((list) =>
      retry
        ? list.map((p) => (p.id === retry ? { ...p, state: 'sending' } : p))
        : [...list, { id, text: body, state: 'sending' }],
    )
    if (!retry) setText('')
    try {
      const next = await api<ChatSummary>(path + '/messages', {
        method: 'POST',
        body: JSON.stringify({ text: body, language: locale }),
      })
      setPending((list) => list.filter((p) => p.id !== id))
      apply(next)
    } catch {
      setPending((list) => list.map((p) => (p.id === id ? { ...p, state: 'failed' } : p)))
    }
    input.current?.focus()
  }

  const shop = summary?.shop
  const human = messages.filter((m) => m.kind !== 'ai')
  const waiting = !summary?.thread.done && human.length > 0 && human.at(-1)!.author === 'customer'
  const closed = !!summary?.thread.done || !!summary?.thread.blocked

  if (!signedIn && account.status !== 'loading')
    return (
      <Box component="main" sx={{ maxWidth: 560, mx: 'auto', px: 3, pt: 10 }}>
        <Typography component="h1" variant="titleLarge" sx={{ mb: 2 }}>
          {t.signInTitle}
        </Typography>
        <SignInButton />
      </Box>
    )

  return (
    <Box
      component="main"
      sx={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: roles.surface,
      }}
    >
      {/* Header: back, the shop (shared element from the list), live state. */}
      <Stack
        direction="row"
        spacing={2}
        sx={{
          position: 'sticky',
          top: 0,
          zIndex: 3,
          alignItems: 'center',
          px: 1,
          pt: 'calc(env(safe-area-inset-top) + 8px)',
          pb: 1,
          bgcolor: roles.surfaceContainer,
          borderBottom: `1px solid ${roles.outlineVariant}`,
        }}
      >
        <IconButton
          component="a"
          href="/explore/chats"
          onClick={customerBack}
          aria-label={t.back}
          sx={{ width: 48, height: 48 }}
        >
          <ArrowLeft size={22} />
        </IconButton>
        {shop ? (
          <Box
            component="a"
            href={`/explore/s/${encodeURIComponent(shop.id)}`}
            onClick={customerNavigate}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 2,
              minWidth: 0,
              minHeight: 48,
              color: 'inherit',
              textDecoration: 'none',
              borderRadius: 2,
              '&:focus-visible': { outline: `3px solid ${roles.primary}` },
            }}
          >
            <ShopAvatar shop={shop} size={40} name="chat-avatar" />
            <Box sx={{ minWidth: 0 }}>
              <Typography component="h1" variant="titleMedium" noWrap sx={{ fontWeight: 600 }}>
                {shop.name}
              </Typography>
              <Typography variant="labelSmall" color="text.secondary" noWrap component="p">
                {shop.demo ? `${t.demoShop} · ` : ''}
                {live ? t.viewShop : t.reconnecting}
              </Typography>
            </Box>
          </Box>
        ) : (
          <Skeleton variant="circular" width={40} height={40} />
        )}
      </Stack>

      <Box
        component="ol"
        aria-label={shop?.name}
        aria-live="polite"
        sx={{
          flex: 1,
          listStyle: 'none',
          m: 0,
          px: 2,
          pt: 2,
          pb: 2,
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
          maxWidth: 720,
          width: '100%',
          mx: 'auto',
        }}
      >
        {lost && (
          <Alert severity="warning" component="li">
            {t.chatLost}
          </Alert>
        )}
        {loadFailed && !lost && (
          <Alert
            component="li"
            severity="error"
            action={
              <Button color="inherit" onClick={() => setAttempt((n) => n + 1)}>
                {t.retry}
              </Button>
            }
          >
            {t.chatsFailed}
          </Alert>
        )}
        {!summary && !lost && !loadFailed && (
          <Box component="li" aria-busy="true">
            <Skeleton variant="rounded" height={64} />
            <Skeleton variant="rounded" height={48} sx={{ mt: 2, ml: '25%' }} />
          </Box>
        )}
        {messages.map((message, index) => (
          <Bubble
            key={message.id}
            message={message}
            locale={locale}
            animate={initial ? !initial.has(message.id) : false}
            grouped={index > 0 && messages[index - 1]?.author === message.author}
          />
        ))}
        {pending.map((item) => (
          <Box
            component="li"
            key={item.id}
            className="c-send"
            sx={{ alignSelf: 'flex-end', maxWidth: '82%' }}
          >
            <Box
              component={item.state === 'failed' ? 'button' : 'div'}
              onClick={item.state === 'failed' ? () => void send(item.text, item.id) : undefined}
              sx={{
                all: item.state === 'failed' ? 'unset' : undefined,
                display: 'block',
                px: 2,
                py: 1.25,
                borderRadius: '20px 20px 6px 20px',
                bgcolor: roles.primary,
                color: roles.onPrimary,
                opacity: item.state === 'sending' ? 0.75 : 1,
                cursor: item.state === 'failed' ? 'pointer' : undefined,
              }}
            >
              <Typography variant="bodyLarge" sx={{ overflowWrap: 'anywhere' }}>
                {item.text}
              </Typography>
            </Box>
            <Typography
              variant="labelSmall"
              sx={{ display: 'block', textAlign: 'right', mt: 0.5 }}
              color={item.state === 'failed' ? 'error' : 'text.secondary'}
            >
              {item.state === 'failed' ? t.failed : t.sending}
            </Typography>
          </Box>
        ))}
        {waiting && pending.length === 0 && (
          <Box component="li" className="c-rise" sx={{ alignSelf: 'flex-start', mt: 0.5 }}>
            {shop?.demo ? (
              <Stack
                direction="row"
                spacing={1}
                sx={{
                  alignItems: 'center',
                  px: 2,
                  py: 1.25,
                  borderRadius: '20px 20px 20px 6px',
                  bgcolor: roles.surfaceContainerHigh,
                  color: roles.onSurfaceVariant,
                }}
              >
                <Box className="c-typing" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </Box>
                <Typography variant="labelMedium">
                  {t.typing.replace('{shop}', shop.name)}
                </Typography>
              </Stack>
            ) : (
              <Typography variant="bodySmall" color="text.secondary">
                {t.waiting}
              </Typography>
            )}
          </Box>
        )}
        <li ref={end} aria-hidden="true" />
      </Box>

      {/* Composer, pinned above the keyboard and the home indicator. */}
      <Box
        component="form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
        sx={{
          position: 'sticky',
          bottom: 0,
          zIndex: 3,
          px: 2,
          pt: 1,
          pb: 'calc(env(safe-area-inset-bottom) + 10px)',
          bgcolor: roles.surfaceContainer,
          borderTop: `1px solid ${roles.outlineVariant}`,
        }}
      >
        {closed ? (
          <Typography
            variant="bodyMedium"
            color="text.secondary"
            sx={{ p: 2, textAlign: 'center' }}
          >
            {t.closed}
          </Typography>
        ) : (
          <Stack
            direction="row"
            spacing={1}
            sx={{ maxWidth: 720, mx: 'auto', alignItems: 'flex-end' }}
          >
            <InputBase
              inputRef={input}
              disabled={!summary || lost}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={t.messagePlaceholder}
              multiline
              maxRows={4}
              inputProps={{
                'aria-label': t.messagePlaceholder,
                maxLength: 500,
                enterKeyHint: 'send',
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void send()
                }
              }}
              sx={{
                flex: 1,
                px: 3,
                py: 1.25,
                minHeight: 48,
                borderRadius: '24px',
                bgcolor: roles.surfaceContainerHighest,
                fontSize: 16,
              }}
            />
            <IconButton
              type="submit"
              aria-label={t.send}
              disabled={!text.trim() || !summary || lost}
              sx={{
                width: 48,
                height: 48,
                bgcolor: roles.primary,
                color: roles.onPrimary,
                transition: 'transform 200ms var(--c-spring), background-color 200ms',
                '&:hover': { bgcolor: roles.primary },
                '&.Mui-disabled': {
                  bgcolor: roles.surfaceContainerHighest,
                  color: roles.onSurfaceVariant,
                },
              }}
            >
              <ArrowUp size={22} />
            </IconButton>
          </Stack>
        )}
      </Box>
    </Box>
  )
}

function Bubble({
  message,
  locale,
  animate,
  grouped,
}: {
  message: Message
  locale: string
  animate: boolean
  grouped: boolean
}) {
  const roles = useTheme().material
  const t = useAccountCopy()
  const r = useRescueCopy()
  const mine = message.author === 'customer'
  const ai = message.kind === 'ai'
  const demo = message.kind === 'demo'
  return (
    <Box
      component="li"
      className={animate ? (mine ? 'c-send' : 'c-receive') : undefined}
      sx={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '82%', mt: grouped ? 0 : 1 }}
    >
      {(ai || demo) && (
        <Stack
          direction="row"
          spacing={1}
          sx={{
            alignItems: 'center',
            mb: 0.5,
            color: ai ? roles.tertiary : roles.onSurfaceVariant,
          }}
        >
          {ai ? <Sparkles size={14} aria-hidden="true" /> : <Store size={14} aria-hidden="true" />}
          <Typography variant="labelMedium" sx={{ fontWeight: 700 }}>
            {ai ? t.aiLabel : t.demoReply}
          </Typography>
          <Typography variant="labelSmall" color="text.secondary">
            · {ai ? t.aiNote : t.demoReplyNote}
          </Typography>
        </Stack>
      )}
      <Box
        sx={{
          // Anchors the screen-reader label inside the bubble, so it can't widen the page.
          position: 'relative',
          px: 2,
          py: 1.25,
          borderRadius: mine ? '20px 20px 6px 20px' : '20px 20px 20px 6px',
          bgcolor: mine
            ? roles.primary
            : ai
              ? roles.secondaryContainer
              : roles.surfaceContainerHigh,
          color: mine ? roles.onPrimary : ai ? roles.onSecondaryContainer : roles.onSurface,
          border: ai ? `1px dashed ${roles.secondary}` : undefined,
        }}
      >
        {/* Screen readers hear who said it, not only the bubble side. */}
        <Typography component="span" sx={visuallyHidden}>
          {mine ? t.you : ai ? t.aiLabel : demo ? t.demoReply : t.owner}:{' '}
        </Typography>
        {ai || demo ? (
          <RichText content={shown(formatMoneyText(message.text, locale), r)} />
        ) : (
          <PlainText text={shown(message.text, r)} />
        )}
      </Box>
      <Stack
        direction="row"
        spacing={0.5}
        sx={{
          mt: 0.25,
          justifyContent: mine ? 'flex-end' : 'flex-start',
          alignItems: 'center',
          color: 'text.secondary',
        }}
      >
        <Typography variant="labelSmall">{clockTime(message.created, locale)}</Typography>
        {mine && <Check size={14} aria-label={t.delivered} />}
      </Stack>
    </Box>
  )
}

// Pixel strings: in sx a bare 1 means 100%, which stretched these labels across the page.
const visuallyHidden = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  m: '-1px',
  p: 0,
  border: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const
