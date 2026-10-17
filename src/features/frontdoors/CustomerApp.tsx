import { lazy, Suspense, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Box, CssBaseline, Dialog, ThemeProvider, useTheme } from '@mui/material'
import { customerTheme } from '../../design/customerTheme'
import type { FoundPlace } from '../discover/PlaceSearch'
import { useFrontCopy } from './strings'
import { BrandSplash } from './Splash'
import { currentPath, subscribePath } from './navigation'
import './frontdoors.css'
import { CustomerAccountProvider, useCustomer } from '../customer/account'
import { LanguageStep } from '../language/LanguageStep'
import { useNeedsLanguage } from '../language/needsLanguage'
import { CustomerNav } from '../customer/CustomerNav'
import type { CustomerTab } from '../customer/CustomerNav'
import { CustomerTopBar } from '../customer/TopBar'
import { track } from '../../app/analytics'

const Discover = lazy(() => import('../discover/Discover'))
const AskHome = lazy(() => import('../discover/AskHome'))
const PublicShop = lazy(() => import('../public/PublicShop'))
const ChatList = lazy(() => import('../customer/Chats').then((m) => ({ default: m.ChatList })))
const ChatThread = lazy(() => import('../customer/Chats').then((m) => ({ default: m.ChatThread })))
const Saved = lazy(() => import('../customer/Saved').then((m) => ({ default: m.Saved })))
const Passport = lazy(() => import('../passport/Passport').then((m) => ({ default: m.Passport })))
const RescueScreen = lazy(() =>
  import('../rescue/RescueScreen').then((m) => ({ default: m.RescueScreen })),
)
export type CustomerLocation = { gps: [number, number] | null; place: FoundPlace | null }

export default function CustomerApp() {
  const mode = useTheme().palette.mode
  const theme = useMemo(() => customerTheme(mode), [mode])
  useEffect(() => track('customer_first_open'), [])
  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]')
    const previous = meta?.getAttribute('content')
    // The outer owner provider also updates this shared document element. Apply the
    // customer surface after its effects, including a system appearance change.
    const frame = requestAnimationFrame(() => meta?.setAttribute('content', theme.material.surface))
    return () => {
      cancelAnimationFrame(frame)
      if (previous) meta?.setAttribute('content', previous)
    }
  }, [theme])
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <CustomerAccountProvider>
        <Box data-customer>
          <CustomerPages />
        </Box>
      </CustomerAccountProvider>
    </ThemeProvider>
  )
}

function CustomerPages() {
  const path = useSyncExternalStore(subscribePath, currentPath)
  const [locationChoice, setLocationChoice] = useState<CustomerLocation | null>(null)
  const t = useFrontCopy()
  const account = useCustomer()
  const needsLanguage = useNeedsLanguage()
  // Shop IDs are server UUIDs, or the fixed `demo-…` IDs of seeded demo shops.
  const id = /^\/explore\/s\/([0-9a-f-]{36}|demo-[a-z0-9-]{1,40})\/?$/i.exec(path)?.[1]
  // Chats tab, one thread (shop ID / thread UUID), and Saved.
  const thread =
    /^\/explore\/chats\/([0-9a-f-]{36}|demo-[a-z0-9-]{1,40})\/([0-9a-f-]{36})\/?$/i.exec(path)
  const chats = /^\/explore\/chats\/?$/.test(path)
  const saved = /^\/explore\/saved\/?$/.test(path)
  const passport = /^\/explore\/passport\/?$/.test(path)
  const rescue = /^\/explore\/rescue\/?$/.test(path)
  // The full list: its own path, or any shared list link with filters (?category=, ?area=…).
  const browse =
    /^\/explore\/browse\/?$/.test(path) ||
    ['q', 'category', 'area', 'open', 'halal', 'budget', 'view'].some((key) =>
      new URLSearchParams(location.search).has(key),
    )
  useEffect(() => {
    const restore = () =>
      requestAnimationFrame(() =>
        window.scrollTo({
          top: (history.state as { scrollY?: number } | null)?.scrollY ?? 0,
          behavior: 'instant',
        }),
      )
    window.addEventListener('popstate', restore)
    return () => window.removeEventListener('popstate', restore)
  }, [])
  // Right after sign-in: one tap to confirm the language guessed from the customer's area. Over
  // the page, so a message being written when they signed in carries on afterwards.
  const area = locationChoice?.gps
    ? { lat: locationChoice.gps[0], lng: locationChoice.gps[1] }
    : locationChoice?.place
  const languageStep = account.status === 'signed-in' && needsLanguage && (
    <Dialog fullScreen open aria-labelledby="language-step-title">
      <LanguageStep place={area ?? null} inDialog />
    </Dialog>
  )
  // Top-level destinations get the navigation bar; a shop or a thread is a full-screen detail.
  const tab: CustomerTab | null = chats
    ? 'chats'
    : saved
      ? 'saved'
      : passport
        ? 'passport'
        : rescue
          ? 'rescue'
          : !id && !thread && !browse
            ? 'ask'
            : null
  return (
    <>
      <a href="#customer-content" className="skip-link">
        {t.skip}
      </a>
      {/* The Ask front door, a shop and a chat thread carry these in their own header rows. */}
      {tab !== 'ask' && !id && !thread && <CustomerTopBar back={browse && !tab} />}
      <div id="customer-content" tabIndex={-1}>
        <Suspense fallback={<BrandSplash />}>
          {thread ? (
            <ChatThread key={thread[2]} shop={thread[1]!} thread={thread[2]!} />
          ) : id ? (
            <PublicShop key={id} id={id} />
          ) : chats ? (
            <ChatList />
          ) : saved ? (
            <Saved />
          ) : passport ? (
            <Passport initialLocation={locationChoice} />
          ) : rescue ? (
            <RescueScreen />
          ) : browse ? (
            <Discover initialLocation={locationChoice} onLocationChange={setLocationChoice} />
          ) : (
            // AI-first front door (user decision, Oct 15); the full list is one tap away. Where
            // to look is asked on the page itself, never as a setup wizard before it.
            <AskHome initialLocation={locationChoice} onLocationChange={setLocationChoice} />
          )}
        </Suspense>
      </div>
      {tab && <CustomerNav active={tab} />}
      {languageStep}
    </>
  )
}
