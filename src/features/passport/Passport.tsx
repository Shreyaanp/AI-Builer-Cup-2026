import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  LinearProgress,
  Stack,
  Switch,
  Typography,
  useTheme,
} from '@mui/material'
import { gsap } from 'gsap'
import { Check, Gift, Leaf, Trophy } from 'lucide-react'
import { useChalkTimeline, dealIn } from '../../design/chalkMotion'
import { HAND_FONT } from '../../design/theme'
import { useLocale } from '../../state/hooks'
import type { CustomerLocation } from '../frontdoors/CustomerApp'
import { useCustomer } from '../customer/account'
import { useAccountCopy } from '../customer/copy'
import { SignInSheet } from '../customer/SignIn'
import { customerNavigate } from '../frontdoors/navigation'
import { useRewardCopy } from '../rewards/strings'
import { formatPrice } from '../v1/format'
import { LevelRing, Sticker } from './art'
import { FESTIVAL_ART } from './artData'
import { fill, requirementText, usePassportCopy } from './copy'
import type { PassportStrings } from './copy'
import { setPassport, usePassport, where } from './store'
import type { Board, PassportView, Quest } from './store'
import { CollectionSets } from './games/CollectionSets'
import { CoopGoal } from './games/CoopGoal'
import { NextRewardLine } from './games/GamesCard'
import { useGamesCopy } from './games/copy'
import { HowItWorks } from './games/HowItWorks'
import { ScratchCard } from './games/ScratchCard'
import type { ScratchView } from './games/api'
import { StreakFlame } from './games/StreakFlame'
import { WonPerks } from './games/WonPerks'

const SLOTS = 12

function lastPlace(): { lat: number; lng: number } | null {
  try {
    const place = (
      JSON.parse(localStorage.getItem('chalkboard.discover.filters') || '{}') as {
        place?: { lat: number; lng: number }
      }
    ).place
    return place && Number.isFinite(place.lat) ? place : null
  } catch {
    return null
  }
}

/**
 * The neighbourhood passport: level, the next named reward, scratch cards, the weekly streak,
 * the neighbourhood goal, stamp book, collection sets, quests, rescues, perks and the board.
 */
