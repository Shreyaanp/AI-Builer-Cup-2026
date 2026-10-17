import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Stack,
  TextField,
  Typography,
  useTheme,
} from '@mui/material'
import { List, Map as MapIcon, MapPin, Search } from 'lucide-react'
import { useLocale } from '../../state/hooks'
import { loadScriptFont } from '../../i18n/fonts'
import { motion } from '../../design/theme'
import { useFrontCopy } from '../frontdoors/strings'
import { BadgeRow } from '../rewards/Rewards'
import { useRewards } from '../rewards/storage'
import { customerNavigate } from '../frontdoors/navigation'
import type { CustomerLocation } from '../frontdoors/CustomerApp'
import { Sheet } from '../v1/Sheet'
import { PickCard, PickList, PickSkeleton } from './AnswerCards'
import { useConversationCopy } from './conversationCopy'
import { useRewardCopy } from '../rewards/strings'
import type { AskPick } from './askThread'
import { discoverCopy } from './strings'
import { areaCurrency, ensureDemoWorld } from './demoWorld'
import { PlaceSearch } from './PlaceSearch'
import type { FoundPlace } from './PlaceSearch'
import { mapsLink } from './types'
import type { Discovery, Place, Usual } from './types'
import { categories, categoryValue, matchesInterest } from './categories'
import { isBudget } from './budget'
import { carried, entryState, pushEntry, replaceEntry, restoreScroll } from '../../app/history'
import { overlayHandled } from '../v1/backStack'

const DiscoverMap = lazy(() => import('./DiscoverMap'))
const areas = {
  'Tiong Bahru': [1.2847, 103.832],
  Chinatown: [1.283, 103.843],
  Bugis: [1.3007, 103.855],
  Orchard: [1.3048, 103.8318],
  'Jurong East': [1.3331, 103.7423],
  Tampines: [1.3547, 103.9437],
} as const
type Area = keyof typeof areas
type Filters = {
  q: string
  category: string
  open: boolean
  halal: boolean
  budget: boolean
  area: Area
  /** A typed city or neighbourhood anywhere in the world; wins over the demo areas. */
  place: FoundPlace | null
}
function validPlace(value: unknown): FoundPlace | null {
  const place = value as FoundPlace | null
  return place &&
    typeof place.label === 'string' &&
    Number.isFinite(place.lat) &&
    Number.isFinite(place.lng)
    ? { lat: place.lat, lng: place.lng, label: place.label.slice(0, 180) }
    : null
}
const preferenceKey = 'chalkboard.discover.filters'
const usualsKey = 'chalkboard.discover.usuals'
function readFilters(): Filters {
  let saved: Partial<Filters> = {}
  try {
    saved = JSON.parse(localStorage.getItem(preferenceKey) || '{}') as Partial<Filters>
  } catch {
    /* Optional storage. */
  }
  const url = new URLSearchParams(location.search)
  const area = url.get('area') ?? saved?.area
  const category = url.get('category') ?? saved?.category
  return {
    q: (url.get('q') ?? (typeof saved?.q === 'string' ? saved.q : '')).slice(0, 180),
    category: categoryValue(category),
    open: url.has('open') ? url.get('open') === '1' : saved?.open === true,
    halal: url.has('halal') ? url.get('halal') === '1' : saved?.halal === true,
    budget: url.has('budget') ? url.get('budget') === '1' : saved?.budget === true,
    area: typeof area === 'string' && Object.hasOwn(areas, area) ? (area as Area) : 'Tiong Bahru',
    place: validPlace(saved?.place),
  }
}
function readUsuals(): Usual[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(usualsKey) || '[]')
    if (Array.isArray(value))
      return value
        .filter(
          (row): row is Usual =>
            row &&
            typeof row.id === 'string' &&
            typeof row.name === 'string' &&
            ['chalkboard', 'google'].includes(row.source),
        )
        .slice(0, 6)
  } catch {
    /* Optional storage. */
  }
  return []
}

