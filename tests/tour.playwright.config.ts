import { defineConfig, devices } from '@playwright/test'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  testDir: '.',
  testMatch: 'tour-narration.spec.ts',
  workers: 1,
  timeout: 90_000,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4231',
    ...devices['Pixel 7'],
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
    launchOptions: {
      executablePath:
        process.platform === 'win32'
          ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
          : undefined,
      args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'],
    },
  },
  webServer: {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    command: 'node node_modules/vite/bin/vite.js --config tests/tour.vite.config.ts',
    url: 'http://127.0.0.1:4231',
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
