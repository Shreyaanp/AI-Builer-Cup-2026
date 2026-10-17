import { useRef, useState } from 'react'
import { Alert, Box, Button, Chip, Stack, Typography, useTheme } from '@mui/material'
import { gsap } from 'gsap'
import { HeartHandshake } from 'lucide-react'
import { useChalkTimeline } from '../../../design/chalkMotion'
import { HAND_FONT } from '../../../design/theme'
import { useLocale } from '../../../state/hooks'
import { fill, usePassportCopy } from '../copy'
import { useGameActions } from './api'
import type { CoopView } from './api'
import { useGamesCopy } from './copy'
import { HowItWorks } from './HowItWorks'
import { SignInSheet } from '../../customer/SignIn'
import { useGuestCopy } from '../../customer/guestCopy'
import { useCustomer } from '../../customer/account'

/**
 * The neighbourhood goal (docs/research/gamification.md §5): one shared bar for the area's
 * verified visits this week. The customer's own part is drawn in gold inside it, so their
 * contribution is visible; when the street reaches the goal, everyone who helped collects.
 */
export function CoopGoal({
  coop,
  signedIn,
  place,
  compact = false,
}: {
  coop: CoopView
  signedIn: boolean
  place?: { lat: number; lng: number } | null
  compact?: boolean
}) {
  const account = useCustomer()
  const guest = useGuestCopy()
  const [signIn, setSignIn] = useState(false)
  const t = useGamesCopy()
  const p = usePassportCopy()
  const locale = useLocale()
  const theme = useTheme()
  const roles = theme.material
  const sky = theme.chalk.sky
  const gold = theme.chalk.sunflower
  const scope = useRef<HTMLDivElement>(null)
  const { claimCoop } = useGameActions(place)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const number = (n: number) => new Intl.NumberFormat(locale).format(n)
  const share = (n: number) => `${Math.max(0, Math.min(1, n / coop.goal)) * 100}%`
  const others = Math.max(0, coop.total - coop.demo_visits - coop.you)
  const date = new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(
    new Date(`${coop.ends}T12:00:00`),
  )
  // The bar fills from empty and the total counts up, once per visit to the page.
  useChalkTimeline(
    scope,
    (root) => {
      gsap.from(root.querySelector('.coop-fill'), {
        scaleX: 0,
        duration: 1.1,
        ease: 'power3.out',
        delay: 0.2,
      })
      gsap.from(root.querySelector('.coop-you'), {
        scaleY: 0,
        duration: 0.4,
        ease: 'back.out(3)',
        delay: 1.1,
      })
      const counter = root.querySelector('.coop-total')
      if (counter) {
        const value = { n: 0 }
        gsap.to(value, {
          n: coop.total,
          duration: 1.1,
          ease: 'power3.out',
          delay: 0.2,
          onUpdate: () => {
            counter.textContent = fill(t.coopProgress, {
              total: number(Math.round(value.n)),
              goal: number(coop.goal),
            })
          },
        })
      }
    },
    [coop.total],
  )
  async function collect() {
    setBusy(true)
    setFailed(false)
    try {
      await claimCoop(coop)
      navigator.vibrate?.([20, 40, 20])
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Box
      ref={scope}
      component="section"
      aria-label={t.coopTitle}
      sx={{ p: 4, borderRadius: '24px', bgcolor: sky.container, color: sky.onContainer }}
    >
      <Stack direction="row" sx={{ alignItems: 'center', gap: 2 }}>
        <HeartHandshake size={28} aria-hidden="true" />
        <Typography component="h2" variant="titleMedium" sx={{ fontWeight: 700, flex: 1 }}>
          {t.coopTitle}
        </Typography>
        {coop.demo && <Chip size="small" label={p.demo} />}
        {!compact && <HowItWorks game="coop" />}
      </Stack>
      <Typography
        sx={{ fontFamily: HAND_FONT, fontWeight: 700, fontSize: 28, lineHeight: 1.15, mt: 1 }}
      >
        {coop.area_name
          ? fill(t.coopGoal, { goal: number(coop.goal), area: coop.area_name })
          : fill(t.coopGoalHere, { goal: number(coop.goal) })}
      </Typography>
      {/* The shared bar: demo neighbours (hatched), real neighbours, then you in gold. */}
      <Box
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={coop.goal}
        aria-valuenow={Math.min(coop.total, coop.goal)}
        aria-label={fill(t.coopProgress, { total: coop.total, goal: coop.goal })}
        sx={{
          mt: 2,
          height: 22,
          borderRadius: '11px',
          overflow: 'hidden',
          bgcolor: roles.surface,
          border: `2px solid ${sky.main}`,
        }}
      >
        <Box
          className="coop-fill"
          sx={{ display: 'flex', height: '100%', transformOrigin: 'left center' }}
        >
          <Box
            sx={{
              width: share(coop.demo_visits),
              bgcolor: sky.main,
              opacity: 0.45,
              backgroundImage:
                'repeating-linear-gradient(135deg, transparent 0 6px, rgba(255,255,255,0.45) 6px 9px)',
            }}
          />
          <Box sx={{ width: share(others), bgcolor: sky.main }} />
          {coop.you > 0 && (
            <Box
              className="coop-you"
              sx={{
                width: `max(10px, ${share(coop.you)})`,
                bgcolor: gold.container,
                borderLeft: `2px solid ${gold.main}`,
                transformOrigin: 'bottom',
              }}
            />
          )}
        </Box>
      </Box>
      <Stack direction="row" sx={{ mt: 1.5, gap: 2, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <Typography
          className="coop-total"
          variant="labelLarge"
          sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}
        >
          {fill(t.coopProgress, { total: number(coop.total), goal: number(coop.goal) })}
        </Typography>
        <Typography variant="labelLarge">{fill(t.coopYou, { n: number(coop.you) })}</Typography>
        {!compact && (
          <Typography variant="labelLarge">
            {fill(t.coopHelpers, { n: number(coop.helpers) })}
          </Typography>
        )}
      </Stack>
      {!compact && (
        <>
          <Typography variant="bodyMedium" sx={{ mt: 2 }}>
            {fill(t.coopReward, { n: number(coop.bonus) })}
          </Typography>
          <Typography variant="bodySmall" sx={{ mt: 0.5, opacity: 0.85 }}>
            {fill(t.coopEnds, { date })}
            {coop.demo_visits > 0 && ` · ${fill(t.coopDemo, { n: number(coop.demo_visits) })}`}
          </Typography>
        </>
      )}
      {coop.reached && coop.you > 0 && (signedIn || account.status === 'guest') ? (
        coop.claimed ? (
          <Typography variant="titleSmall" role="status" sx={{ mt: 2, fontWeight: 700 }}>
            {t.coopClaimed}
          </Typography>
        ) : (
          <Stack sx={{ mt: 2, gap: 1 }}>
            <Typography variant="titleSmall" sx={{ fontWeight: 700 }}>
              {t.coopReached}
            </Typography>
            <Button
              variant="contained"
              disabled={busy}
              onClick={() => (signedIn ? void collect() : setSignIn(true))}
              sx={{ alignSelf: 'flex-start' }}
            >
              {fill(t.coopClaim, { n: number(coop.bonus) })}
            </Button>
          </Stack>
        )
      ) : (
        coop.you === 0 &&
        !compact && (
          <Typography variant="bodyMedium" sx={{ mt: 2, fontWeight: 500 }}>
            {t.coopJoin}
          </Typography>
        )
      )}
      <SignInSheet
        open={signIn}
        onClose={() => setSignIn(false)}
        onSignedIn={() => setSignIn(false)}
        title={guest.title}
        body={guest.claim}
      />
      {failed && (
        <Alert severity="warning" sx={{ mt: 2 }}>
          {t.coopFailed}
        </Alert>
      )}
    </Box>
  )
}
