type PlaybookLike =
  { kind: 'ready'; view?: { grow?: string[] | null } } | { kind: 'loading' | 'failed' }

/** The playbook's suggested Grow order. Empty until it is ready, and when the server's view has
 * no `grow` list (older playbooks), so Grow keeps its usual order instead of crashing. */
export function growOrderOf(playbook: PlaybookLike): string[] {
  return playbook.kind === 'ready' && Array.isArray(playbook.view?.grow)
    ? playbook.view.grow.filter((id): id is string => typeof id === 'string')
    : []
}
