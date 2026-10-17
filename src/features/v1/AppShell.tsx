import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Box,
  Button,
  ButtonBase,
  Divider,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material'
import {
  Check,
  ChevronDown,
  CircleUserRound,
  Leaf,
  MessageCircle,
  Plus,
  Sparkles,
  Sprout,
  Store,
} from 'lucide-react'
import { shape, windowClass } from '../../design/theme'
import { useCopy } from './strings'
import { useTabsCopy } from './tabsCopy'
import { PARENT_TAB, useWorkspace } from './workspaceContext'
import type { Destination } from './workspaceContext'
import { CoachWorkspace, type GalleryPhoto } from './screens/CoachScreen'
import { NewShopFlow } from './NewShopFlow'
import { TourHost } from '../tour/Tour'
import { startDemoTour } from '../tour/tourActions'
import { tourCopy } from '../tour/strings'
import { useLocale } from '../../state/hooks'
import { ShopScreen } from './screens/ShopScreen'
import { ShopOverview } from './ShopTiles'
import { GoogleScreen } from './screens/GoogleScreen'
import { GrowScreen } from './screens/GrowScreen'
import { PrivacyScreen } from './screens/PrivacyScreen'
import { SubPage } from './screens/SubPage'
import { YouScreen } from './screens/YouScreen'
import { DiscardPrompt } from './DiscardPrompt'
import { useIdentity } from '../../auth/useIdentity'
import { CoachGuide } from '../owner-tools/CoachGuide'
import { PaymentsScreen } from '../owner-tools/PaymentsScreen'
import { openOwnerFeature, useOwnerFeature } from '../owner-tools/entry'
import { useToolCopy } from '../owner-tools/copy'

export function AppShell() {
  const t = useCopy()
  const tabs = useTabsCopy()
  const ws = useWorkspace()
  const feature = useOwnerFeature()
  const tools = useToolCopy()
  const { features } = useIdentity()
  // The Google guide can be switched off for a release; its sub-page then falls back to Coach.
  const destination =
    ws.destination === 'google' && !features.google_guide ? 'coach' : ws.destination
  const roles = useTheme().material
  const rail = useMediaQuery(`(min-width:${windowClass.medium}px)`)
  const keyboard = useKeyboardOpen()
  const [navHeight, navRef] = useBarHeight()
  // The new-shop flow takes the whole screen; the workspace stays mounted (hidden) behind it,
  // so the current shop's coach keeps its conversation and unsent note.
  const inFlow = ws.creatingShop || ws.newShopReady
  const [galleryPhoto, setGalleryPhoto] = useState<GalleryPhoto | null>(null)
  const showNavBar = !rail && !keyboard && !inFlow
  // Large windows: My shop tiles beside the coach (phones keep the coach to one card).
  const supporting = useMediaQuery(`(min-width:${windowClass.large}px)`)
  useEffect(() => {
    if (!feature) return
    const previousTitle = document.title
    document.title = `${feature === 'guide' ? tools.guideTitle : tools.payTitle} · Chalkboard`
    document.getElementById('main')?.focus({ preventScroll: true })
    window.scrollTo(0, 0)
    return () => {
      document.title = previousTitle
    }
  }, [feature, tools.guideTitle, tools.payTitle])
  useEffect(() => {
    document.documentElement.style.setProperty('--nav-offset', showNavBar ? '84px' : '0px')
  }, [showNavBar])
  const destinations: { id: Destination; label: string; icon: ReactNode }[] = [
    { id: 'coach', label: t.navCoach, icon: <MessageCircle size={22} /> },
    { id: 'shop', label: tabs.navShop, icon: <Store size={22} /> },
    { id: 'grow', label: tabs.navGrow, icon: <Sprout size={22} /> },
    { id: 'you', label: tabs.navYou, icon: <CircleUserRound size={22} /> },
  ]
  // A sub-page (Google, Privacy) keeps its tab selected.
  const tab = PARENT_TAB[destination] ?? destination
  // Leaving for a tab closes an open owner feature (guide, payments).
  const go = (destination: Destination) => {
    openOwnerFeature(null)
    ws.go(destination)
  }
  const screen =
    destination === 'coach'
      ? null
      : {
          shop: <ShopScreen />,
          grow: <GrowScreen />,
          you: <YouScreen />,
          google: (
            <SubPage parent="grow" label={tabs.navGrow}>
              <GoogleScreen />
            </SubPage>
          ),
          privacy: (
            <SubPage parent="you" label={tabs.navYou}>
              <PrivacyScreen />
            </SubPage>
          ),
        }[destination]

  return (
    <>
      {inFlow && <NewShopFlow setGalleryPhoto={setGalleryPhoto} />}
      <Box
        sx={{
          display: inFlow ? 'none' : 'flex',
          minHeight: '100dvh',
          height: destination === 'coach' && !feature ? '100dvh' : undefined,
          bgcolor: roles.surface,
        }}
      >
        <a href="#main" className="skip-link">
          {tabs.skipToContent}
        </a>
        {rail && (
          <Box
            component="nav"
            aria-label={tabs.mainNav}
            sx={{
              width: 96,
              flexShrink: 0,
              position: 'sticky',
              top: 0,
              height: '100dvh',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 1.5,
              pt: 'calc(16px + env(safe-area-inset-top))',
              pl: 'env(safe-area-inset-left)',
            }}
          >
            <Box aria-hidden="true" sx={{ color: roles.primary, mb: 3, mt: 1 }}>
              <Leaf size={28} />
            </Box>
            {destinations.map((item) => (
              <NavItem key={item.id} item={item} selected={tab === item.id} onSelect={go} rail />
            ))}
          </Box>
        )}
        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <TopBar />
          <TourHost />
          <Box sx={{ display: 'flex', flex: 1, minHeight: 0 }}>
            <Box
              component="main"
              id={inFlow ? undefined : 'main'}
              tabIndex={-1}
              sx={{
                flex: 1,
                minWidth: 0,
                minHeight: 0,
                px: { xs: 2, sm: 3, md: 4 },
                // Clear the fixed bar by its measured height: labels wrap and fonts differ.
                pb: rail ? 3 : `${navHeight + 16}px`,
                outline: 'none',
              }}
            >
              {/* Coach stays mounted while hidden so drafts, replies and voice survive tab
                changes; keyed by shop so each shop has its own thread. */}
              <Box hidden={destination !== 'coach' || feature !== null} sx={{ height: '100%' }}>
                <CoachWorkspace galleryPhoto={galleryPhoto} setGalleryPhoto={setGalleryPhoto} />
              </Box>
              {feature === 'guide' ? (
                <CoachGuide />
              ) : feature === 'payments' ? (
                <PaymentsScreen key={ws.activeId} />
              ) : (
                screen
              )}
            </Box>
            {supporting && destination === 'coach' && !feature && ws.active && !inFlow && (
              <Box
                component="aside"
                aria-label={tabs.navShop}
                sx={{
                  width: 400,
                  flexShrink: 0,
                  m: 4,
                  ml: 0,
                  alignSelf: 'flex-start',
                  position: 'sticky',
                  top: 80,
                  maxHeight: 'calc(100dvh - 96px)',
                  overflowY: 'auto',
                }}
              >
                <ShopOverview key={ws.active.id} narrow />
              </Box>
            )}
          </Box>
        </Box>
        {showNavBar && (
          <Box
            component="nav"
            ref={navRef}
            aria-label={tabs.mainNav}
            sx={{
              position: 'fixed',
              insetInline: 0,
              bottom: 0,
              zIndex: 10,
              display: 'grid',
              gridTemplateColumns: `repeat(${destinations.length}, 1fr)`,
              bgcolor: roles.surfaceContainer,
              pt: 1.5,
              pb: 'calc(16px + env(safe-area-inset-bottom))',
              px: 'env(safe-area-inset-left)',
            }}
          >
            {destinations.map((item) => (
              <NavItem key={item.id} item={item} selected={tab === item.id} onSelect={go} />
            ))}
          </Box>
        )}
        <DiscardPrompt />
      </Box>
    </>
  )
}

