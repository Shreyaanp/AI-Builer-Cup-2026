import type { Auth } from 'firebase/auth'

/** Link first: replacing an anonymous user would strand their private activity. */
export async function upgradeGoogle(auth: Auth) {
  const sdk = await import('firebase/auth')
  const guest = auth.currentUser
  if (guest?.isAnonymous) {
    // Credential collisions are surfaced to the user with the guest still signed in.
    await sdk.linkWithPopup(guest, new sdk.GoogleAuthProvider())
    await guest.getIdToken(true)
  } else await sdk.signInWithPopup(auth, new sdk.GoogleAuthProvider())
}