export function Passport({ initialLocation }: { initialLocation?: CustomerLocation | null }) {
  const account = useCustomer()
  const t = usePassportCopy()
  const roles = useTheme().material
  const [place] = useState(() =>
    initialLocation?.gps
      ? { lat: initialLocation.gps[0], lng: initialLocation.gps[1] }
      : (initialLocation?.place ?? lastPlace()),
  )
  const { view, status, refresh, signedIn } = usePassport(place)
  const [signIn, setSignIn] = useState(false)
  useEffect(() => {
    document.title = `${t.title} · Chalkboard`
  }, [t.title])
  return (
    <Box
      component="main"
      sx={{
        maxWidth: 720,
        mx: 'auto',
        px: 4,
        pt: 1,
        pb: 'calc(120px + env(safe-area-inset-bottom))',
        minHeight: '100dvh',
      }}
    >
      <Stack
        direction="row"
        sx={{
          alignItems: 'baseline',
          gap: 2,
          flexWrap: 'wrap',
          minHeight: 56,
        }}
      >
        <Typography
          component="h1"
          sx={{
            fontFamily: HAND_FONT,
            fontWeight: 700,
            fontSize: 38,
            lineHeight: 1.1,
            overflowWrap: 'break-word',
          }}
        >
          {t.title}
        </Typography>
        {view?.device_only && (
          <Chip
            size="small"
            label={t.onThisPhone}
            sx={{
              maxWidth: '100%',
              height: 'auto',
              minHeight: 24,
              '& .MuiChip-label': { whiteSpace: 'normal', py: 0.5 },
            }}
          />
        )}
      </Stack>
      {status === 'error' && (
        <Alert
          severity="error"
          sx={{ mt: 4 }}
          action={<Button onClick={refresh}>{t.retry}</Button>}
        >
          {t.failed}
        </Alert>
      )}
      {!view && status !== 'error' && (
        <Box sx={{ mt: 6 }} aria-busy="true">
          <LinearProgress aria-label={t.title} />
        </Box>
      )}
      {view && (
        <Stack spacing={5} sx={{ mt: 3 }}>
          <LevelCard view={view} />
          <NextRewardLine view={view} />
          <PendingScratch view={view} place={place} onSignIn={() => setSignIn(true)} />
          <StreakFlame view={view} place={place} />
          {view.games?.coop && (
            <CoopGoal coop={view.games.coop} signedIn={signedIn} place={place} />
          )}
          <StampBook view={view} />
          {view.games && <CollectionSets sets={view.games.sets} />}
          {/* Festival trails live with the collection sets. */}
          <Quests quests={view.quests.filter((quest) => quest.kind !== 'festival')} />
          <Impact view={view} />
          <Perks view={view} />
          <Leaderboard view={view} place={place} onSignIn={() => setSignIn(true)} />
          {!signedIn && account.status !== 'guest' && (
            <Box
              sx={{
                p: 4,
                borderRadius: '20px',
                bgcolor: roles.surfaceContainer,
                border: `2px dashed ${roles.outlineVariant}`,
              }}
            >
              <Typography variant="bodyLarge">{t.signInKeep}</Typography>
              <Button variant="contained" sx={{ mt: 3 }} onClick={() => setSignIn(true)}>
                {t.signIn}
              </Button>
            </Box>
          )}
        </Stack>
      )}
      <SignInSheet
        open={signIn}
        onClose={() => setSignIn(false)}
        onSignedIn={() => setSignIn(false)}
        body={t.signInKeep}
      />
    </Box>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box component="section" aria-label={title}>
      <Typography component="h2" variant="titleLarge" sx={{ mb: 2 }}>
        {title}
      </Typography>
      {children}
    </Box>
  )
}

function LevelCard({ view }: { view: PassportView }) {
  const t = usePassportCopy()
  const locale = useLocale()
  const theme = useTheme()
  const tone = theme.chalk.sunflower
  const scope = useRef<HTMLDivElement>(null)
  const points = view.level.requirements.find((r) => r.key === 'points')
  const progress = points ? points.have / points.need : 1
  const number = (n: number) => new Intl.NumberFormat(locale).format(n)
  // The ring closes from empty, once per visit to the page.
  useChalkTimeline(scope, (root) => {
    const ring = root.querySelector<SVGCircleElement>('.level-ring')
    if (!ring) return
    const full = Number(ring.getAttribute('stroke-dasharray'))
    gsap.from(ring, { strokeDashoffset: full, duration: 1, ease: 'power2.out', delay: 0.15 })
  })
  return (
    <Box
      ref={scope}
      sx={{
        p: 4,
        borderRadius: '28px',
        bgcolor: tone.container,
        color: tone.onContainer,
        display: 'flex',
        gap: 4,
        alignItems: 'center',
        flexWrap: 'wrap',
      }}
    >
      <LevelRing value={progress} label={number(view.total)} />
      <Box sx={{ flex: '1 1 180px', minWidth: 0 }}>
        <Typography variant="labelLarge">{t.points}</Typography>
        <Typography sx={{ fontFamily: HAND_FONT, fontWeight: 700, fontSize: 34, lineHeight: 1.15 }}>
          {t[view.level.key]}
        </Typography>
        <Typography variant="bodyLarge" sx={{ mt: 1 }}>
          {view.level.next && view.level.next_requirement
            ? requirementText(view.level.next_requirement, view.level.next, t)
            : t.topLevel}
        </Typography>
        {view.demo_points > 0 && (
          <Typography variant="bodySmall" sx={{ mt: 1, opacity: 0.85 }}>
            {fill(t.demoPoints, { n: number(view.demo_points) })}. {t.demoPointsNote}
          </Typography>
        )}
      </Box>
    </Box>
  )
}