/** Height of the fixed bottom bar (safe-area padding included), kept current as it resizes. */
function useBarHeight() {
  const [height, setHeight] = useState(112)
  const [node, setNode] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (!node) return
    const measure = () => setHeight(Math.ceil(node.getBoundingClientRect().height))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [node])
  return [height, setNode] as const
}

/**
 * True while the on-screen keyboard is up, so the bottom navigation can make room for the
 * composer. Focus alone is not enough: a field keeps focus after the owner dismisses the
 * keyboard (or after "Something changed" focuses the composer), which left the navigation
 * hidden for good (B2). The page uses interactive-widget=resizes-content, so the keyboard
 * shows up as the window getting clearly shorter than its full height at the same width.
 */
function useKeyboardOpen() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let width = window.innerWidth
    let full = window.innerHeight
    const isText = (node: Element | null) =>
      node instanceof HTMLTextAreaElement ||
      (node instanceof HTMLInputElement && !['checkbox', 'radio', 'file'].includes(node.type))
    const update = () => {
      const height = window.visualViewport?.height ?? window.innerHeight
      if (window.innerWidth !== width) {
        // Rotation or a resized window: start measuring again.
        width = window.innerWidth
        full = height
      }
      full = Math.max(full, height)
      setOpen(isText(document.activeElement) && full - height > 120)
    }
    // Focus moves before the keyboard animates; resize events report the result.
    const later = () => window.setTimeout(update, 0)
    window.visualViewport?.addEventListener('resize', update)
    window.addEventListener('resize', update)
    document.addEventListener('focusin', later)
    document.addEventListener('focusout', later)
    return () => {
      window.visualViewport?.removeEventListener('resize', update)
      window.removeEventListener('resize', update)
      document.removeEventListener('focusin', later)
      document.removeEventListener('focusout', later)
    }
  }, [])
  return open
}

