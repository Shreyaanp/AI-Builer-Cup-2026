import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogContent,
  IconButton,
  Stack,
  Typography,
  useTheme,
} from '@mui/material'
import { Check, Star, X } from 'lucide-react'
import { HAND_FONT, shape } from '../../design/theme'
import { stampThud } from '../../design/chalkMotion'
import { useLocale } from '../../state/hooks'
import { useRewardCopy } from './strings'
import { celebrations, claimReward, useLanded, useRewards, visit } from './storage'
import { useCopy } from '../v1/strings'
import { useCustomer } from '../customer/account'
import { SignInSheet } from '../customer/SignIn'
import { useGuestCopy } from '../customer/guestCopy'
import { setPassport, usePassport } from '../passport/store'
import type { PassportView } from '../passport/store'
import { fill } from '../passport/copy'
import { useGamesCopy } from '../passport/games/copy'
import { HowItWorks } from '../passport/games/HowItWorks'

/** Endowed progress: 2 welcome stamps printed on every card, on top of the owner's target. */
const WELCOME = 2

/**
 * The stamps on a shop's card, welcome stamps included: the passport view's `stamps`, the one
 * count the button, the card and the passport all show. Before that view has this card (a
 * first visit, or a phone still loading), the same sum from this phone's card.
 */
function useCardCount(shop: string, target: number) {
  const { data } = useRewards()
  const account = useCustomer()
  const { view } = usePassport(null)
  const signedIn = account.status === 'signed-in'
  const server = view?.shops.find((card) => card.id === shop && card.slots > 0)
  const identified = signedIn || account.status === 'guest'
  const local = identified ? 0 : (data.shops[shop]?.stamps ?? 0)
  const stamps = Math.min(server?.stamps ?? WELCOME + local, target + WELCOME)
  return {
    signedIn,
    stamps,
    /** The customer's own stamps: the slots after the welcome ones. */
    count: stamps - WELCOME,
    claimed: identified ? (server?.claimed ?? 0) : (data.shops[shop]?.claimed ?? 0),
  }
}

function validTarget(needed: number) {
  return Number.isInteger(needed) && needed >= 3 && needed <= 20 ? needed : 8
}

/**
 * The card's progress near the top of the shop page, so the stamp card is never buried under
 * the menu: one tap jumps to the full card.
 */
export function StampPeek({ shop, needed = 8 }: { shop: string; needed?: number }) {
  const t = useRewardCopy()
  const locale = useLocale()
  const gold = useTheme().chalk.sunflower
  const target = validTarget(needed)
  const { stamps } = useCardCount(shop, target)
  const number = (value: number) => new Intl.NumberFormat(locale).format(value)
  return (
    <Button
      href="#stamp-card"
      size="small"
      startIcon={<Star size={16} fill="currentColor" />}
      onClick={(event) => {
        event.preventDefault()
        document.getElementById('stamp-card')?.scrollIntoView({
          behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
          block: 'start',
        })
      }}
      sx={{
        minHeight: 40,
        bgcolor: gold.container,
        color: gold.onContainer,
        '&:hover': { bgcolor: gold.container },
      }}
    >
      {t.stampCard} ·{' '}
      {t.progress.replace('{count}', number(stamps)).replace('{total}', number(target + WELCOME))}
    </Button>
  )
}