/**
 * Scratch cards waiting to be scratched, one at a time. The card being scratched stays on screen
 * after the passport refreshes (which drops it from the waiting list) until the customer moves on.
 */
function PendingScratch({
  view,
  place,
  onSignIn,
}: {
  view: PassportView
  place: { lat: number; lng: number } | null
  onSignIn: () => void
}) {
  const t = useGamesCopy()
  const p = usePassportCopy()
  const account = useCustomer()
  const locale = useLocale()
  const theme = useTheme()
  const gold = theme.chalk.sunflower
  const [shown, setShown] = useState<ScratchView | null>(null)
  const waiting = view.games?.scratch ?? []
  const card = shown ?? waiting[0] ?? null
  if (!view.signed_in && account.status !== 'guest')
    return (
      <Stack
        direction="row"
        sx={{
          p: 3,
          gap: 2,
          alignItems: 'center',
          flexWrap: 'wrap',
          borderRadius: '20px',
          border: `2px dashed ${gold.main}`,
        }}
      >
        <Typography variant="bodyMedium" sx={{ flex: '1 1 200px' }}>
          {t.signInScratch}
        </Typography>
        <HowItWorks game="scratch" />
        <Button variant="outlined" onClick={onSignIn}>
          {p.signIn}
        </Button>
      </Stack>
    )
  if (!card) return null
  const left = waiting.filter((c) => c.id !== card.id).length
  return (
    <Box
      component="section"
      aria-label={t.scratchTitle}
      sx={{ p: 4, borderRadius: '24px', bgcolor: theme.material.surfaceContainerLow }}
    >
      <Typography component="h2" variant="titleLarge" sx={{ mb: 2 }}>
        {fill(t.scratchWaiting, { n: new Intl.NumberFormat(locale).format(waiting.length || 1) })}
      </Typography>
      <ScratchCard key={card.id} card={card} place={place} onOpened={setShown} />
      {shown && (
        <Button variant="contained" sx={{ mt: 2 }} onClick={() => setShown(null)}>
          {left ? t.scratchNext : p.done}
        </Button>
      )}
    </Box>
  )
}

