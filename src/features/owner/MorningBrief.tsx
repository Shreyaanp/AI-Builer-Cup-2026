import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Box, Button, Chip, IconButton, Link, Stack, Typography, useTheme } from '@mui/material'
import { gsap } from 'gsap'
import { CloudSun, PackageMinus, Sparkles, Sunrise, UtensilsCrossed, X } from 'lucide-react'
import type { components } from '../../api/generated'
import { useChalkTimeline } from '../../design/chalkMotion'
import { scrollArea, shape } from '../../design/theme'
import { useLocale } from '../../state/hooks'
import { CloseDay } from '../closeday/CloseDay'
import { closeDayCopy } from '../closeday/strings'
import { useCopy as usePlanCopy } from '../planning/strings'
import type { ShopSheetKind } from '../v1/ShopTiles'
import { useWorkspace } from '../v1/workspaceContext'
import { fill, useOwnerCopy } from './copy'
import { shopNow } from './time'
import { shopZone } from '../../region/region'

type Brief = components['schemas']['Brief']
type Action = Brief['best_action']
const HIDDEN = 'chalkboard.brief.hidden.v1'

function hiddenToday(shop: string, date: string) {
  try {
    return (
      (JSON.parse(localStorage.getItem(HIDDEN) || '{}') as Record<string, string>)[shop] === date
    )
  } catch {
    return false
  }
}
function hideToday(shop: string, date: string) {
  try {
    const all = JSON.parse(localStorage.getItem(HIDDEN) || '{}') as Record<string, string>
    localStorage.setItem(HIDDEN, JSON.stringify({ ...all, [shop]: date }))
  } catch {
    /* It simply shows again next time. */
  }
}

/**
 * The morning brief: one calm card at the top of My shop with up to four swipeable slides
 * (prep, weather with its attribution, low stock, the one best action). Facts come from the
 * server; only the wording is ours. Hidden for the rest of the day with one tap.
 */
