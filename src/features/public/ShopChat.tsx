import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  InputBase,
  Stack,
  TextField,
  Typography,
  useTheme,
} from '@mui/material'
import { ArrowUp, MessageCircle, UserRound } from 'lucide-react'
import type { components } from '../../api/generated'
import { useLocale } from '../../state/hooks'
import { shape } from '../../design/theme'
import { formatPrice } from '../v1/format'
import { useShopCopy } from '../shop/strings'
import { unitLabel } from '../shop/units'
import { CustomerConversation } from './CustomerConversation'
import { accessKey, readAccess, type ThreadAccess } from './threadAccess'
import { useCustomer } from '../customer/account'
import { useAccountCopy } from '../customer/copy'
import { chatPath, go } from '../customer/paths'
import { SignInButton } from '../customer/SignIn'
import type { ChatSummary } from '../customer/types'
import type { CustomerCopy } from './customerCopy'

type Answer = components['schemas']['Answer']
type Entry = { role: 'you'; text: string } | { role: 'ai'; answer: Answer; question: string }

async function post<T>(shop: string, action: string, body: unknown, signal: AbortSignal) {
  const response = await fetch(`/api/v1/public/shops/${encodeURIComponent(shop)}/${action}`, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
  })
  if (!response.ok) throw new Error(String(response.status))
  return response.json() as Promise<T>
}

function errorCopy(error: unknown, t: CustomerCopy) {
  const status = error instanceof Error ? error.message : ''
  return status === '429'
    ? t.rateLimited
    : status === '404'
      ? t.shopUnavailable
      : status === '409'
        ? t.factsChanged
        : t.requestFailed
}

/**
 * One conversation with a shop. The AI answers instantly from the owner-confirmed facts and
 * menu; when it can't help (or the customer prefers a person), the same question goes to the
 * owner with one tap and becomes a private thread the owner replies to.
 */