function StampBook({ view }: { view: PassportView }) {
  const t = usePassportCopy()
  const rewards = useRewardCopy()
  const locale = useLocale()
  const number = (value: number) => new Intl.NumberFormat(locale).format(value)
  const roles = useTheme().material
  const stamped = view.shops.filter((s) => s.days > 0)
  if (!stamped.length)
    return (
      <Section title={t.stampBook}>
        <Box sx={{ p: 4, borderRadius: '20px', bgcolor: roles.surfaceContainerLow }}>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 3, mb: 3 }}>
            {Array.from({ length: 4 }, (_, i) => (
              <Sticker key={i} id={String(i)} ghost size={64} />
            ))}
          </Box>
          <Typography variant="titleMedium">{t.emptyBook}</Typography>
          <Typography variant="bodyMedium" color="text.secondary" sx={{ mt: 1 }}>
            {t.emptyBookBody}
          </Typography>
        </Box>
      </Section>
    )
  const areas = view.areas.length
    ? view.areas
    : [{ id: '', name: '', shops: stamped.length, stamps: 0, demo: false }]
  return (
    <Section title={t.stampBook}>
      <Stack spacing={3}>
        {areas.map((area) => {
          const shops = stamped.filter((s) => s.area === area.id || !area.id)
          return (
            <Box
              key={area.id}
              sx={{ p: 4, borderRadius: '20px', bgcolor: roles.surfaceContainerLow }}
            >
              <Stack direction="row" sx={{ alignItems: 'baseline', gap: 2, flexWrap: 'wrap' }}>
                <Typography
                  component="h3"
                  sx={{
                    fontFamily: HAND_FONT,
                    fontWeight: 700,
                    fontSize: 28,
                    overflowWrap: 'break-word',
                  }}
                >
                  {area.name || t.yourArea}
                </Typography>
                <Typography variant="labelLarge" color="text.secondary">
                  {fill(t.stampsCount, { n: shops.reduce((n, s) => n + s.days, 0) })}
                </Typography>
                {area.demo && (
                  <Chip
                    size="small"
                    label={t.demoArea}
                    sx={{
                      maxWidth: '100%',
                      height: 'auto',
                      minHeight: 24,
                      '& .MuiChip-label': { whiteSpace: 'normal', py: 0.5 },
                    }}
                  />
                )}
              </Stack>
              <Box
                component="ul"
                sx={{
                  listStyle: 'none',
                  p: 0,
                  m: 0,
                  mt: 3,
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))',
                  gap: 3,
                }}
              >
                {shops.map((shop, index) => {
                  const first = view.stamps.some((s) => s.shop_id === shop.id && s.kind === 'first')
                  return (
                    <Box
                      component="li"
                      key={shop.id}
                      sx={{
                        ...dealIn,
                        '--deal-index': index,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: 1,
                        textAlign: 'center',
                        minHeight: 'auto',
                        overflowWrap: 'break-word',
                      }}
                    >
                      <a
                        href={`/explore/s/${shop.id}`}
                        onClick={customerNavigate}
                        style={{ color: 'inherit', textDecoration: 'none', display: 'contents' }}
                      >
                        <Sticker
                          id={shop.id}
                          category={shop.category}
                          kind={first ? 'first' : shop.rescues ? 'rescue' : 'visit'}
                        />
                        <Typography
                          variant="labelMedium"
                          sx={{
                            overflow: 'hidden',
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflowWrap: 'break-word',
                            wordBreak: 'break-word',
                          }}
                        >
                          {shop.name.replace(/\s*\(Demo\)$/, '')}
                        </Typography>
                      </a>
                      <Typography variant="labelSmall" color="text.secondary">
                        {/* A shop with a stamp card: the same count as its shop page. */}
                        {shop.slots
                          ? rewards.progress
                              .replace('{count}', number(shop.stamps))
                              .replace('{total}', number(shop.slots))
                          : `× ${shop.days}`}
                      </Typography>
                    </Box>
                  )
                })}
                {Array.from({ length: Math.max(0, SLOTS - shops.length) }, (_, i) => (
                  <Box
                    component="li"
                    key={`ghost-${i}`}
                    aria-hidden="true"
                    sx={{ display: 'grid', placeItems: 'center' }}
                  >
                    <Sticker id={`ghost-${i}`} ghost />
                  </Box>
                ))}
              </Box>
            </Box>
          )
        })}
      </Stack>
    </Section>
  )
}

function questTitle(quest: Quest, t: PassportStrings) {
  if (quest.kind === 'festival')
    return (
      (t[quest.festival as keyof PassportStrings] as string | undefined) ?? quest.festival ?? ''
    )
  return {
    breakthrough: t.breakthrough,
    crawl: t.crawl,
    rescue: t.rescueQuest,
    makers: t.makers,
  }[quest.kind]
}

function questBody(quest: Quest, t: PassportStrings) {
  if (quest.kind === 'festival') return fill(t.festivalBody, { n: quest.need })
  return {
    breakthrough: t.breakthroughBody,
    crawl: t.crawlBody,
    rescue: t.rescueQuestBody,
    makers: t.makersBody,
  }[quest.kind]
}

