import { createAuthClient } from "better-auth/react";
import { apiKeyClient } from "@better-auth/api-key/client";

const BASE = import.meta.env.VITE_API_BASE ?? "";

/**
 * The auth client. Sessions are cookies, so nothing here holds a token.
 *
 * The base URL is only set when the API lives on another origin. Left unset, the client
 * uses the page's own origin, which is what makes the Vite dev proxy work: the browser
 * talks to :5173 and the proxy forwards to the server, so the cookie is first-party
 * either way. (The server has to name :5173 in AUTH_TRUSTED_ORIGINS for that.)
 */
export const authClient = createAuthClient({
  ...(BASE ? { baseURL: `${BASE}/api/auth` } : {}),
  plugins: [apiKeyClient()],
});

export const { useSession, signOut } = authClient;

/** Better Auth returns errors in the payload rather than throwing. */
export function authErrorMessage(
  error: { message?: string } | null | undefined,
  fallback: string,
): string {
  return error?.message?.trim() || fallback;
}
