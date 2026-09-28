import { UserManager, WebStorageStateStore, type User as OidcUser } from 'oidc-client-ts';
import { sessionStore, type Session } from './api.ts';

// Sign-in with Keycloak: OpenID Connect, Authorization Code flow with PKCE. The password is only ever typed
// on Keycloak's page; this app receives short-lived tokens (access token: 5 min, renewed in the background
// with the refresh token). Keycloak is reached through the edge under /auth – the same origin as the app.
// `npm run dev` (Vite on :5173) uses the Keycloak of the running system instead.
const KEYCLOAK_URL = import.meta.env.DEV
  ? ((import.meta.env.VITE_KEYCLOAK_URL as string | undefined) ?? 'http://localhost:8080/auth')
  : `${window.location.origin}/auth`;

const APP_URL = `${window.location.origin}/`;

const manager = new UserManager({
  authority: `${KEYCLOAK_URL}/realms/routine`,
  client_id: 'routine-web',
  redirect_uri: APP_URL,
  post_logout_redirect_uri: APP_URL,
  response_type: 'code',
  scope: 'openid profile email',
  userStore: new WebStorageStateStore({ store: window.localStorage }),
  automaticSilentRenew: true,
});

function toSession(user: OidcUser): Session {
  const { sub, email = '', name, preferred_username } = user.profile;
  return { token: user.access_token, user: { id: sub, email, displayName: name ?? preferred_username ?? email } };
}

manager.events.addUserLoaded((user) => sessionStore.set(toSession(user))); // also after every renewal
manager.events.addUserUnloaded(() => sessionStore.set(null));
manager.events.addAccessTokenExpired(() => sessionStore.set(null)); // renewal failed (e.g. Keycloak down)

// The library renews once, a minute before expiry, and gives up on a network error. A Keycloak replica that
// is just restarting must not sign the user out: keep trying every 5 s while the token is still valid.
function retryRenewal() {
  setTimeout(async () => {
    const user = await manager.getUser();
    if (!user || user.expired) return; // too late – addAccessTokenExpired has signed out
    await manager.signinSilent().catch(retryRenewal);
  }, 5_000);
}
manager.events.addSilentRenewError(retryRenewal);

// A rejected token (401 from the API) clears the session – forget the tokens too, or a reload would restore them.
// Only on the change signed in → signed out: removeUser() itself ends in sessionStore.set(null) again.
let signedIn = false;
sessionStore.subscribe(() => {
  const now = sessionStore.get() !== null;
  if (signedIn && !now) void manager.removeUser();
  signedIn = now;
});

interface ReturnState {
  /** Hash route to open after sign-in. */
  route: string;
}

let signInError: string | undefined;

/** Why the last sign-in failed, once (shown on the landing page). */
export function takeSignInError(): string | undefined {
  const error = signInError;
  signInError = undefined;
  return error;
}

/** Runs before the first render: completes a sign-in redirect or restores the stored session. */
export async function initAuth(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  if (params.has('state') && (params.has('code') || params.has('error'))) {
    let route = '';
    try {
      const user = await manager.signinRedirectCallback();
      route = (user.state as ReturnState | undefined)?.route ?? '';
      sessionStore.set(toSession(user));
    } catch (error) {
      signInError = params.get('error_description') ?? (error instanceof Error ? error.message : String(error));
    }
    // code and state are single-use – keep them out of the address bar and the history
    window.history.replaceState(null, '', `${window.location.pathname}${route}`);
    return;
  }
  const user = await manager.getUser();
  if (user && !user.expired) {
    sessionStore.set(toSession(user));
  } else if (user?.refresh_token) {
    // the access token ran out while the tab was closed – the refresh token may still be valid
    await manager.signinSilent().catch(() => manager.removeUser());
  }
}

export interface SignInOptions {
  /** Pre-fills the e-mail on Keycloak's page. */
  loginHint?: string;
  /** Opens Keycloak's registration page instead of the sign-in page. */
  register?: boolean;
}

export function signIn({ loginHint, register }: SignInOptions = {}): Promise<void> {
  const state: ReturnState = { route: window.location.hash };
  return manager.signinRedirect({ state, login_hint: loginHint, ...(register ? { prompt: 'create' } : {}) });
}

/** Ends the Keycloak session too – otherwise "Sign in" would sign the same user in again without a password. */
export async function signOut(): Promise<void> {
  await manager.signoutRedirect().catch(() => manager.removeUser()); // Keycloak unreachable: at least forget the tokens
}
