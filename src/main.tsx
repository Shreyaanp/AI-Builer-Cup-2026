import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/google-sans-flex'
// Handwritten chalk accents (headings, prices, notes; never body text).
import '@fontsource/caveat/600.css'
import '@fontsource/caveat/700.css'
import '@fontsource-variable/roboto'
import Root from './app/Root'
import { AppProviders } from './app/AppProviders'
import { setupPwa } from './app/pwa'
import { backTarget, canonicalCustomerPath, resolveApp } from './app/router'
import { installHistory, replaceEntry, seedBackTarget } from './app/history'

const app = resolveApp(new URL(location.href))
const fresh = installHistory()
if (app === 'customer') {
  const path = canonicalCustomerPath(location.pathname)
  if (path !== location.pathname) replaceEntry(path + location.search + location.hash)
}
if (fresh) seedBackTarget(backTarget(new URL(location.href), app))
setupPwa(app)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProviders business={app === 'business'}>
      <Root />
    </AppProviders>
  </StrictMode>,
)