export function ShopChat({
  id,
  facts,
  item,
  currency,
  copy: t,
}: {
  id: string
  /** Serialised public facts; a change clears answers that may be out of date. */
  facts: string
  item?: string
  currency: string
  copy: CustomerCopy
}) {
  const locale = useLocale()
  const shopCopy = useShopCopy()
  const roles = useTheme().material
  const [access, setAccess] = useState<ThreadAccess | null>(() => readAccess(id))
  const [entries, setEntries] = useState<{ list: Entry[]; facts: string }>({ list: [], facts })
  const list = entries.facts === facts ? entries.list : []
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [invalid, setInvalid] = useState(false)
  // The "ask the owner" step: contact + the question to send (editable).
  const [handover, setHandover] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const contactInput = useRef<HTMLTextAreaElement>(null)
  const account = useCustomer()
  const accountCopy = useAccountCopy()
  const signedIn = account.status === 'signed-in' || account.status === 'guest'
  // A signed-in customer's existing chat with this shop (one per shop, like a messaging app).
  const [existing, setExisting] = useState<ChatSummary | null>(null)
  const { api } = account
  useEffect(() => {
    if (!signedIn) return
    const abort = new AbortController()
    api<ChatSummary | null>(`/api/v1/customer/shops/${encodeURIComponent(id)}/thread`, {
      signal: abort.signal,
    }).then(
      (value) => {
        if (!abort.signal.aborted) setExisting(value)
      },
      () => undefined,
    )
    return () => abort.abort()
  }, [signedIn, api, id])
  const request = useRef<AbortController | null>(null)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => () => request.current?.abort(), [])
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' })
  }, [list.length, handover])

  async function ask(text = question) {
    const value = text.trim()
    if (busy) return
    if (!value || value.length > 500) {
      setInvalid(true)
      input.current?.focus()
      return
    }
    setInvalid(false)
    setBusy(true)
    setError('')
    setHandover(null)
    const abort = new AbortController()
    request.current = abort
    try {
      const answer = await post<Answer>(
        id,
        'ask',
        { question: value, language: locale },
        abort.signal,
      )
      if (abort.signal.aborted) return
      setEntries({
        facts,
        list: [...list, { role: 'you', text: value }, { role: 'ai', answer, question: value }],
      })
      setQuestion('')
    } catch (failure) {
      if (!abort.signal.aborted) setError(errorCopy(failure, t))
    } finally {
      if (!abort.signal.aborted) setBusy(false)
    }
  }

  // Messaging an owner needs a signed-in customer (A5); the thread then lives in Chats.
  async function sendToOwner() {
    if (busy || handover === null || !signedIn) return
    if (!handover.trim() || Array.from(handover.trim()).length > 500) {
      setError(t.messageInvalid)
      contactInput.current?.focus()
      return
    }
    setBusy(true)
    setError('')
    try {
      const chat = await api<ChatSummary>(
        `/api/v1/customer/shops/${encodeURIComponent(id)}/threads`,
        { method: 'POST', body: JSON.stringify({ text: handover.trim(), language: locale }) },
      )
      setHandover(null)
      go(chatPath(id, chat.thread.id))
    } catch (failure) {
      setError(
        failure instanceof Error && failure.message === '409' ? t.closed : errorCopy(failure, t),
      )
    } finally {
      setBusy(false)
    }
  }

  // Threads started anonymously before sign-in was required stay readable on this device.
  if (access)
    return (
      <Box sx={{ mt: 2 }}>
        <CustomerConversation
          key={access.id}
          shop={id}
          access={access}
          copy={t}
          onDeleted={() => {
            try {
              localStorage.removeItem(accessKey(id))
            } catch {
              /* Browser storage may be unavailable. */
            }
            setAccess(null)
          }}
        />
      </Box>
    )

  const suggestions: [string, string][] = [
    ...(item
      ? [[t.priceSuggestion, t.priceQuestion.replace('{item}', item)] as [string, string]]
      : []),
    [t.hoursSuggestion, t.hoursQuestion],
    [t.locationSuggestion, t.locationQuestion],
  ]
  const bubble = { px: 2, py: 2, borderRadius: `${shape.lg}px`, maxWidth: '85%' }

  return (
    <Box sx={{ mt: 2 }}>
      <Stack component="ol" spacing={2} sx={{ listStyle: 'none', m: 0, p: 0 }}>
        {list.map((entry, index) =>
          entry.role === 'you' ? (
            <Box
              component="li"
              key={index}
              sx={{
                ...bubble,
                alignSelf: 'flex-end',
                bgcolor: roles.primaryContainer,
                color: roles.onPrimaryContainer,
              }}
            >
              <Typography variant="bodyLarge" sx={{ overflowWrap: 'anywhere' }}>
                {entry.text}
              </Typography>
            </Box>
          ) : (
            <Box
              component="li"
              key={index}
              sx={{ ...bubble, alignSelf: 'flex-start', bgcolor: roles.surfaceContainerHigh }}
            >
              {/* Announced as it arrives; the role sits inside the item to keep the list valid. */}
              <Box role="status">
                <Typography
                  variant="bodyLarge"
                  sx={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}
                >
                  {entry.answer.answer}
                </Typography>
                {entry.answer.price != null && (
                  <Typography variant="titleMedium" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                    {formatPrice(entry.answer.price, currency)} /{' '}
                    {unitLabel(entry.answer.unit ?? '', shopCopy)}
                  </Typography>
                )}
                <Typography variant="bodySmall" color="text.secondary" sx={{ mt: 0.5 }}>
                  {t.instantAnswer} · {t.answerNote}
                  {entry.answer.mode === 'fixture' ? ` · ${t.offlineAnswer}` : ''}
                </Typography>
              </Box>
              {index === list.length - 1 && handover === null && (
                <Button
                  size="small"
                  startIcon={<UserRound size={16} />}
                  onClick={() => {
                    setHandover(entry.question)
                    setTimeout(() => contactInput.current?.focus(), 0)
                  }}
                  sx={{ mt: 0.5, ml: -1 }}
                >
                  {t.askOwner}
                </Button>
              )}
            </Box>
          ),
        )}
      </Stack>

      {existing && handover === null && (
        <Button
          fullWidth
          variant="outlined"
          startIcon={<MessageCircle size={18} />}
          onClick={() => go(chatPath(id, existing.thread.id))}
          sx={{ mt: 2, minHeight: 48 }}
        >
          {t.openChat}
        </Button>
      )}
      {handover !== null ? (
        // One short step: sign in (once), then the question (editable) goes to the owner.
        <Stack
          component="form"
          noValidate
          spacing={2}
          sx={{ mt: 2, p: 2, borderRadius: `${shape.lg}px`, bgcolor: roles.surfaceContainerLow }}
          onSubmit={(event) => {
            event.preventDefault()
            void sendToOwner()
          }}
        >
          <Typography variant="titleSmall">{t.askOwner}</Typography>
          {!signedIn ? (
            <>
              <Typography variant="bodyMedium">{accountCopy.signInBody}</Typography>
              <SignInButton />
              <Button onClick={() => setHandover(null)}>{t.cancel}</Button>
            </>
          ) : (
            <>
              <Typography variant="bodySmall" color="text.secondary">
                {account.status === 'guest'
                  ? account.name
                  : accountCopy.signedInAs.replace('{name}', account.name)}
              </Typography>
              <TextField
                label={t.customerMessage}
                name="message"
                inputRef={contactInput}
                value={handover}
                onChange={(event) => setHandover(event.target.value)}
                multiline
                minRows={2}
                helperText={`${Array.from(handover).length}/500`}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault()
                    void sendToOwner()
                  }
                }}
              />
              <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
                <Button onClick={() => setHandover(null)}>{t.cancel}</Button>
                <Button
                  type="submit"
                  variant="contained"
                  disabled={busy}
                  startIcon={busy ? <CircularProgress size={18} color="inherit" /> : undefined}
                >
                  {t.sendMessage}
                </Button>
              </Stack>
            </>
          )}
        </Stack>
      ) : (
        <>
          {list.length === 0 && (
            <Stack direction="row" sx={{ gap: 1, flexWrap: 'wrap', mt: 1 }}>
              {suggestions.map(([label, value]) => (
                <Chip
                  key={label}
                  label={label}
                  variant="outlined"
                  disabled={busy}
                  sx={{ minHeight: 48, borderRadius: 999 }}
                  onClick={() => void ask(value)}
                />
              ))}
              <Chip
                label={t.askOwner}
                icon={<UserRound size={16} />}
                variant="outlined"
                disabled={busy}
                sx={{ minHeight: 48, borderRadius: 999 }}
                onClick={() => {
                  setHandover(question.trim())
                  setTimeout(() => contactInput.current?.focus(), 0)
                }}
              />
            </Stack>
          )}
          <Stack
            component="form"
            noValidate
            direction="row"
            sx={{
              mt: 2,
              alignItems: 'flex-end',
              gap: 1,
              pl: 2,
              pr: 0.5,
              borderRadius: `${shape.xl}px`,
              bgcolor: roles.surfaceContainerHigh,
              outline: invalid ? `2px solid ${roles.error}` : undefined,
            }}
            onSubmit={(event) => {
              event.preventDefault()
              void ask()
            }}
          >
            <InputBase
              inputRef={input}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder={t.questionHint}
              inputProps={{ 'aria-label': t.question, maxLength: 500, name: 'question' }}
              sx={{ flex: 1, minHeight: 48, fontSize: '1rem' }}
            />
            <IconButton
              type="submit"
              aria-label={t.sendQuestion}
              disabled={busy}
              sx={{ width: 48, height: 48 }}
            >
              {busy ? <CircularProgress size={20} /> : <ArrowUp size={20} />}
            </IconButton>
          </Stack>
          {invalid && (
            <Typography variant="bodySmall" color="error" sx={{ mt: 0.5, px: 2 }}>
              {t.questionInvalid}
            </Typography>
          )}
        </>
      )}
      {error && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {error}
        </Alert>
      )}
      <div ref={end} />
    </Box>
  )
}