function Quests({ quests }: { quests: Quest[] }) {
  useEffect(() => {
    if (location.hash === '#quests')
      document.getElementById('quests')?.scrollIntoView({ block: 'start', behavior: 'instant' })
  }, [])
  const t = usePassportCopy()
  const locale = useLocale()
  const theme = useTheme()
  const roles = theme.material
  const ordered = [...quests].sort(
    (a, b) =>
      Number(b.kind === 'festival') - Number(a.kind === 'festival') ||
      Number(a.done) - Number(b.done),
  )
  const date = (iso: string) =>
    new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(
      new Date(`${iso}T12:00:00`),
    )
  return (
    <Section title={t.quests}>
      <Stack spacing={3} id="quests" sx={{ scrollMarginTop: 72 }}>
        {ordered.map((quest) => {
          const tone =
            quest.kind === 'festival'
              ? theme.chalk.sunflower
              : quest.kind === 'rescue'
                ? theme.chalk.coral
                : theme.chalk.mint
          const Art = quest.art ? FESTIVAL_ART[quest.art as keyof typeof FESTIVAL_ART] : Trophy
          return (
            <Box
              key={quest.id}
              sx={{
                p: 4,
                borderRadius: '20px',
                bgcolor: quest.kind === 'festival' ? tone.container : roles.surfaceContainerLow,
                color: quest.kind === 'festival' ? tone.onContainer : roles.onSurface,
                border: quest.kind === 'festival' ? 'none' : `1px solid ${roles.outlineVariant}`,
              }}
            >
              <Stack direction="row" sx={{ gap: 3, alignItems: 'flex-start' }}>
                <Box
                  aria-hidden="true"
                  sx={{
                    width: 48,
                    height: 48,
                    flexShrink: 0,
                    borderRadius: '50%',
                    display: 'grid',
                    placeItems: 'center',
                    bgcolor: tone.main,
                    color: tone.onMain,
                  }}
                >
                  {quest.done ? <Check size={24} /> : <Art size={24} />}
                </Box>
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Typography component="h3" variant="titleMedium" sx={{ fontWeight: 700 }}>
                    {questTitle(quest, t)}
                  </Typography>
                  <Typography variant="bodyMedium" sx={{ opacity: 0.85 }}>
                    {questBody(quest, t)}
                  </Typography>
                  <LinearProgress
                    variant="determinate"
                    value={(quest.have / quest.need) * 100}
                    aria-label={fill(t.questProgress, { have: quest.have, need: quest.need })}
                    sx={{
                      mt: 2,
                      height: 8,
                      borderRadius: 4,
                      bgcolor: roles.surfaceContainerHighest,
                      '& .MuiLinearProgress-bar': { bgcolor: tone.main, borderRadius: 4 },
                    }}
                  />
                  <Stack direction="row" sx={{ mt: 1.5, gap: 2, flexWrap: 'wrap' }}>
                    <Typography variant="labelLarge">
                      {quest.done
                        ? t.questDone
                        : fill(t.questProgress, { have: quest.have, need: quest.need })}
                    </Typography>
                    <Typography variant="labelLarge">
                      {fill(t.questReward, { n: quest.points })}
                    </Typography>
                    <Typography variant="labelLarge" sx={{ opacity: 0.8 }}>
                      {fill(t.questEnds, { date: date(quest.ends) })}
                    </Typography>
                  </Stack>
                  {quest.approximate && (
                    <Typography variant="bodySmall" sx={{ mt: 1, opacity: 0.8 }}>
                      {t.approximate}
                    </Typography>
                  )}
                  {(quest.stops?.length ?? 0) > 0 && !quest.done && (
                    <Box sx={{ mt: 2 }}>
                      <Typography variant="labelMedium" sx={{ opacity: 0.8 }}>
                        {t.stops}
                      </Typography>
                      <Stack direction="row" sx={{ mt: 1, gap: 1, flexWrap: 'wrap' }}>
                        {(quest.stops ?? []).map((stop) => (
                          <Chip
                            key={stop.shop_id}
                            component="a"
                            href={`/explore/s/${stop.shop_id}`}
                            onClick={customerNavigate}
                            clickable
                            icon={stop.done ? <Check size={14} /> : undefined}
                            label={stop.name.replace(/\s*\(Demo\)$/, '')}
                            sx={{ minHeight: 48, borderRadius: 999, bgcolor: roles.surface }}
                          />
                        ))}
                      </Stack>
                    </Box>
                  )}
                </Box>
              </Stack>
            </Box>
          )
        })}
      </Stack>
    </Section>
  )
}

