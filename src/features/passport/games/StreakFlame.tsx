import { useRef, useState } from 'react'
import { Alert, Box, Button, Stack, Typography, useTheme } from '@mui/material'
import { gsap } from 'gsap'
import { Check, Snowflake } from 'lucide-react'
import { dealIn, useChalkTimeline } from '../../../design/chalkMotion'
import { HAND_FONT } from '../../../design/theme'
import { useLocale } from '../../../state/hooks'
import { fill, usePassportCopy } from '../copy'
import type { PassportView } from '../store'
import { useGameActions } from './api'
import { useGamesCopy } from './copy'
import { HowItWorks } from './HowItWorks'
import { useCustomer } from '../../customer/account'

/** A chalk flame: lit coral and gold while a streak runs, a grey ember when it has not started. */
export function Flame({ lit, size = 64 }: { lit: boolean; size?: number }) {
  const theme = useTheme()
  const outer = lit ? theme.chalk.coral.main : theme.material.outlineVariant
  const inner = lit ? '#F2B53A' : theme.material.surfaceContainerHighest
  return (
    <Box
      component="svg"
      viewBox="0 0 64 80"
      aria-hidden="true"
      sx={{ width: size, height: size * 1.25, flexShrink: 0, overflow: 'visible' }}
    >
      <g className="flame" style={{ transformOrigin: '32px 76px' }}>
        <path
          d="M32 4c4 14 22 22 22 44a22 22 0 0 1-44 0c0-10 5-17 10-22 1 8 4 12 8 13-3-14 0-26 4-35z"
          fill={outer}
        />
        <path
          className="flame-core"
          style={{ transformOrigin: '32px 74px' }}
          d="M32 36c3 8 12 12 12 22a12 12 0 0 1-24 0c0-6 3-9 6-12 1 4 2 6 4 7-1-7 0-12 2-17z"
          fill={inner}
        />
      </g>
    </Box>
  )
}

/**
 * The weekly streak (docs/research/gamification.md §3): a flame that grows with the weeks, the
 * freezes in the bank, the last 8 weeks, a gentle nudge when this week still needs a stamp, and
 * a way to freeze a week ahead. Loss aversion done kindly: freezes are given, never sold.
 */
