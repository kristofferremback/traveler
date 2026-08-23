import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { apiKey } from "@better-auth/api-key";
import { env } from "../env.ts";
import { db } from "../db/index.ts";
import { recordInvite } from "./invites.ts";

/**
 * Who is allowed to use this instance.
 *
 * There are exactly two ways in. An invite link, minted by someone already inside or by
 * the CLI on the server, signs you in once. A passkey, added after that first sign-in,
 * signs you in every time after. No passwords, no email delivery, no third party -- a
 * deployment of this size should not carry an account recovery flow it cannot test.
 *
 * The schema lives in migration 7 of db/migrations.ts rather than being applied by
 * better-auth's own migrator: this database has one migration ladder and two writers
 * racing on it is how a schema ends up half applied. `__tests__/schema.test.ts` asks
 * better-auth what it expects and fails if our SQL drifts from it.
 */
export const auth = betterAuth({
  database: db,
  baseURL: env.AUTH_BASE_URL,
  basePath: "/api/auth",
  secret: env.AUTH_SECRET,
  trustedOrigins: env.AUTH_TRUSTED_ORIGINS,

  /**
   * The magic-link plugin's public endpoint mints a link for any address that asks.
   * That is the opposite of invite-only, so the route is not served. `auth.api
   * .signInMagicLink` still works from our own code, which is what an invite is.
   */
  disabledPaths: ["/sign-in/magic-link"],

  // A month, refreshed at most once a day. This is a phone in a pocket, not a bank.
  session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },

  plugins: [
    /**
     * A passkey is bound to the relying party id, which is a hostname. Reaching the same
     * instance on a different host means a passkey that silently does not match, so this
     * is derived from AUTH_BASE_URL rather than from the request.
     */
    passkey({
      rpID: new URL(env.AUTH_BASE_URL).hostname,
      rpName: "Traveler",
      origin: env.AUTH_BASE_URL,
    }),
    /**
     * "Sending" an invite means handing the link back to whoever asked for it, to pass
     * on however they like. Nothing here talks to a mail server.
     */
    magicLink({
      expiresIn: 60 * 60 * 24 * 7,
      sendMagicLink: async ({ email, url }) => recordInvite(email, url),
    }),
    // A key is a session, so every route behind the gate accepts one without knowing.
    apiKey({
      enableSessionForAPIKeys: true,
      /**
       * The plugin's default is ten requests a day, which a single page load of the
       * settings screen would exhaust. These keys exist for agents reading departure
       * boards, so the limit is a rate rather than a quota: two a second sustained,
       * still far below anything that would trouble SL through our caches.
       */
      rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 120 },
    }),
  ],
});
