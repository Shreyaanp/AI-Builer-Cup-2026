// Rule 7: phone layout is checked by the browser job. This guards that the check stays in place.
import { tracked, read } from './lib.mjs'

export const id = 'layout'

export function run() {
  const failures = []
  if (!/name:\s*'phone'/.test(read('playwright.config.ts')))
    failures.push('  playwright.config.ts has no "phone" project')
  const workflow = read('.github/workflows/checks.yml')
  const runsPhoneProject =
    /project:\s*\[phone(?:,|\])/.test(workflow) ||
    /project:\s*\$\{\{[^}]*fromJSON\('\["phone"/.test(workflow)
  if (!runsPhoneProject)
    failures.push(
      '  .github/workflows/checks.yml: the browser job no longer runs the phone project',
    )
  const guards = tracked('tests/*.spec.ts').filter((f) => /scrollWidth/.test(read(f)))
  if (guards.length < 3)
    failures.push(
      `  only ${guards.length} specs assert no horizontal scroll (scrollWidth); expected 3 or more`,
    )
  return {
    failures: failures.length
      ? [
          'rule layout: phone layout checks are missing. A page that scrolls sideways is broken on a phone. ' +
            'How to fix: keep the phone project in the browser job, and assert ' +
            'document.documentElement.scrollWidth <= innerWidth in a spec for every new screen.',
          ...failures,
        ]
      : [],
  }
}