export function StreakFlame({
  view,
  place,
}: {
  view: PassportView
  place?: { lat: number; lng: number } | null
}) {
  const account = useCustomer()
  const t = useGamesCopy()
  const p = usePassportCopy()
  const locale = useLocale()
  const theme = useTheme()
  const roles = theme.material
  const coral = theme.chalk.coral
  const ice = theme.chalk.sky
  const scope = useRef<HTMLDivElement>(null)
  const { freeze } = useGameActions(place)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null)
  const run = view.streak
  const weeks = run.weeks
  const freezes = run.freezes ?? run.rain_checks
  const thisFrozen = run.row[run.row.length - 1] === 'frozen'
  const nextFrozen = (run.planned?.length ?? 0) > (thisFrozen ? 1 : 0)
  const number = (n: number) => new Intl.NumberFormat(locale).format(n)
  // The flame flickers a few times on arrival, then rests.
  useChalkTimeline(
    scope,
    (root) => {
      if (!weeks) return
      gsap.fromTo(
        root.querySelector('.flame'),
        { scaleY: 0.4, opacity: 0 },
        { scaleY: 1, opacity: 1, duration: 0.5, ease: 'back.out(2)' },
      )
      gsap.to(root.querySelector('.flame-core'), {
        scaleY: 1.12,
        scaleX: 0.94,
        duration: 0.35,
        ease: 'sine.inOut',
        yoyo: true,
        repeat: 7,
        delay: 0.5,
      })
    },
    [weeks],
  )
  async function plan(week: 'this' | 'next') {
    setBusy(true)
    setMessage(null)
    try {
      const verdict = await freeze(week)
      setMessage(
        verdict === 'frozen'
          ? { text: week === 'next' ? t.freezeNextDone : t.freezeThisDone }
          : verdict === 'no_freezes'
            ? { text: t.freezeNone, error: true }
            : null,
      )
    } catch {
      setMessage({ text: t.freezeFailed, error: true })
    } finally {
      setBusy(false)
    }
  }
  const labels = {
    done: p.weekDone,
    rain: t.weekCovered,
    frozen: t.weekFrozen,
    missed: p.weekMissed,
    current: p.weekCurrent,
  }
  return (
    <Box
      ref={scope}
      component="section"
      aria-label={fill(p.streak, { n: weeks })}
      sx={{
        p: 4,
        borderRadius: '24px',
        bgcolor: weeks ? coral.container : roles.surfaceContainerLow,
        color: weeks ? coral.onContainer : roles.onSurface,
      }}
    >
      <Stack direction="row" sx={{ alignItems: 'center', gap: 3 }}>
        <Flame lit={weeks > 0} size={Math.min(72, 48 + weeks * 3)} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography component="h2" variant="titleMedium" sx={{ fontWeight: 700 }}>
            {t.streakFlame}
          </Typography>
          <Stack direction="row" sx={{ alignItems: 'baseline', gap: 1 }}>
            <Typography
              sx={{ fontFamily: HAND_FONT, fontWeight: 700, fontSize: 44, lineHeight: 1 }}
            >
              {number(weeks)}
            </Typography>
            <Typography variant="labelLarge">{t.weeksLabel}</Typography>
          </Stack>
        </Box>
        <HowItWorks game="streak" />
      </Stack>
      {/* The bank of freezes, as ice tokens. */}
      <Stack
        direction="row"
        sx={{ mt: 2, alignItems: 'center', gap: 1 }}
        aria-label={fill(t.freezes, { n: freezes })}
        role="img"
      >
        {Array.from({ length: Math.max(freezes, 0) }, (_, i) => (
          <Box
            key={i}
            sx={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              display: 'grid',
              placeItems: 'center',
              bgcolor: ice.container,
              color: ice.onContainer,
              ...dealIn,
              '--deal-index': i,
            }}
          >
            <Snowflake size={18} aria-hidden="true" />
          </Box>
        ))}
        <Typography variant="labelLarge" aria-hidden="true">
          {fill(t.freezes, { n: number(freezes) })}
        </Typography>
      </Stack>
      <Box
        component="ol"
        aria-label={p.weekRow}
        sx={{ listStyle: 'none', p: 0, m: 0, mt: 3, display: 'flex', gap: 1.5 }}
      >
        {run.row.map((mark, index) => {
          const cold = mark === 'frozen' || mark === 'rain'
          return (
            <Box
              component="li"
              key={index}
              aria-label={labels[mark]}
              sx={{
                flex: 1,
                aspectRatio: '1',
                maxWidth: 40,
                borderRadius: '50%',
                display: 'grid',
                placeItems: 'center',
                bgcolor: mark === 'done' ? coral.main : cold ? ice.container : 'transparent',
                color: mark === 'done' ? coral.onMain : cold ? ice.onContainer : 'inherit',
                border:
                  mark === 'done' || cold
                    ? 'none'
                    : `2px ${mark === 'current' ? 'dashed' : 'solid'} ${
                        mark === 'current' ? coral.main : roles.outlineVariant
                      }`,
                ...(mark === 'done' && { ...dealIn, '--deal-index': index, '--deal-tilt': '0deg' }),
              }}
            >
              {mark === 'done' ? (
                <Check size={18} aria-hidden="true" />
              ) : cold ? (
                <Snowflake size={16} aria-hidden="true" />
              ) : null}
            </Box>
          )
        })}
      </Box>
      {view.games?.nudge && (
        <Typography variant="bodyMedium" sx={{ mt: 3, fontWeight: 500 }}>
          {t.nudge}
        </Typography>
      )}
      {weeks === 0 && view.stamps.length > 0 && (
        <Typography variant="bodySmall" sx={{ mt: 2, opacity: 0.85 }}>
          {p.newStreak}
        </Typography>
      )}
      {view.signed_in || account.status === 'guest' ? (
        <Stack direction="row" sx={{ mt: 3, gap: 1.5, flexWrap: 'wrap' }}>
          {!run.this_week && !thisFrozen && freezes > 0 && weeks > 0 && (
            <Button
              variant="outlined"
              color="inherit"
              disabled={busy}
              startIcon={<Snowflake size={18} />}
              onClick={() => void plan('this')}
            >
              {t.freezeThis}
            </Button>
          )}
          {!nextFrozen && freezes > 0 && (
            <Button
              variant="outlined"
              color="inherit"
              disabled={busy}
              startIcon={<Snowflake size={18} />}
              onClick={() => void plan('next')}
            >
              {t.freezeNext}
            </Button>
          )}
          {nextFrozen && !message && (
            <Typography variant="bodyMedium" role="status">
              {t.freezeNextDone}
            </Typography>
          )}
        </Stack>
      ) : (
        <Typography variant="bodySmall" sx={{ mt: 2, opacity: 0.85 }}>
          {t.freezeSignIn}
        </Typography>
      )}
      {message &&
        (message.error ? (
          <Alert severity="warning" sx={{ mt: 2 }}>
            {message.text}
          </Alert>
        ) : (
          <Typography variant="bodyMedium" role="status" sx={{ mt: 2, fontWeight: 500 }}>
            {message.text}
          </Typography>
        ))}
    </Box>
  )
}