function Impact({ view }: { view: PassportView }) {
  const t = usePassportCopy()
  const locale = useLocale()
  const theme = useTheme()
  const coral = theme.chalk.coral
  const meals = view.impact.meals
  const growth = [0, 1, 5, 12, 25, 50].filter((m) => meals >= m).length
  return (
    <Section title={t.impact}>
      <Box
        sx={{
          p: 4,
          borderRadius: '20px',
          bgcolor: coral.container,
          color: coral.onContainer,
          display: 'flex',
          gap: 4,
          alignItems: 'center',
        }}
      >
        <Box
          aria-hidden="true"
          sx={{ display: 'grid', placeItems: 'center', width: 64, height: 64, flexShrink: 0 }}
        >
          <Leaf size={20 + growth * 7} />
        </Box>
        <Box sx={{ minWidth: 0 }}>
          {meals ? (
            <>
              <Typography variant="titleLarge" sx={{ fontWeight: 700 }}>
                {fill(t.meals, { n: new Intl.NumberFormat(locale).format(meals) })}
              </Typography>
              <Typography variant="bodyMedium" title={t.co2Note}>
                {fill(t.co2, { kg: new Intl.NumberFormat(locale).format(view.impact.co2_kg) })}
              </Typography>
              {Object.entries(view.impact.saved).map(([currency, minor]) => (
                <Typography key={currency} variant="bodyMedium">
                  {fill(t.moneySaved, { amount: formatPrice(minor, currency, locale) })}
                </Typography>
              ))}
              <Typography variant="bodySmall" sx={{ mt: 1, opacity: 0.8 }}>
                {t.co2Note}
              </Typography>
            </>
          ) : (
            <Typography variant="bodyLarge">{t.noRescues}</Typography>
          )}
        </Box>
      </Box>
    </Section>
  )
}

function Perks({ view }: { view: PassportView }) {
  const t = usePassportCopy()
  const theme = useTheme()
  const roles = theme.material
  return (
    <Section title={t.perks}>
      {(view.games?.won_perks?.length ?? 0) > 0 && (
        <Box sx={{ mb: 3 }}>
          <WonPerks perks={view.games?.won_perks ?? []} signedIn={view.signed_in} />
        </Box>
      )}
      {view.perks.length ? (
        <Stack spacing={2}>
          {view.perks.map((perk) => (
            <Stack
              key={`${perk.shop_id}-${perk.id}`}
              direction="row"
              sx={{
                p: 3,
                gap: 3,
                alignItems: 'center',
                borderRadius: '20px',
                bgcolor: theme.chalk.lilac.container,
                color: theme.chalk.lilac.onContainer,
                ...dealIn,
              }}
            >
              <Gift size={28} aria-hidden="true" />
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="titleMedium" sx={{ fontWeight: 700 }}>
                  {perk.text}
                </Typography>
                <Typography variant="bodySmall">
                  {fill(t.perkFrom, { shop: perk.shop_name.replace(/\s*\(Demo\)$/, '') })}
                </Typography>
              </Box>
              {perk.demo && <Chip size="small" label={t.demoPerk} sx={{ ml: 'auto' }} />}
            </Stack>
          ))}
        </Stack>
      ) : (
        <Typography variant="bodyMedium" sx={{ color: roles.onSurfaceVariant }}>
          {t.noPerks}
        </Typography>
      )}
    </Section>
  )
}

