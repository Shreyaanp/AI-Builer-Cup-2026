import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Auth } from 'firebase/auth'
import { IdentityContext } from './context'
import { SignInOverlay } from './SignInOverlay'
import type { Identity } from './context'
import { hiddenFeatures, readFeatures } from './features'
import { upgradeGoogle } from './upgradeGoogle'

type Operations = { auth: Auth; signIn: () => Promise<void>; signOut: () => Promise<void> }

export function IdentityProvider({ children }: { children: ReactNode }) {
  const [features, setFeatures] = useState(hiddenFeatures)
  const [state, setState] = useState<
    Pick<Identity, 'mode' | 'status' | 'scope' | 'error' | 'name'>
  >({
    mode: 'local',
    status: 'loading',
    scope: 'loading',
    error: '',
  })
  const operations = useRef<Operations | null>(null)
  // Google's window is open (waiting) or closed with an account still loading (finishing).
  const [signing, setSigning] = useState<'idle' | 'waiting' | 'finishing'>('idle')
  useEffect(() => {
    const controller = new AbortController()
    let unsubscribe: (() => void) | undefined
    async function connect() {
      try {
        const response = await fetch('/api/v1/bootstrap', {
          signal: controller.signal,
          credentials: 'same-origin',
        })
        if (!response.ok) throw new Error('Session setup failed.')
        const value: unknown = await response.json()
        if (!value || typeof value !== 'object' || !('auth_mode' in value))
          throw new Error('Invalid identity configuration.')
        if (controller.signal.aborted) return
        setFeatures(readFeatures('features' in value ? value.features : undefined))
        if (value.auth_mode === 'local') {
          setState({ mode: 'local', status: 'ready', scope: 'local-preview', error: '' })
          return
        }
        if (
          value.auth_mode !== 'firebase' ||
          !('firebase' in value) ||
          !value.firebase ||
          typeof value.firebase !== 'object'
        ) {
          throw new Error('Invalid identity configuration.')
        }
        const fields = value.firebase as Record<string, unknown>
        const configuration: Record<string, string> = {}
        for (const name of ['apiKey', 'appId', 'authDomain', 'projectId']) {
          if (typeof fields[name] !== 'string' || !fields[name])
            throw new Error('Sign-in is not configured yet.')
          configuration[name] = fields[name]
        }
        const [appSdk, authSdk] = await Promise.all([
          import('firebase/app'),
          import('firebase/auth'),
        ])
        if (controller.signal.aborted) return
        const name = `ogoogle-web-${configuration.projectId}`
        const app =
          appSdk.getApps().find((candidate) => candidate.name === name) ??
          appSdk.initializeApp(configuration, name)
        const auth = authSdk.getAuth(app)
        operations.current = {
          auth,
          signIn: async () => {
            await upgradeGoogle(auth)
          },
          signOut: () => authSdk.signOut(auth),
        }
        unsubscribe = authSdk.onIdTokenChanged(
          auth,
          (user) => {
            const signedIn = !!user && !user.isAnonymous
            if (!controller.signal.aborted)
              setState({
                mode: 'firebase',
                status: signedIn ? 'ready' : 'signed-out',
                scope: signedIn ? `firebase:${user.uid}` : 'signed-out',
                name: signedIn ? (user.displayName?.trim().split(/\s+/)[0] ?? '') : '',
                error: '',
              })
          },
          () => {
            if (!controller.signal.aborted)
              setState({
                mode: 'firebase',
                status: 'error',
                scope: 'signed-out',
                error: 'Sign-in could not be restored.',
              })
          },
        )
      } catch {
        if (!controller.signal.aborted)
          setState({
            mode: 'firebase',
            status: 'error',
            scope: 'signed-out',
            error: 'Sign-in setup is unavailable. Your inputs stay on this device.',
          })
      }
    }
    void connect()
    return () => {
      controller.abort()
      unsubscribe?.()
      operations.current = null
    }
  }, [])

  async function signIn() {
    if (!operations.current || signing !== 'idle') return
    setState((current) => ({ ...current, error: '' }))
    setSigning('waiting')
    try {
      await operations.current.signIn()
      // The account arrives through onIdTokenChanged; keep the board up until it does, with a
      // safety timeout so a slow token refresh never traps the screen.
      setSigning('finishing')
      setTimeout(() => setSigning('idle'), 8000)
    } catch (error) {
      setSigning('idle')
      const code = (error as { code?: string } | null)?.code ?? ''
      // Closing Google's window is a choice, not an error.
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return
      setState((current) => ({
        ...current,
        error:
          code === 'auth/popup-blocked'
            ? 'Your browser blocked the Google window. Allow pop-ups for this site, then try again.'
            : code === 'auth/network-request-failed'
              ? 'No connection to Google. Check your internet and try again.'
              : 'Sign-in did not finish. Please try again.',
      }))
    }
  }
  async function signOut() {
    try {
      await operations.current?.signOut()
    } catch {
      setState((current) => ({ ...current, error: 'Sign-out did not finish. Please try again.' }))
    }
  }
  // Token refreshes for the same account must not recreate API clients and abort conversations.
  const getToken = useCallback(async (): Promise<string | null> => {
    if (state.mode === 'local' && state.status === 'ready') return null
    const user = operations.current?.auth.currentUser
    if (!user || user.isAnonymous)
      throw new Error('Sign in with Google to use your private conversations.')
    return user.getIdToken()
  }, [state.mode, state.status])
  return (
    <IdentityContext value={{ ...state, features, getToken, signIn, signOut }}>
      {children}
      {(signing === 'waiting' || (signing === 'finishing' && state.status !== 'ready')) && (
        <SignInOverlay phase={signing} />
      )}
    </IdentityContext>
  )
}
