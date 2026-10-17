import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  IconButton,
  Stack,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material'
import { Check, LocateFixed, MapPin, Maximize2, X } from 'lucide-react'
import { enterRise, shape } from '../../design/theme'
import { useLocale } from '../../state/hooks'
import { useBackClose } from './backStack'
import { useInChatCopy } from './inChatCopy'
import { useMeasureLocation } from './location'
import { useNewShopCopy } from './newShopCopy'
import { PinMap, type Point } from './PinMap'
import { useCopy } from './strings'
import { useWorkspace } from './workspaceContext'

/** What the owner confirmed: the measured point, or a pin they placed by hand. */
export type PinChoice = Point & { accuracy_m: number; source: 'device' | 'pin' }

/** Where the map opens when there is no fix yet (the demo market). */
const FALLBACK: Point = { lat: 1.2847, lng: 103.832 }

function metres(a: Point, b: Point) {
  const rad = Math.PI / 180
  const x = (b.lng - a.lng) * rad * Math.cos(((a.lat + b.lat) / 2) * rad)
  const y = (b.lat - a.lat) * rad
  return Math.hypot(x, y) * 6_371_000
}

/** The readable address under the pin, looked up once the map is at rest. */
function useAddress(point: Point | null) {
  const { api } = useWorkspace()
  const [found, setFound] = useState<{ key: string; label: string } | null>(null)
  const key = point ? `${point.lat.toFixed(5)},${point.lng.toFixed(5)}` : ''
  useEffect(() => {
    if (!key) return
    const abort = new AbortController()
    const timer = window.setTimeout(() => {
      const [lat, lng] = key.split(',')
      void api<{ label: string; approximate: boolean }>(`/places/reverse?lat=${lat}&lng=${lng}`, {
        signal: abort.signal,
      })
        .then((result) => setFound({ key, label: result.label }))
        .catch(() => {
          if (!abort.signal.aborted) setFound({ key, label: '' })
        })
    }, 500)
    return () => {
      window.clearTimeout(timer)
      abort.abort()
    }
  }, [api, key])
  return found?.key === key ? found.label : null
}

/**
 * The location as a card in the conversation: a small map with the pin, the address and the
 * accuracy, "Use my current location", and a big full-screen map for careful placing. Nothing
 * is saved until "This is my shop", except with `direct`.
 */
export function MapCard({
  initial,
  done,
  autoLocate = false,
  direct = false,
  onConfirm,
  onActive,
}: {
  initial: Point | null
  /** The saved place, once confirmed (the card then rests). */
  done: string | null
  /** Measure at once (the owner tapped "My location", so the request follows their tap). */
  autoLocate?: boolean
  /**
   * The new-shop flow (owner decision, 17 Oct): the phone's location is saved as soon as it is
   * measured, with only the browser's own prompt. A pin placed by hand still needs the confirm.
   */
  direct?: boolean
  onConfirm: (choice: PinChoice, address: string | null) => Promise<void>
  /** The owner is placing the pin (the coach waits instead of nudging). */
  onActive?: () => void
}) {
  const t = useCopy()
  const c = useInChatCopy()
  const roles = useTheme().material
  const [fix, setFix] = useState<(Point & { m: number }) | null>(null)
  const [pin, setPin] = useState<Point | null>(initial)
  const [big, setBig] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const location = useMeasureLocation(async (point) => {
    setFix({ lat: point.lat, lng: point.lng, m: point.accuracy_m })
    setPin({ lat: point.lat, lng: point.lng })
    if (direct) await save({ ...point, source: 'device' }, null)
  })
  const asked = useRef(false)
  async function locate() {
    onActive?.()
    setError('')
    const failed = await location.locate()
    if (failed) {
      setError(failed)
      // The owner can still place the pin by hand.
      setPin((current) => current ?? FALLBACK)
    }
  }
  useEffect(() => {
    if (!autoLocate || asked.current) return
    asked.current = true
    // A deliberate one-off: the owner's tap on "My location" started this card.
    void locate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLocate])

  const address = useAddress(done ? null : pin)
  const moved = !fix || !pin || metres(fix, pin) > Math.max(5, fix.m / 2)
  async function save(choice: PinChoice, label: string | null) {
    setSaving(true)
    setError('')
    try {
      await onConfirm(choice, label)
      setBig(false)
    } catch {
      setError(t.actionFailed)
    } finally {
      setSaving(false)
    }
  }
  function confirm() {
    if (!pin || saving) return
    void save(
      moved
        ? { ...pin, accuracy_m: 0, source: 'pin' }
        : { lat: fix!.lat, lng: fix!.lng, accuracy_m: fix!.m, source: 'device' },
      address,
    )
  }

  if (done)
    return (
      <Stack
        direction="row"
        spacing={1}
        data-testid="map-card"
        data-state="done"
        sx={{ alignItems: 'center', color: roles.primary, ...enterRise }}
      >
        <Check size={18} aria-hidden="true" />
        <Typography variant="labelLarge">
          {c.pinSaved}: {done}
        </Typography>
      </Stack>
    )

  const details = (
    <PinDetails
      pin={pin}
      address={address}
      accuracy={!moved && fix ? fix.m : null}
      busy={location.busy}
      saving={saving}
      error={error}
      onLocate={() => void locate()}
      onConfirm={confirm}
    />
  )
  return (
    <Box
      data-testid="map-card"
      data-state="open"
      sx={{
        p: { xs: 1.5, sm: 2 },
        borderRadius: `${shape.lg}px`,
        bgcolor: roles.surfaceContainerLow,
        border: `1px solid ${roles.outlineVariant}`,
        ...enterRise,
      }}
    >
      <Stack direction="row" sx={{ alignItems: 'center', gap: 1, mb: 1.5 }}>
        <MapPin size={20} aria-hidden="true" color={roles.primary} />
        <Typography component="h3" variant="titleSmall" sx={{ flex: 1 }}>
          {c.mapTitle}
        </Typography>
        <Button
          size="small"
          startIcon={<Maximize2 size={16} />}
          onClick={() => {
            setPin((current) => current ?? FALLBACK)
            onActive?.()
            setBig(true)
          }}
          sx={{ minHeight: 48 }}
        >
          {c.biggerMap}
        </Button>
      </Stack>
      {pin ? (
        <PinMap
          value={pin}
          onChange={(point) => {
            onActive?.()
            setPin(point)
          }}
          accuracy={fix}
          sx={{ height: { xs: 112, sm: 160, md: 220 } }}
        />
      ) : (
        <Typography variant="bodyMedium" color="text.secondary">
          {t.locationReason}
        </Typography>
      )}
      {details}
      {big && pin && (
        <BigMap
          pin={pin}
          fix={fix}
          onPin={setPin}
          onClose={() => setBig(false)}
          details={details}
        />
      )}
    </Box>
  )
}