export function MorningBrief({
  onSheet,
  onRadar,
}: {
  onSheet: (kind: ShopSheetKind) => void
  onRadar: () => void
}) {
  const t = useOwnerCopy()
  const locale = useLocale()
  const theme = useTheme()
  const roles = theme.material
  const lilac = theme.chalk.lilac
  const ws = useWorkspace()
  const shop = ws.active!
  const today = shopNow(shopZone(shop.fields)).date
  const [brief, setBrief] = useState<Brief | null>(null)
  const [hidden, setHidden] = useState(() => hiddenToday(shop.id, today))
  const [index, setIndex] = useState(0)
  const [closing, setClosing] = useState(false)
  const track = useRef<HTMLDivElement>(null)
  const scope = useRef<HTMLElement>(null)
  useEffect(() => {
    if (hidden) return
    const abort = new AbortController()
    ws.api<Brief>(`/businesses/${encodeURIComponent(shop.id)}/brief`, { signal: abort.signal })
      .then(setBrief)
      .catch(() => undefined) // The brief is a nicety; My shop works without it.
    return () => abort.abort()
  }, [ws, shop.id, hidden])
  // A quiet entrance: the first slide's lines settle in, once.
  useChalkTimeline(
    scope,
    (root) => {
      gsap.from(root.querySelectorAll('.brief-line'), {
        y: 6,
        opacity: 0,
        duration: 0.35,
        stagger: 0.06,
        ease: 'power2.out',
      })
    },
    [Boolean(brief)],
  )
  if (hidden || !brief) return null

  // Treat optional server collections as empty; the rest of the shop remains usable.
  const prepPlan = Array.isArray(brief.prep_plan)
    ? brief.prep_plan.filter(
        (row) =>
          row &&
          typeof row.name === 'string' &&
          typeof row.quantity === 'number' &&
          typeof row.unit === 'string',
      )
    : []
  const lowStock = Array.isArray(brief.low_stock)
    ? brief.low_stock.filter(
        (row) => row && typeof row.name === 'string' && typeof row.stock === 'number',
      )
    : []
  const rawAction = brief.best_action
  const actionKinds = [
    'reply',
    'order',
    'radar',
    'reduce_prep',
    'confirm_menu',
    'record_sales',
    'none',
  ]
  const action =
    rawAction &&
    typeof rawAction === 'object' &&
    actionKinds.includes(rawAction.kind) &&
    typeof rawAction.title === 'string'
      ? { ...rawAction, item: typeof rawAction.item === 'string' ? rawAction.item : null }
      : { kind: 'none' as const, title: '', demo: false }
  const number = (n: number) => new Intl.NumberFormat(locale).format(n)
  const slides: { key: string; icon: ReactNode; title: string; body: ReactNode }[] = [
    {
      key: 'prep',
      icon: <UtensilsCrossed size={18} />,
      title: t.prep,
      body: prepPlan.length ? (
        <Stack spacing={1}>
          {prepPlan.map((row) => (
            <Stack
              key={row.name}
              className="brief-line"
              direction="row"
              sx={{ gap: 2, alignItems: 'baseline' }}
            >
              <Typography variant="bodyLarge" sx={{ flex: 1, minWidth: 0 }} noWrap>
                {row.name}
              </Typography>
              <Typography
                component="p"
                variant="titleMedium"
                sx={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {number(row.quantity)} {row.unit}
              </Typography>
              {typeof row.lower === 'number' && typeof row.upper === 'number' && (
                <Typography variant="bodySmall" color="text.secondary">
                  {fill(t.prepRange, { lower: number(row.lower), upper: number(row.upper) })}
                </Typography>
              )}
            </Stack>
          ))}
        </Stack>
      ) : (
        <Typography className="brief-line" variant="bodyLarge">
          {t.noPrep}
        </Typography>
      ),
    },
    ...(brief.weather
      ? [
          {
            key: 'weather',
            icon: <CloudSun size={18} />,
            title: t.weather,
            body: (
              <Stack spacing={1}>
                <Stack direction="row" sx={{ gap: 2, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <Typography
                    component="p"
                    variant="headlineSmall"
                    sx={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {new Intl.NumberFormat(locale, {
                      style: 'unit',
                      unit: 'celsius',
                      maximumFractionDigits: 0,
                    }).format(brief.weather.temperature_c)}
                  </Typography>
                  <Typography variant="bodyLarge">
                    {fill(t.rain, { pct: Math.round(brief.weather.rain_probability) })}
                  </Typography>
                  {brief.weather.demo && <Chip size="small" label={t.demo} />}
                </Stack>
                {/* Open-Meteo is CC BY 4.0: the attribution always shows with the data. */}
                <Typography variant="bodySmall" color="text.secondary">
                  <Link
                    href={brief.weather.url}
                    target="_blank"
                    rel="noopener"
                    color="inherit"
                    sx={{ display: 'inline-flex', alignItems: 'center', minHeight: 48 }}
                  >
                    {fill(brief.weather.demo ? t.weatherDemoCredit : t.weatherCredit, {
                      source: 'Open-Meteo (CC BY 4.0)',
                    })}
                  </Link>
                </Typography>
              </Stack>
            ),
          },
        ]
      : []),
    {
      key: 'stock',
      icon: <PackageMinus size={18} />,
      title: t.lowStock,
      body: lowStock.length ? (
        <Stack spacing={1}>
          {lowStock.slice(0, 3).map((row) => (
            <Stack key={row.name} direction="row" sx={{ gap: 2, alignItems: 'baseline' }}>
              <Typography variant="bodyLarge" sx={{ flex: 1, minWidth: 0 }} noWrap>
                {row.name}
              </Typography>
              <Typography variant="bodyMedium" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                {fill(t.stockLeft, { n: number(row.stock) })}
              </Typography>
              {typeof row.runs_out === 'string' && (
                <Typography variant="bodySmall" color="text.secondary">
                  {fill(t.runsOut, {
                    date: new Intl.DateTimeFormat(locale, {
                      weekday: 'short',
                      day: 'numeric',
                      timeZone: 'UTC',
                    }).format(new Date(`${row.runs_out}T00:00:00Z`)),
                  })}
                </Typography>
              )}
            </Stack>
          ))}
        </Stack>
      ) : (
        <Typography variant="bodyLarge">{t.noLowStock}</Typography>
      ),
    },
    {
      key: 'action',
      icon: <Sparkles size={18} />,
      title: t.best,
      body: (
        <BestAction
          action={action}
          onGo={() => {
            switch (action.kind) {
              case 'reply':
                return onSheet('messages')
              case 'order':
                return ws.startCoachDraft(fill(t.orderDraft, { item: action.item ?? '' }))
              case 'radar':
                return onRadar()
              case 'reduce_prep':
                return onSheet('plan')
              case 'confirm_menu':
                return onSheet('menu')
              case 'record_sales':
                return setClosing(true)
            }
          }}
        />
      ),
    },
  ]

  function goTo(i: number) {
    const node = track.current
    if (!node) return
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    node.scrollTo({ left: i * node.clientWidth, behavior: reduce ? 'instant' : 'smooth' })
  }

  return (
    <Box
      ref={scope}
      component="section"
      aria-label={t.brief}
      aria-roledescription="carousel"
      sx={{
        borderRadius: `${shape.lgIncreased}px`,
        bgcolor: roles.surfaceContainer,
        border: `1px solid ${roles.outlineVariant}`,
        overflow: 'hidden',
      }}
    >
      <Stack direction="row" sx={{ alignItems: 'center', gap: 2, pl: 4, pr: 1, pt: 2 }}>
        <Box aria-hidden="true" sx={{ display: 'flex', color: lilac.main }}>
          <Sunrise size={20} />
        </Box>
        <Typography id="brief-title" component="h2" variant="labelLarge" sx={{ flex: 1 }}>
          {t.brief}
        </Typography>
        {brief.demo && <Chip size="small" label={t.demo} />}
        <IconButton
          aria-label={t.hide}
          onClick={() => {
            hideToday(shop.id, today)
            setHidden(true)
          }}
        >
          <X size={18} />
        </IconButton>
      </Stack>
      <Box
        ref={track}
        onScroll={(event) => {
          const node = event.currentTarget
          setIndex(Math.round(node.scrollLeft / Math.max(1, node.clientWidth)))
        }}
        sx={{
          display: 'flex',
          overflowX: 'auto',
          scrollSnapType: 'x mandatory',
          ...scrollArea,
        }}
      >
        {slides.map((slide, i) => (
          <Box
            key={slide.key}
            role="group"
            aria-roledescription="slide"
            aria-label={fill(t.slide, { n: i + 1, total: slides.length })}
            sx={{ flex: '0 0 100%', scrollSnapAlign: 'start', px: 4, pt: 1, pb: 2, minWidth: 0 }}
          >
            <Stack direction="row" sx={{ alignItems: 'center', gap: 1, mb: 1.5 }}>
              <Box aria-hidden="true" sx={{ display: 'flex', color: roles.onSurfaceVariant }}>
                {slide.icon}
              </Box>
              <Typography component="h3" variant="titleSmall" color="text.secondary">
                {slide.title}
              </Typography>
            </Stack>
            {slide.body}
          </Box>
        ))}
      </Box>
      <Stack direction="row" sx={{ justifyContent: 'center', pb: 1 }}>
        {slides.map((slide, i) => (
          <Box
            key={slide.key}
            component="button"
            type="button"
            aria-label={fill(t.slide, { n: i + 1, total: slides.length })}
            aria-current={i === index ? 'true' : undefined}
            onClick={() => goTo(i)}
            sx={{
              width: 48,
              height: 48,
              p: 0,
              border: 0,
              bgcolor: 'transparent',
              cursor: 'pointer',
              display: 'grid',
              placeItems: 'center',
              '&:focus-visible': { outline: `2px solid ${roles.primary}`, borderRadius: '50%' },
            }}
          >
            <Box
              aria-hidden="true"
              sx={{
                width: i === index ? 18 : 8,
                height: 8,
                borderRadius: 4,
                bgcolor: i === index ? lilac.main : roles.outlineVariant,
                transition: 'width 200ms',
              }}
            />
          </Box>
        ))}
      </Stack>
      {closing && <CloseDay onClose={() => setClosing(false)} />}
    </Box>
  )
}

function BestAction({ action, onGo }: { action: Action; onGo: () => void }) {
  const t = useOwnerCopy()
  const plan = usePlanCopy()
  const closeDay = closeDayCopy(useLocale())
  // The server's own words carry the count ("Reply to 3 customers", "Prep 4 fewer …").
  const n = Number(/\d+/.exec(action.title)?.[0] ?? 0)
  const item = action.item ?? ''
  const text = {
    reply: fill(t.act_reply, { n }),
    order: fill(t.act_order, { item }),
    radar: fill(t.act_radar, { item }),
    reduce_prep: fill(t.act_reduce_prep, { n, item }),
    confirm_menu: t.act_confirm_menu,
    record_sales: t.act_record_sales,
    none: t.act_none,
  }[action.kind]
  const button =
    action.kind === 'none'
      ? null
      : {
          reply: t.go_reply,
          order: t.go_order,
          radar: t.go_radar,
          reduce_prep: plan.title,
          confirm_menu: t.go_confirm_menu,
          record_sales: closeDay.title,
        }[action.kind]
  return (
    <Stack spacing={2} sx={{ alignItems: 'flex-start' }}>
      <Stack direction="row" sx={{ gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
        <Typography component="p" variant="titleMedium">
          {text}
        </Typography>
        {action.demo && <Chip size="small" label={t.demo} />}
      </Stack>
      {button && (
        <Button variant="contained" size="small" onClick={onGo}>
          {button}
        </Button>
      )}
    </Stack>
  )
}
