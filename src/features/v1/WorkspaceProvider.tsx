import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, IconButton, Snackbar, useTheme } from '@mui/material'
import { X } from 'lucide-react'
import { canOfferInstall, offerInstall, rememberInstallDeclined } from '../../app/pwa'
import { useCopy } from './strings'
import type { Api, Business, Me, Product, Proposal } from './api'
import { WorkspaceContext } from './workspaceContext'
import type { Destination, Editor, NewShopPhase, Workspace } from './workspaceContext'
import { ReviewDialog } from './ReviewDialog'
import { BusinessDialog, ProductDialog } from './EditDialogs'
import { FaceDialog } from './FaceDialog'
import { customerShopLink, safeCustomerOrigin } from '../../app/router'
import { overlayHandled } from './backStack'
import { tabFromUrl } from './workspaceContext'
import { entryState, pushEntry, replaceEntry, restoreScroll } from '../../app/history'

function readSpeak() {
  try {
    // Spoken replies are on unless the owner turned them off in Settings.
    return localStorage.getItem('ogoogle.speakReplies') !== '0'
  } catch {
    return true
  }
}

export function WorkspaceProvider({
  api,
  me,
  children,
}: {
  api: Api
  me: Me
  children: ReactNode
}) {
  const t = useCopy()
  const theme = useTheme()
  const [installOffer, setInstallOffer] = useState(false)
  const [businesses, setBusinesses] = useState<Business[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  // A reload inside the flow starts it again from the welcome (drafts are never stored).
  const [creatingShop, setCreatingShop] = useState(
    location.pathname === '/new-shop' &&
      new URLSearchParams(location.search).get('step') !== 'ready',
  )
  const [newShopPhase, setNewShopPhase] = useState<NewShopPhase>('hero')
  const [shopReady, setShopReady] = useState(false)
  // Inventory is tagged with its shop so a switch never shows another shop's products.
  const [inventory, setInventory] = useState<{ bid: string | null; items: Product[] }>({
    bid: null,
    items: [],
  })
  // The tab is in the address (`/?tab=shop`), so a refresh keeps it.
  const [destination, setDestination] = useState<Destination>(() => tabFromUrl(location.search))
  const [proposal, setProposal] = useState<Proposal | null>(null)
  // Proposals confirmed in this session, so the coach can link a saved change back to the menu.
  const [savedProposals, setSavedProposals] = useState<string[]>([])
  // The route belongs to this workspace, so entering registration preserves the current
  // shop's mounted coach and unsent draft. No merchant data is written to browser storage.
  // Each phase, tab and sub-page is a history entry, so Back goes review → conversation →
  // leaves the flow, and Shop → Today, with each screen where it was.
  useLayoutEffect(() => {
    const url = new URL(location.href)
    const inFlow = creatingShop || shopReady
    url.pathname = inFlow ? '/new-shop' : '/'
    if (creatingShop) url.searchParams.set('step', newShopPhase)
    else if (shopReady) url.searchParams.set('step', 'ready')
    else url.searchParams.delete('step')
    if (inFlow || destination === 'coach') url.searchParams.delete('tab')
    else url.searchParams.set('tab', destination)
    if (url.href === location.href) return
    const newTab = !inFlow && tabFromUrl(location.search) !== destination
    if (creatingShop || newTab) {
      pushEntry(url)
      if (newTab) window.scrollTo({ top: 0, behavior: 'instant' })
    } else replaceEntry(url)
  }, [creatingShop, shopReady, newShopPhase, destination])
  useEffect(() => {
    const restore = (event: PopStateEvent) => {
      if (overlayHandled(event)) return
      const inFlow = location.pathname === '/new-shop'
      const value = new URLSearchParams(location.search).get('step')
      setCreatingShop(inFlow && value !== 'ready')
      if (value !== 'ready') setShopReady(false)
      // Forward into a review needs a fresh one: it opens the conversation instead.
      setNewShopPhase(
        value === 'manual' ? 'manual' : value === 'chat' || value === 'review' ? 'chat' : 'hero',
      )
      setDestination(tabFromUrl(location.search))
      restoreScroll(entryState().scrollY ?? 0)
    }
    window.addEventListener('popstate', restore)
    return () => window.removeEventListener('popstate', restore)
  }, [])
  const [toast, setToast] = useState('')
  const [photoPending, setPhotoPending] = useState(false)
  const consumePhotoRequest = useCallback(() => setPhotoPending(false), [])
  // A chat starter from another screen (e.g. My shop's "Customers ask" card).
  const [coachDraft, setCoachDraft] = useState<string | null>(null)
  // The draft is sent at once (e.g. "Find suppliers" on the Prep plan tile).
  const [coachDraftSend, setCoachDraftSend] = useState(false)
  const consumeCoachDraft = useCallback(() => setCoachDraft(null), [])
  const [coachActions, setCoachActions] = useState(false)
  const [faceOpen, setFaceOpen] = useState(false)
  const [editor, setEditor] = useState<Editor>({ kind: 'none' })
  const [speakReplies, setSpeak] = useState(readSpeak)
  const [customerOrigin, setCustomerOrigin] = useState<string | null>(null)
  useEffect(() => {
    const abort = new AbortController()
    void api<{ customer_origin?: string }>('/bootstrap', { signal: abort.signal })
      .then((config) => {
        if (!abort.signal.aborted) setCustomerOrigin(safeCustomerOrigin(config.customer_origin))
      })
      .catch(() => undefined)
    return () => abort.abort()
  }, [api])

  const loadProducts = useCallback(
    async (id: string | null, signal?: AbortSignal) => {
      if (!id) {
        setInventory({ bid: null, items: [] })
        return
      }
      const items = await api<Product[]>(`/businesses/${id}/inventory`, { signal })
      if (!signal?.aborted) setInventory({ bid: id, items })
    },
    [api],
  )
  const reload = useCallback(async () => {
    const items = await api<Business[]>('/businesses')
    setBusinesses(items)
    setActiveId((current) =>
      current && items.some((item) => item.id === current) ? current : (items[0]?.id ?? null),
    )
  }, [api])

  useEffect(() => {
    const abort = new AbortController()
    void api<Business[]>('/businesses', { signal: abort.signal })
      .then((items) => {
        if (abort.signal.aborted) return
        setBusinesses(items)
        setActiveId(items[0]?.id ?? null)
      })
      // A failed load must not look like an empty workspace (owners would recreate shops).
      .catch(() => {
        if (!abort.signal.aborted) setLoadError(true)
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false)
      })
    return () => abort.abort()
  }, [api])
  useEffect(() => {
    if (!activeId) return
    const abort = new AbortController()
    void api<Product[]>(`/businesses/${activeId}/inventory`, { signal: abort.signal })
      .then((items) => {
        if (!abort.signal.aborted) setInventory({ bid: activeId, items })
      })
      .catch(() => {
        if (!abort.signal.aborted) setInventory({ bid: activeId, items: [] })
      })
    return () => abort.abort()
  }, [activeId, api])

  const setAvailability = useCallback(
    async (product: Product, available: boolean) => {
      if (!activeId || !product.id) return
      // Optimistic: the switch moves at once; a failure restores the saved state.
      setInventory((current) => ({
        ...current,
        items: current.items.map((item) =>
          item.id === product.id ? { ...item, available } : item,
        ),
      }))
      try {
        await api(`/businesses/${activeId}/inventory/${product.id}/availability`, {
          method: 'POST',
          body: JSON.stringify({ available }),
        })
        await reload()
      } catch {
        setInventory((current) => ({
          ...current,
          items: current.items.map((item) =>
            item.id === product.id ? { ...item, available: !available } : item,
          ),
        }))
        setToast(t.actionFailed)
      }
    },
    [activeId, api, reload, t.actionFailed],
  )
  const confirm = useCallback(
    async (proposal: Proposal) => {
      const receipt = await api<{ business_id: string }>(`/proposals/${proposal.id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ digest: proposal.digest }),
      })
      await reload()
      await loadProducts(receipt.business_id).catch(() => undefined)
      setToast(t.saved)
    },
    [api, reload, loadProducts, t.saved],
  )
  const setShared = useCallback(
    async (shared: boolean) => {
      if (!activeId) return
      await api(`/businesses/${activeId}/share`, {
        method: 'POST',
        body: JSON.stringify({ public: shared }),
      })
      await reload()
    },
    [activeId, api, reload],
  )

  const value = useMemo<Workspace>(
    () => ({
      api,
      me,
      businesses,
      loading,
      loadError,
      retryLoad: async () => {
        setLoadError(false)
        setLoading(true)
        try {
          await reload()
        } catch {
          setLoadError(true)
        } finally {
          setLoading(false)
        }
      },
      activeId,
      active: businesses.find((item) => item.id === activeId) ?? null,
      creatingShop,
      newShopPhase,
      setNewShopPhase,
      newShopReady: shopReady,
      dismissNewShopReady: () => setShopReady(false),
      startNewShop: () => {
        setCoachActions(false)
        setShopReady(false)
        setNewShopPhase('hero')
        setCreatingShop(true)
        setDestination('coach')
      },
      cancelNewShop: () => {
        setCreatingShop(false)
        setDestination('coach')
      },
      finishNewShop: async (businessId) => {
        await reload()
        setActiveId(businessId)
        setCreatingShop(false)
        setShopReady(true)
        setDestination('coach')
        await loadProducts(businessId).catch(() => undefined)
      },
      // Products shown always belong to the active shop.
      products: inventory.bid === activeId ? inventory.items : [],
      productsLoaded: !activeId || inventory.bid === activeId,
      destination,
      speakReplies,
      setSpeakReplies: (next) => {
        setSpeak(next)
        if (!next) speechSynthesis.cancel()
        try {
          localStorage.setItem('ogoogle.speakReplies', next ? '1' : '0')
        } catch {
          /* Preference stays for this session. */
        }
      },
      go: (next) => {
        setShopReady(false)
        setDestination(next)
      },
      select: (id) => {
        setCreatingShop(false)
        setShopReady(false)
        setActiveId(id)
      },
      reload,
      setAvailability,
      setShared,
      shareUrl: activeId && customerOrigin ? customerShopLink(activeId, customerOrigin) : null,
      review: setProposal,
      savedProposals,
      confirm,
      notify: setToast,
      requestPhoto: () => {
        setDestination('coach')
        setPhotoPending(true)
      },
      photoPending,
      consumePhotoRequest,
      startCoachDraft: (text: string, options?: { send?: boolean }) => {
        setDestination('coach')
        setCoachDraftSend(Boolean(options?.send))
        setCoachDraft(text)
      },
      coachDraft,
      coachDraftSend,
      consumeCoachDraft,
      coachActions,
      setCoachActions,
      faceOpen,
      setFaceOpen,
      editor,
      openEditor: setEditor,
    }),
    [
      api,
      customerOrigin,
      me,
      businesses,
      loading,
      loadError,
      activeId,
      creatingShop,
      newShopPhase,
      shopReady,
      loadProducts,
      inventory,
      destination,
      speakReplies,
      reload,
      setAvailability,
      setShared,
      savedProposals,
      confirm,
      photoPending,
      consumePhotoRequest,
      coachDraft,
      coachDraftSend,
      consumeCoachDraft,
      coachActions,
      faceOpen,
      editor,
    ],
  )

  return (
    <WorkspaceContext value={value}>
      {children}
      <ReviewDialog
        proposal={proposal}
        onClose={() => setProposal(null)}
        onSaved={async (businessId) => {
          const isNew = !businesses.some((shop) => shop.id === businessId)
          const saved = proposal?.id
          if (saved) setSavedProposals((ids) => [...ids, saved].slice(-40))
          setProposal(null)
          await reload()
          setActiveId(businessId)
          if (isNew) setDestination('coach')
          await loadProducts(businessId).catch(() => undefined)
          // Offer installation only after useful progress, never up front.
          if (!isNew && canOfferInstall()) setInstallOffer(true)
          else setToast(t.saved)
        }}
      />
      <Snackbar
        open={installOffer}
        message={t.install}
        onClose={(_, reason) => {
          if (reason === 'clickaway') return
          setInstallOffer(false)
          rememberInstallDeclined()
        }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        sx={{ bottom: { xs: 'calc(96px + env(safe-area-inset-bottom))', sm: 24 } }}
        action={
          <>
            <Button
              color="inherit"
              onClick={() => {
                setInstallOffer(false)
                void offerInstall()
              }}
              sx={{ color: theme.material.inversePrimary }}
            >
              {t.installAction}
            </Button>
            <IconButton
              aria-label={t.close}
              color="inherit"
              onClick={() => {
                setInstallOffer(false)
                rememberInstallDeclined()
              }}
            >
              <X size={18} />
            </IconButton>
          </>
        }
      />
      <BusinessDialog />
      <ProductDialog />
      {value.active && (
        <FaceDialog
          key={faceOpen ? 'open-' + value.active.id : 'closed'}
          open={faceOpen}
          businessId={value.active.id}
          api={api}
          onClose={() => setFaceOpen(false)}
        />
      )}
      <Snackbar
        open={Boolean(toast)}
        message={toast}
        autoHideDuration={4000}
        onClose={() => setToast('')}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        sx={{ bottom: { xs: 'calc(96px + env(safe-area-inset-bottom))', sm: 24 } }}
      />
    </WorkspaceContext>
  )
}