function PinDetails({
  pin,
  address,
  accuracy,
  busy,
  saving,
  error,
  onLocate,
  onConfirm,
}: {
  pin: Point | null
  address: string | null
  accuracy: number | null
  busy: boolean
  saving: boolean
  error: string
  onLocate: () => void
  onConfirm: () => void
}) {
  const t = useCopy()
  const c = useInChatCopy()
  const f = useNewShopCopy()
  const locale = useLocale()
  const readable =
    address === null
      ? c.findingAddress
      : !address || address === 'Your current location'
        ? accuracy !== null
          ? f.current
          : c.pinPlaced
        : address.startsWith('Near ')
          ? f.near(address.slice(5))
          : address
  return (
    <Stack spacing={1} sx={{ mt: 1 }}>
      {pin && (
        <Box aria-live="polite">
          <Typography variant="bodyLarge" sx={{ overflowWrap: 'anywhere' }}>
            {readable}
          </Typography>
          <Typography variant="bodySmall" color="text.secondary">
            {accuracy !== null
              ? t.locationAccuracy(
                  new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(
                    Math.ceil(accuracy),
                  ),
                )
              : c.mapHint}
          </Typography>
        </Box>
      )}
      {error && <Alert severity="info">{error}</Alert>}
      {/* The pin's confirmation comes first; a new measurement is the second choice. */}
      <Stack direction="row-reverse" sx={{ gap: 1, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <Button
          variant={pin ? 'outlined' : 'contained'}
          startIcon={busy ? <CircularProgress size={18} /> : <LocateFixed size={18} />}
          disabled={busy || saving}
          onClick={onLocate}
          sx={{ minHeight: 48 }}
        >
          {busy ? t.locating : t.useCurrentLocation}
        </Button>
        {pin && (
          <Button
            variant="contained"
            startIcon={
              saving ? <CircularProgress size={18} color="inherit" /> : <Check size={18} />
            }
            disabled={busy || saving}
            onClick={onConfirm}
            sx={{ minHeight: 48 }}
          >
            {c.confirmPin}
          </Button>
        )}
      </Stack>
    </Stack>
  )
}

/** The big view: the whole screen is the map, with the same address and buttons below it. */
function BigMap({
  pin,
  fix,
  onPin,
  onClose,
  details,
}: {
  pin: Point
  fix: (Point & { m: number }) | null
  onPin: (point: Point) => void
  onClose: () => void
  details: ReactNode
}) {
  const c = useInChatCopy()
  const roles = useTheme().material
  useBackClose(true, onClose)
  return (
    <Dialog open fullScreen onClose={onClose} aria-labelledby="big-map-title">
      <Box
        sx={{
          height: '100dvh',
          display: 'flex',
          flexDirection: 'column',
          bgcolor: roles.surface,
          pt: 'env(safe-area-inset-top)',
        }}
      >
        <Stack direction="row" sx={{ alignItems: 'center', gap: 1, px: 2, minHeight: 56 }}>
          <Tooltip title={c.closeMap}>
            <IconButton
              aria-label={c.closeMap}
              onClick={onClose}
              sx={{ minWidth: 48, minHeight: 48 }}
            >
              <X size={22} />
            </IconButton>
          </Tooltip>
          <Typography id="big-map-title" component="h2" variant="titleMedium">
            {c.mapTitle}
          </Typography>
        </Stack>
        <PinMap value={pin} onChange={onPin} accuracy={fix} big sx={{ flex: 1, borderRadius: 0 }} />
        <Box
          sx={{
            px: 3,
            pt: 1,
            pb: 'calc(16px + env(safe-area-inset-bottom))',
            maxWidth: 720,
            width: '100%',
            mx: 'auto',
          }}
        >
          {details}
        </Box>
      </Box>
    </Dialog>
  )
}