export function StampCard({
  shop,
  name,
  timezone,
  reward,
  needed = 8,
}: {
  shop: string
  name: string
  timezone: string
  reward?: string
  needed?: number
}) {
  const { unavailable } = useRewards()
  const t = useRewardCopy()
  const g = useGamesCopy()
  const common = useCopy()
  const locale = useLocale()
  const theme = useTheme()
  const roles = theme.material
  const gold = theme.chalk.sunflower
  const [redeeming, setRedeeming] = useState(false)
  const [failedClaim, setFailedClaim] = useState(false)
  const target = validTarget(needed)
  useEffect(() => {
    visit(shop, new URLSearchParams(location.search).get('source') === 'qr', timezone, target)
  }, [shop, timezone, target])
  useEffect(() => {
    if (!redeeming) return
    const back = () => setRedeeming(false)
    window.addEventListener('popstate', back)
    return () => window.removeEventListener('popstate', back)
  }, [redeeming])
  // Signed in: the server's card (verified visits); signed out: this phone's card.
  const account = useCustomer()
  const guestCopy = useGuestCopy()
  const [signIn, setSignIn] = useState(false)
  const { signedIn, stamps, count, claimed } = useCardCount(shop, target)
  const full = count >= target
  const number = (value: number) => new Intl.NumberFormat(locale).format(value)
  // After the stamp sheet closes: bring the card into view, then press the new stamp on.
  const landed = useLanded(shop)
  const cardRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!landed) return
    cardRef.current?.scrollIntoView({
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'center',
    })
  }, [landed])
  const close = () => {
    setRedeeming(false)
    if ((history.state as { rewardRedeem?: string } | null)?.rewardRedeem === shop) history.back()
  }
  return (
    <Box
      ref={cardRef}
      component="section"
      id="stamp-card"
      aria-label={t.stampCard}
      sx={{
        mt: 3,
        p: 4,
        scrollMarginTop: 72,
        borderRadius: `${shape.xl}px`,
        bgcolor: gold.container,
        color: gold.onContainer,
        boxShadow: `0 0 0 2px ${gold.main} inset`,
      }}
    >
      <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
        <Typography
          component="h2"
          sx={{ flex: 1, fontFamily: HAND_FONT, fontWeight: 700, fontSize: 30, lineHeight: 1.1 }}
        >
          {t.stampCard}
        </Typography>
        <HowItWorks game="card" />
      </Stack>
      <Typography
        component="p"
        variant="headlineSmall"
        role="status"
        sx={{
          fontVariantNumeric: 'tabular-nums',
          animation: celebrations.has(shop) ? 'stampCelebrate 700ms ease-out' : undefined,
          '@keyframes stampCelebrate': {
            '0%': { transform: 'scale(.95)', opacity: 0.5 },
            '100%': { transform: 'scale(1)', opacity: 1 },
          },
          '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
        }}
      >
        {/* Welcome stamps included, so never fewer than 2: no singular form is needed. */}
        {(celebrations.has(shop) && [5, 10].includes(count) ? t.milestone : t.stamps).replace(
          '{count}',
          number(stamps),
        )}
      </Typography>
      <Stack
        direction="row"
        role="img"
        aria-label={t.progress
          .replace('{count}', number(stamps))
          .replace('{total}', number(target + WELCOME))}
        sx={{ flexWrap: 'wrap', gap: 1.5, my: 3 }}
      >
        {/* The 2 welcome stamps come first, already pressed, in gold. */}
        {Array.from({ length: WELCOME }, (_, index) => (
          <Box
            key={`welcome-${index}`}
            component="span"
            aria-hidden="true"
            data-welcome="true"
            title={g.welcomeStamp}
            sx={{
              width: 36,
              height: 36,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '50%',
              bgcolor: gold.main,
              color: gold.onMain,
              transform: `rotate(${index ? 8 : -10}deg)`,
              boxShadow: '0 0 0 2px #FFFFFF',
            }}
          >
            <Star size={18} fill="currentColor" />
          </Box>
        ))}
        {Array.from({ length: target }, (_, index) => (
          <Box
            // A new key on the newest stamp restarts its press each time one lands.
            key={index === count - 1 ? `${index}-${landed}` : index}
            component="span"
            aria-hidden="true"
            data-filled={index < count}
            sx={{
              width: 36,
              height: 36,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '50%',
              border: index < count ? 'none' : `2px dashed ${gold.main}`,
              bgcolor: index < count ? theme.chalk.mint.main : roles.surface,
              color: index < count ? theme.chalk.mint.onMain : roles.onSurface,
              typography: 'labelMedium',
              ...(index === count - 1 && (celebrations.has(shop) || landed > 0)
                ? { ...stampThud, animationDelay: landed ? '280ms' : undefined }
                : {}),
              '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
            }}
          >
            {index < count ? <Check size={18} /> : number(index + WELCOME + 1)}
          </Box>
        ))}
      </Stack>
      <Typography variant="labelLarge" component="p" sx={{ mb: 1 }}>
        {fill(g.welcomeStamps, { n: number(WELCOME) })}
      </Typography>
      <Typography
        variant="titleMedium"
        component="p"
        sx={{ overflowWrap: 'anywhere', fontWeight: 700 }}
      >
        {reward
          ? full
            ? reward
            : t.more.replace('{count}', number(target - count)).replace('{reward}', reward)
          : t.noReward}
      </Typography>
      {/* One short line; the full "not proof of purchase" note is on the claim screen. */}
      <Typography variant="bodySmall" sx={{ mt: 1 }}>
        {t.qr} {signedIn ? t.account : t.phone}
      </Typography>
      {claimed > 0 && (
        <Typography variant="labelLarge" component="p" sx={{ mt: 2 }}>
          {claimed === 1 ? t.claimedOne : t.claimedMany.replace('{count}', number(claimed))}
        </Typography>
      )}
      {full && reward && (
        <Button
          variant="contained"
          fullWidth
          sx={{ mt: 3 }}
          disabled={unavailable}
          onClick={() => {
            if (account.status === 'guest') {
              setSignIn(true)
              return
            }
            history.pushState({ ...(history.state as object | null), rewardRedeem: shop }, '')
            setFailedClaim(false)
            setRedeeming(true)
          }}
        >
          {t.claim}
        </Button>
      )}
      {unavailable && (
        <Alert severity="warning" sx={{ mt: 2 }}>
          {t.storage}
        </Alert>
      )}
      <SignInSheet
        open={signIn}
        onClose={() => setSignIn(false)}
        onSignedIn={() => setSignIn(false)}
        title={guestCopy.title}
        body={guestCopy.claim}
      />
      <Dialog
        open={redeeming && full}
        fullScreen
        onClose={close}
        aria-labelledby="reward-redeem-title"
        sx={{
          '& .MuiDialog-paper': { borderRadius: 0, bgcolor: roles.surface, color: roles.onSurface },
        }}
      >
        <IconButton
          aria-label={common.close}
          onClick={close}
          sx={{
            alignSelf: 'flex-end',
            mr: 'max(8px, env(safe-area-inset-right))',
            mt: 'max(8px, env(safe-area-inset-top))',
          }}
        >
          <X size={24} />
        </IconButton>
        <DialogContent
          sx={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            maxWidth: 520,
            width: '100%',
            mx: 'auto',
            p: 6,
            pb: 'max(24px, env(safe-area-inset-bottom))',
            overflowWrap: 'anywhere',
          }}
        >
          <Stack spacing={5} sx={{ textAlign: 'center' }}>
            <Typography component="h1" id="reward-redeem-title" variant="headlineMedium">
              {name}
            </Typography>
            <Typography variant="headlineSmall">{reward}</Typography>
            <Typography variant="bodyLarge">{t.show}</Typography>
            {redeeming && <LiveClock timezone={timezone} />}
            <Typography variant="bodySmall" color="text.secondary">
              {signedIn ? `${t.account} ${t.accountHonesty}` : `${t.phone} ${t.honesty}`}
            </Typography>
            {failedClaim && <Alert severity="warning">{t.storage}</Alert>}
            <Button
              variant="contained"
              onClick={() => {
                if (!signedIn) {
                  if (claimReward(shop, target)) close()
                  else setFailedClaim(true)
                  return
                }
                account
                  .api<PassportView>(
                    `/api/v1/customer/passport/shops/${encodeURIComponent(shop)}/claim`,
                    { method: 'POST' },
                  )
                  .then((next) => {
                    setPassport(next)
                    close()
                  })
                  .catch(() => setFailedClaim(true))
              }}
            >
              {t.markUsed}
            </Button>
          </Stack>
        </DialogContent>
      </Dialog>
    </Box>
  )
}

function LiveClock({ timezone }: { timezone: string }) {
  const locale = useLocale()
  const t = useRewardCopy()
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  return (
    <Box>
      <Typography variant="bodySmall">{t.liveClock}</Typography>
      <Typography
        component="time"
        dateTime={now.toISOString()}
        variant="displaySmall"
        sx={{ display: 'block', fontVariantNumeric: 'tabular-nums' }}
      >
        {new Intl.DateTimeFormat(locale, {
          timeZone: timezone,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hourCycle: 'h23',
        }).format(now)}
      </Typography>
      <Typography variant="bodyLarge">
        {new Intl.DateTimeFormat(locale, { timeZone: timezone, dateStyle: 'full' }).format(now)}
      </Typography>
    </Box>
  )
}