function Leaderboard({
  view,
  place,
  onSignIn,
}: {
  view: PassportView
  place: { lat: number; lng: number } | null
  onSignIn: () => void
}) {
  const t = usePassportCopy()
  const locale = useLocale()
  const account = useCustomer()
  const accountCopy = useAccountCopy()
  const roles = useTheme().material
  const [board, setBoard] = useState<Board | null>(null)
  const [failure, setFailure] = useState<'load' | 'save' | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const signedIn = account.status === 'signed-in'
  const api = account.api
  const joined = view.leaderboard
  const query = where(place)
  useEffect(() => {
    if (!signedIn) return
    let live = true
    api<Board>(`/api/v1/customer/passport/board?${query}`)
      .then((data) => {
        if (!live) return
        setBoard(data)
        setFailure((current) => (current === 'load' ? null : current))
      })
      .catch(() => live && setFailure('load'))
    return () => {
      live = false
    }
  }, [api, signedIn, joined, query, attempt])
  async function toggle(on: boolean) {
    setBusy(true)
    setFailure(null)
    try {
      setPassport(
        await api<PassportView>('/api/v1/customer/passport/leaderboard', {
          method: 'PUT',
          body: JSON.stringify({ on }),
        }),
      )
    } catch {
      setFailure('save')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section title={t.board}>
      <Box sx={{ p: 4, borderRadius: '20px', bgcolor: roles.surfaceContainerLow }}>
        {failure && (
          <Alert
            severity="error"
            sx={{ mb: 2 }}
            action={
              <Button
                color="inherit"
                onClick={() =>
                  failure === 'save' ? void toggle(!joined) : setAttempt((n) => n + 1)
                }
              >
                {t.retry}
              </Button>
            }
          >
            {accountCopy.actionFailed}
            <Button component="a" href="/explore/" onClick={customerNavigate} color="inherit">
              {accountCopy.findShops}
            </Button>
          </Alert>
        )}
        {signedIn ? (
          <Stack direction="row" sx={{ alignItems: 'center', gap: 2 }}>
            <Typography variant="bodyMedium" sx={{ flex: 1 }}>
              {t.boardShares}
            </Typography>
            <Switch
              checked={joined}
              disabled={busy}
              onChange={(_, on) => void toggle(on)}
              slotProps={{ input: { 'aria-label': joined ? t.boardLeave : t.boardJoin } }}
            />
          </Stack>
        ) : (
          <Stack spacing={2}>
            <Typography variant="bodyMedium">{t.boardShares}</Typography>
            <Button variant="outlined" onClick={onSignIn} sx={{ alignSelf: 'flex-start' }}>
              {t.boardSignIn}
            </Button>
          </Stack>
        )}
        {signedIn && board && (
          <Box sx={{ mt: 3 }}>
            {board.rows.length === 0 && (
              <Typography variant="bodyMedium" color="text.secondary">
                {t.boardEmpty}
              </Typography>
            )}
            {board.rows.length > 0 && (
              <Box component="ol" sx={{ listStyle: 'none', p: 0, m: 0 }}>
                {board.rows.slice(0, 10).map((row) => (
                  <Stack
                    component="li"
                    key={`${row.rank}-${row.name}`}
                    direction="row"
                    sx={{
                      py: 1.5,
                      gap: 2,
                      alignItems: 'center',
                      borderBottom: `1px solid ${roles.outlineVariant}`,
                      fontWeight: row.you ? 700 : 400,
                    }}
                  >
                    <Typography
                      sx={{ width: 32, fontFamily: HAND_FONT, fontSize: 22, fontWeight: 700 }}
                    >
                      {new Intl.NumberFormat(locale).format(row.rank)}
                    </Typography>
                    <Typography variant="bodyLarge" sx={{ flex: 1, fontWeight: 'inherit' }}>
                      {row.name}
                    </Typography>
                    {row.demo && <Chip size="small" label={t.demo} />}
                    <Typography variant="labelLarge" color="text.secondary">
                      {t[row.level]}
                    </Typography>
                    <Typography variant="labelLarge" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                      {new Intl.NumberFormat(locale).format(row.points)}
                    </Typography>
                  </Stack>
                ))}
              </Box>
            )}
            {!joined && (
              <Typography variant="bodySmall" color="text.secondary" sx={{ mt: 2 }}>
                {t.boardHidden}
              </Typography>
            )}
          </Box>
        )}
      </Box>
    </Section>
  )
}