export default function Discover({
  initialLocation,
  interests = [],
  onLocationChange,
}: {
  initialLocation?: CustomerLocation | null
  interests?: string[]
  onLocationChange?: (location: CustomerLocation) => void
}) {
  // Public customers follow their phone language independently of owner preferences.
  const locale = useLocale()
  const t = discoverCopy(locale)
  const front = useFrontCopy()
  const rewards = useRewards()
  const theme = useTheme()
  const roles = theme.material
  // GPS and a typed city are one remembered place, so a reload stays where the customer is.
  const [filters, setFilters] = useState(() => {
    const first = initialLocation?.gps
      ? { lat: initialLocation.gps[0], lng: initialLocation.gps[1], label: t.current }
      : initialLocation?.place
    return { ...readFilters(), ...(first ? { place: first } : {}) }
  })
  const [query, setQuery] = useState(filters.q)
  const [gpsBusy, setGpsBusy] = useState(false)
  const [gpsError, setGpsError] = useState(false)
  const [changingArea, setChangingArea] = useState(false)
  const [result, setResult] = useState<Discovery | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [retry, setRetry] = useState(0)
  const [map, setMapOpen] = useState(
    () => new URLSearchParams(location.search).get('view') === 'map',
  )
  function setMap(open: boolean) {
    const url = new URL(location.href)
    if (open) url.searchParams.set('view', 'map')
    else url.searchParams.delete('view')
    pushEntry(url, carried())
    setMapOpen(open)
  }
  const [selected, setSelected] = useState<Usual | null>(null)
  const [usuals, setUsuals] = useState(readUsuals)
  const [interestsActive, setInterestsActive] = useState(interests.length > 0)
  const [lat, lng] = filters.place ? [filters.place.lat, filters.place.lng] : areas[filters.area]
  const currency = areaCurrency(lat, lng, filters.place?.label ?? filters.area)
  const conversation = useConversationCopy(currency)
  const rewardCopy = useRewardCopy()
  useEffect(() => {
    if (filters.place) onLocationChange?.({ gps: null, place: filters.place })
  }, [filters.place, onLocationChange])
  useEffect(() => {
    document.title = t.title + ' · Chalkboard'
    document.documentElement.lang = locale
    void loadScriptFont(locale)
  }, [locale, t.title])
  useEffect(() => {
    try {
      localStorage.setItem(preferenceKey, JSON.stringify(filters))
    } catch {
      /* Optional storage. */
    }
    const url = new URL(location.href)
    for (const [key, value] of Object.entries({
      q: filters.q,
      category: filters.category,
      area: filters.area,
      open: filters.open ? '1' : '0',
      halal: filters.halal ? '1' : '0',
      budget: filters.budget ? '1' : '0',
    }))
      url.searchParams.set(key, value)
    replaceEntry(url)
  }, [filters])
  useEffect(() => {
    const restore = (event: PopStateEvent) => {
      if (overlayHandled(event)) return
      const restored = readFilters()
      setFilters(restored)
      setQuery(restored.q)
      setMapOpen(new URLSearchParams(location.search).get('view') === 'map')
    }
    window.addEventListener('popstate', restore)
    return () => window.removeEventListener('popstate', restore)
  }, [])
  useEffect(() => {
    if (status !== 'ready') return
    const y = entryState().scrollY
    if (y) restoreScroll(y, 8)
  }, [status])
  useEffect(() => {
    // Shared menu availability stays current while the customer is viewing the feed.
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') setRetry((value) => value + 1)
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    const abort = new AbortController()
    const params = new URLSearchParams({
      lat: String(lat),
      lng: String(lng),
      radius: '3000',
      q: filters.q,
      category: filters.category,
      open_now: String(filters.open),
    })
    // Abort old responses on filter/location changes, including a slow GPS handoff.
    async function load() {
      setStatus('loading')
      try {
        await ensureDemoWorld(lat, lng)
        const response = await fetch('/api/v1/discover?' + params, { signal: abort.signal })
        if (!response.ok) throw new Error('Discovery unavailable')
        const data = (await response.json()) as Discovery
        if (!abort.signal.aborted) {
          const seen = new Set<string>()
          const uniquePlaces = data.places.filter((p) => {
            const norm = p.name
              .replace(/\s*\((Tour|Demo)\)$/i, '')
              .trim()
              .toLowerCase()
            if (seen.has(norm)) return false
            seen.add(norm)
            return true
          })
          setResult({ ...data, places: uniquePlaces })
          setStatus('ready')
        }
      } catch {
        if (!abort.signal.aborted) setStatus('error')
      }
    }
    void load()
    return () => abort.abort()
  }, [lat, lng, filters.q, filters.category, filters.open, retry])

  function remember(place: Usual) {
    const minimal: Usual = {
      id: place.id,
      name: place.name,
      source: place.source,
      demo: place.demo,
      google_maps_uri: mapsLink(place.google_maps_uri) ?? null,
    }
    const next = [minimal, ...usuals.filter((row) => row.id !== place.id)].slice(0, 6)
    setUsuals(next)
    try {
      localStorage.setItem(usualsKey, JSON.stringify(next))
    } catch {
      /* Optional storage. */
    }
  }
  useEffect(() => {
    // Already allowed: find the customer straight away (no prompt), and refresh a GPS place.
    if (filters.place && filters.place.label !== t.current) return
    void navigator.permissions
      ?.query({ name: 'geolocation' })
      .then((state) => {
        if (state.state === 'granted') locate(true)
      })
      .catch(() => undefined)
    // Once on arrival only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  function openPlace(place: Usual) {
    remember(place)
    if (place.source === 'google') setSelected(place)
  }
  function locate(quiet = false) {
    setGpsBusy(true)
    setGpsError(false)
    if (!navigator.geolocation) {
      setGpsBusy(false)
      setGpsError(!quiet)
      return
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude: lat, longitude: lng } = position.coords
        setFilters((current) => ({ ...current, place: { lat, lng, label: t.current } }))
        setGpsBusy(false)
      },
      () => {
        setGpsError(!quiet)
        setGpsBusy(false)
      },
      // Precise: shops "around me" should mean this street, not this district.
      { timeout: 15_000, maximumAge: 30_000, enableHighAccuracy: true },
    )
  }
  const places = useMemo(
    () =>
      (result?.places ?? []).filter(
        (place) =>
          (!filters.halal || place.halal === true) &&
          (!interestsActive ||
            interests.some((interest) => matchesInterest(place.category, interest))) &&
          (!filters.budget || isBudget(place)),
      ),
    [result, filters.halal, filters.budget, interests, interestsActive],
  )
  const details = result?.places.find((place) => place.id === selected?.id)
  const link = mapsLink(selected?.google_maps_uri)
  function distanceText(place: Place) {
    return new Intl.NumberFormat(locale, {
      style: 'unit',
      unit: place.distance_m < 1000 ? 'meter' : 'kilometer',
      maximumFractionDigits: 1,
    }).format(place.distance_m < 1000 ? place.distance_m : place.distance_m / 1000)
  }
  function statusText(place: Place) {
    return place.open_now === null ? t.unknown : place.open_now ? t.open : t.closed
  }
  function categoryText(value: string) {
    const key = categories.find((category) => matchesInterest(value, category))
    return key ? t[key] : value.replaceAll('_', ' ')
  }
  /** A discovery place as the Ask home's shop row takes it. */
  function asPick(place: Place): AskPick {
    return { ...place, currency: place.currency ?? currency, matched: [], score: 0, reasons: [] }
  }
  function detailsText(place: Place) {
    const stamps = rewards.data.shops[place.id]?.stamps ?? 0
    return [
      categoryText(place.category),
      place.source === 'google' ? t.google : null,
      stamps > 0
        ? rewardCopy.stamps.replace('{count}', new Intl.NumberFormat(locale).format(stamps))
        : null,
      place.source === 'google' && place.rating != null
        ? `★ ${new Intl.NumberFormat(locale).format(place.rating)}`
        : null,
    ]
      .filter(Boolean)
      .join(' · ')
  }
  const controlSx = {
    minHeight: 48,
    maxWidth: '100%',
    height: 'auto',
    '& .MuiChip-label': { py: 2, whiteSpace: 'normal' },
  }

  // First load: the page's own shape with placeholder rows, never a full-screen spinner.
  if (status === 'loading' && !result)
    return (
      <Box
        component="main"
        role="status"
        aria-label={front.loading}
        aria-busy="true"
        sx={{ maxWidth: 720, mx: 'auto', px: 4, pt: 1 }}
      >
        <Typography variant="headlineMedium" component="h1" sx={{ mb: 3 }}>
          {t.title}
        </Typography>
        <Box component="ul" sx={{ m: 0, p: 0, display: 'grid', gap: 2 }}>
          {[0, 1, 2, 3, 4].map((n) => (
            <PickSkeleton key={n} />
          ))}
        </Box>
      </Box>
    )
  return (
    <Box
      component="main"
      sx={{
        maxWidth: 720,
        mx: 'auto',
        px: 4,
        pt: 1,
        pb: 'max(24px, env(safe-area-inset-bottom))',
        color: roles.onSurface,
        '--customer-spring': motion.easing.spring,
      }}
    >
      <Stack spacing={3}>
        <Typography variant="headlineMedium" component="h1">
          {t.title}
        </Typography>
        <Stack
          component="form"
          direction="row"
          spacing={2}
          onSubmit={(event) => {
            event.preventDefault()
            setFilters({ ...filters, q: query.trim() })
          }}
        >
          <TextField
            fullWidth
            label={t.search}
            placeholder={t.hint}
            name="q"
            type="search"
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            slotProps={{ htmlInput: { maxLength: 180 } }}
          />
          <Button
            type="submit"
            variant="contained"
            aria-label={t.submit}
            sx={{ minWidth: 56, px: 3, flexShrink: 0 }}
          >
            <Search aria-hidden size={22} />
          </Button>
        </Stack>
        <Stack
          direction="row"
          sx={{
            gap: 2,
            overflowX: 'auto',
            py: 2,
            // Runs to the screen edges, so a cut-off chip reads as "swipe for more". Doubled
            // specificity: the Stack's own child rule resets margins.
            '&&': { mx: -4 },
            px: 4,
            position: 'sticky',
            // Pinned just under the app bar (CustomerTopBar, 64px).
            top: 'calc(64px + env(safe-area-inset-top, 0px))',
            zIndex: 2,
            bgcolor: roles.surface,
            scrollbarWidth: 'none',
            '&::-webkit-scrollbar': { display: 'none' },
          }}
        >
          {[
            { label: t.open, on: filters.open, set: (open: boolean) => ({ open }) },
            { label: t.halal, on: filters.halal, set: (halal: boolean) => ({ halal }) },
            { label: t.budget, on: filters.budget, set: (budget: boolean) => ({ budget }) },
          ].map((toggle) => (
            <Chip
              key={toggle.label}
              role="switch"
              aria-checked={toggle.on}
              label={toggle.label}
              clickable
              variant={toggle.on ? 'filled' : 'outlined'}
              color={toggle.on ? 'primary' : 'default'}
              sx={{ ...controlSx, flexShrink: 0 }}
              onClick={() => setFilters({ ...filters, ...toggle.set(!toggle.on) })}
            />
          ))}
          <Chip
            label={front.all}
            clickable
            aria-pressed={!filters.category && !interestsActive}
            color={!filters.category && !interestsActive ? 'primary' : 'default'}
            sx={{ ...controlSx, flexShrink: 0 }}
            onClick={() => {
              setInterestsActive(false)
              setFilters({ ...filters, category: '' })
            }}
          />
          {categories.map((category) => (
            <Chip
              key={category}
              label={t[category]}
              clickable
              aria-pressed={filters.category === category}
              color={filters.category === category ? 'primary' : 'default'}
              sx={{ ...controlSx, flexShrink: 0 }}
              onClick={() => {
                setInterestsActive(false)
                setFilters({ ...filters, category: filters.category === category ? '' : category })
              }}
            />
          ))}
        </Stack>
        {filters.place && !changingArea ? (
          <Stack direction="row" sx={{ alignItems: 'center', gap: 2, flexWrap: 'wrap', py: 1 }}>
            <Typography
              variant="bodyMedium"
              color="text.secondary"
              sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}
            >
              <MapPin size={16} aria-hidden="true" />
              <span>{filters.place.label}</span>
            </Typography>
            <Button
              size="small"
              onClick={() => setChangingArea(true)}
              sx={{ minHeight: 48, textDecoration: 'underline', px: 2 }}
            >
              {t.changeArea}
            </Button>
          </Stack>
        ) : (
          <>
            <Typography variant="bodyMedium" color="text.secondary">
              {t.reason}
            </Typography>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3}>
              <PlaceSearch
                key={filters.place ? `${filters.place.lat},${filters.place.lng}` : filters.area}
                value={filters.place?.label ?? filters.area}
                onFound={(place) => {
                  setGpsError(false)
                  setFilters({ ...filters, place })
                  setChangingArea(false)
                }}
              />
              <Button
                variant="outlined"
                disabled={gpsBusy}
                onClick={() => locate()}
                startIcon={
                  gpsBusy ? <CircularProgress size={18} /> : <MapPin aria-hidden size={18} />
                }
                sx={{ flexShrink: 0, minHeight: 48 }}
              >
                {t.gps}
              </Button>
            </Stack>
          </>
        )}
        {gpsError && <Alert severity="info">{t.gpsError}</Alert>}
        {result?.mode === 'demo' && (
          <Alert severity="info">
            <strong>{t.demo}</strong>
            <br />
            {t.demoNote}
          </Alert>
        )}
        {result?.google_unavailable && <Alert severity="warning">{t.partial}</Alert>}
        {(usuals.length > 0 || Object.keys(rewards.data.shops).length > 0) && (
          <Box>
            <Typography variant="titleLarge" component="h2">
              {t.usuals}
            </Typography>
            <BadgeRow />
            <Typography variant="bodySmall" color="text.secondary" sx={{ mb: 3 }}>
              {t.usualsNote}
            </Typography>
            <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 2 }}>
              {usuals.map((place) =>
                place.source === 'chalkboard' ? (
                  <Button
                    key={place.id}
                    component="a"
                    href={`/explore/s/${encodeURIComponent(place.id)}`}
                    variant="outlined"
                    onClick={(event: React.MouseEvent<HTMLAnchorElement>) => {
                      remember(place)
                      customerNavigate(event)
                    }}
                  >
                    {place.name}
                  </Button>
                ) : (
                  <Button key={place.id} variant="outlined" onClick={() => openPlace(place)}>
                    {place.name}
                  </Button>
                ),
              )}
            </Stack>
          </Box>
        )}
        {/* List or map: one pill in the thumb zone, floating over the results (not a title). */}
        <Box
          sx={{
            position: 'sticky',
            bottom: 'calc(16px + env(safe-area-inset-bottom, 0px))',
            zIndex: 3,
            order: 99,
            display: 'flex',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <Button
            variant="contained"
            aria-pressed={map}
            onClick={() => setMap(!map)}
            startIcon={map ? <List aria-hidden size={18} /> : <MapIcon aria-hidden size={18} />}
            sx={{
              pointerEvents: 'auto',
              minHeight: 48,
              px: 5,
              borderRadius: 999,
              bgcolor: roles.inverseSurface,
              color: roles.inverseOnSurface,
              boxShadow: '0 6px 20px rgb(0 0 0 / 0.24)',
              '&:hover': { bgcolor: roles.inverseSurface },
            }}
          >
            {map ? t.list : t.map}
          </Button>
        </Box>
        <Box role="status" aria-live="polite">
          {status === 'loading' && (
            <Stack direction="row" spacing={3}>
              <CircularProgress size={24} />
              <Typography>{t.loading}</Typography>
            </Stack>
          )}
          {status === 'error' && (
            <Alert
              severity="error"
              action={<Button onClick={() => setRetry(retry + 1)}>{t.retry}</Button>}
            >
              {t.error}
            </Alert>
          )}
          {status === 'ready' && places.length === 0 && <Typography>{t.empty}</Typography>}
        </Box>
        <Sheet
          open={map}
          onClose={() => setMap(false)}
          titleId="customer-map-title"
          title={t.map}
          dismissInActions
          actions={<Button onClick={() => setMap(false)}>{t.list}</Button>}
        >
          <Suspense fallback={<Typography role="status">{t.loading}</Typography>}>
            <DiscoverMap
              places={places}
              center={{ lat, lng }}
              demo={result?.mode === 'demo'}
              onOpen={(place) => {
                if (place.source === 'google') {
                  setMap(false)
                  openPlace(place)
                }
              }}
              unavailable={t.mapError}
              loading={t.loading}
              demoLabel={t.demoNote}
            />
          </Suspense>
          <Stack spacing={2} sx={{ mt: 3 }}>
            {places.map((place) =>
              place.source === 'chalkboard' ? (
                <Button
                  key={place.id}
                  component="a"
                  href={`/explore/s/${encodeURIComponent(place.id)}`}
                  onClick={customerNavigate}
                >
                  {place.name}
                </Button>
              ) : (
                <Button
                  key={place.id}
                  onClick={() => {
                    setMap(false)
                    openPlace(place)
                  }}
                >
                  {place.name}
                </Button>
              ),
            )}
          </Stack>
        </Sheet>
        {status === 'ready' && places.length > 0 && (
          <PickList label={t.title}>
            {places.map((place, index) => (
              <PickCard
                key={place.id}
                pick={asPick(place)}
                index={index}
                anchor={null}
                copy={conversation}
                locale={locale}
                numbered={false}
                details={detailsText(place)}
                onOpen={() => {
                  if (place.source === 'chalkboard') remember(place)
                  else openPlace(place)
                }}
              />
            ))}
          </PickList>
        )}
      </Stack>
      <Sheet
        open={selected !== null}
        onClose={() => setSelected(null)}
        titleId="discover-place-title"
        title={selected?.name}
      >
        <Stack spacing={4}>
          <Typography variant="labelLarge">{t.google}</Typography>
          {details && (
            <Typography variant="bodyMedium">{categoryText(details.category)}</Typography>
          )}
          {(result?.mode === 'demo' || selected?.demo) && (
            <Alert severity="info">
              {t.demo} · {t.demoNote}
            </Alert>
          )}
          {details && (
            <Typography>
              {statusText(details)} · {distanceText(details)}
              {details.rating != null
                ? ` · ★ ${new Intl.NumberFormat(locale).format(details.rating)}`
                : ''}
            </Typography>
          )}
          {link && (
            <Button
              component="a"
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              variant="contained"
            >
              {t.maps} · {t.liveLink}
            </Button>
          )}
        </Stack>
      </Sheet>
    </Box>
  )
}