function NavItem({
  item,
  selected,
  onSelect,
  rail = false,
}: {
  item: { id: Destination; label: string; icon: ReactNode }
  selected: boolean
  onSelect: (id: Destination) => void
  rail?: boolean
}) {
  const roles = useTheme().material
  return (
    <ButtonBase
      aria-current={selected ? 'page' : undefined}
      data-tour={`nav-${item.id}`}
      onClick={() => onSelect(item.id)}
      sx={{
        flexDirection: 'column',
        gap: 0.5,
        minWidth: rail ? 80 : 64,
        minHeight: 56,
        borderRadius: `${shape.lg}px`,
        color: selected ? roles.onSurface : roles.onSurfaceVariant,
        '&:focus-visible': { outline: `3px solid ${roles.primary}` },
      }}
    >
      <Box
        sx={{
          width: 64,
          height: 32,
          borderRadius: `${shape.full}px`,
          display: 'grid',
          placeItems: 'center',
          bgcolor: selected ? roles.secondaryContainer : 'transparent',
          color: selected ? roles.onSecondaryContainer : 'inherit',
          transition: 'background-color 200ms ease',
        }}
      >
        {item.icon}
      </Box>
      <Typography
        variant="labelMedium"
        sx={{
          fontWeight: selected ? 700 : 500,
          lineHeight: 1.8,
          py: 0.5,
          'html[lang="ta"] &': { fontFamily: '"Noto Sans Tamil", sans-serif' },
        }}
      >
        {item.label}
      </Typography>
    </ButtonBase>
  )
}

function TopBar() {
  const t = useCopy()
  const tourText = tourCopy(useLocale())
  const ws = useWorkspace()
  const roles = useTheme().material
  const [shopMenu, setShopMenu] = useState<HTMLElement | null>(null)
  const [tourBusy, setTourBusy] = useState(false)
  const [tourFailed, setTourFailed] = useState(false)
  // Settings live on the You tab now; the top bar keeps the shop switcher, new chat and "+".
  return (
    <Box
      component="header"
      sx={{
        position: 'sticky',
        top: 0,
        zIndex: 5,
        bgcolor: roles.surface,
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        minHeight: 64,
        px: { xs: 1, sm: 2 },
        pt: 'env(safe-area-inset-top)',
      }}
    >
      <Button
        onClick={(event) => setShopMenu(event.currentTarget)}
        endIcon={<ChevronDown size={18} />}
        aria-haspopup="menu"
        aria-label={t.chooseShop + (ws.active ? `: ${ws.active.fields.name}` : '')}
        sx={{ color: roles.onSurface, minWidth: 0, maxWidth: 'min(70vw, 420px)', px: 1.5 }}
      >
        <Typography
          variant="titleLarge"
          component="span"
          sx={{ overflowWrap: 'anywhere', minWidth: 0 }}
        >
          {ws.active?.fields.name ?? t.appName}
        </Typography>
      </Button>
      <Box sx={{ flex: 1 }} />
      {ws.destination === 'coach' && (
        <Tooltip title={t.newChat}>
          <IconButton
            aria-label={t.newChat}
            aria-haspopup="dialog"
            onClick={() => ws.setCoachActions(true)}
          >
            <MessageCircle size={22} />
          </IconButton>
        </Tooltip>
      )}
      {/* "+" opens the full-screen new-shop flow (never a form dialog). */}
      <Tooltip title={t.addShop}>
        <IconButton aria-label={t.addShop} onClick={ws.startNewShop}>
          <Plus size={22} />
        </IconButton>
      </Tooltip>
      <Menu anchorEl={shopMenu} open={Boolean(shopMenu)} onClose={() => setShopMenu(null)}>
        {ws.businesses.length === 0 && (
          <MenuItem disabled>
            <ListItemText primary={t.noShop} />
          </MenuItem>
        )}
        {ws.businesses.map((shop) => (
          <MenuItem
            key={shop.id}
            selected={shop.id === ws.activeId}
            onClick={() => {
              ws.select(shop.id)
              setShopMenu(null)
            }}
          >
            <ListItemIcon>{shop.id === ws.activeId ? <Check size={18} /> : null}</ListItemIcon>
            <ListItemText primary={shop.fields.name} secondary={shop.fields.category || null} />
          </MenuItem>
        ))}
        <Divider />
        <MenuItem
          disabled={tourBusy}
          sx={{ minHeight: 48 }}
          onClick={() => {
            openOwnerFeature(null)
            void startDemoTour(ws, setTourBusy, setTourFailed).then((started) => {
              if (started) setShopMenu(null)
            })
          }}
        >
          <ListItemIcon>
            <Sparkles size={18} />
          </ListItemIcon>
          <ListItemText primary={tourBusy ? tourText.preparing : tourText.settings} />
        </MenuItem>
        {tourFailed && (
          <Typography role="alert" color="error" sx={{ px: 2, maxWidth: 280 }}>
            {tourText.failed}
          </Typography>
        )}
        <MenuItem
          onClick={() => {
            setShopMenu(null)
            ws.startNewShop()
          }}
        >
          <ListItemIcon>
            <Plus size={18} />
          </ListItemIcon>
          <ListItemText primary={t.newShop} />
        </MenuItem>
      </Menu>
    </Box>
  )
}
