import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const backend = fileURLToPath(new URL('../backend/', import.meta.url))
const portable = join(homedir(), 'AppData', 'Local', 'AIBuilderCupTools', 'uv', 'uv.exe')
const uv = process.env.UV_PATH || (existsSync(portable) ? portable : 'uv')
// Browser tests set FRESH_TEST_DATA=1: every run gets an empty data dir (merchant, sessions,
// recall, photos), so reruns never inherit the shops an earlier run seeded.
const fresh = process.env.FRESH_TEST_DATA === '1'
const dataDir = fresh ? mkdtempSync(join(tmpdir(), 'chalkboard-e2e-')).replaceAll('\\', '/') : ''
const freshData = fresh
  ? {
      MERCHANT_DATABASE: `${dataDir}/merchant.sqlite3`,
      SESSION_DATABASE_URL: `sqlite+aiosqlite:///${dataDir}/sessions.sqlite3`,
      RECALL_PATH: `${dataDir}/conversation-vectors`,
      MEDIA_DIR: `${dataDir}/media`,
    }
  : {}
// The local preview and browser stories always start with the same fictional worlds.
// Run in the foreground before serving; production never runs this development launcher.
const seed = spawnSync(
  uv,
  [
    'run',
    '--locked',
    'python',
    '-m',
    'scripts.seed_tour_story',
    '--sqlite',
    freshData.MERCHANT_DATABASE || process.env.MERCHANT_DATABASE || 'data/merchant.sqlite3',
  ],
  {
    cwd: backend,
    stdio: 'inherit',
  },
)
if (seed.status !== 0) process.exit(seed.status ?? 1)
const child = spawn(uv, ['run', '--locked', 'python', 'run.py'], {
  cwd: backend,
  stdio: 'inherit',
  // Review mode deliberately overrides provider modes; no paid inference.
  env: {
    ...process.env,
    ...freshData,
    COACH_MODE: 'offline',
    AUTH_MODE: 'local',
    APP_ENV: 'local',
    V1_ENABLED: 'true',
    MERCHANT_BACKEND: 'sqlite',
    MODERATION_MODE: 'fixture',
    // Face check: the real private worker when its token is set (see deployment/FACE_WORKER.md),
    // otherwise a labelled fixture. Every local owner is a trust reviewer.
    FACE_MODE: process.env.FACE_WORKER_TOKEN ? 'worker' : 'fixture',
    TRUST_ADMINS: process.env.TRUST_ADMINS ?? '["*"]',
    RATE_LIMITS_ENABLED: 'false',
    MEDIA_BUCKET: '',
    MAPS_SERVER_KEY: '',
    MAPS_BROWSER_KEY: '',
    // Labelled sample area answers offline; MAPS_GROUNDING=off shows the honest fallback.
    MAPS_GROUNDING: process.env.MAPS_GROUNDING ?? 'demo',
    // The dev web server's own origin (per-worktree WEB_PORT, default 3200).
    // Share links and QR codes point at this checkout's own web port.
    CUSTOMER_ORIGIN: `http://127.0.0.1:${process.env.WEB_PORT ?? 3200}`,
    ALLOWED_ORIGINS: JSON.stringify([
      `http://127.0.0.1:${process.env.WEB_PORT ?? 3200}`,
      `http://localhost:${process.env.WEB_PORT ?? 3200}`,
    ]),
  },
})
child.on('error', (error) => {
  console.error(error.message)
  process.exitCode = 1
})
child.on('exit', (code) => {
  if (fresh) rmSync(dataDir, { recursive: true, force: true })
  process.exitCode = code ?? 1
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
