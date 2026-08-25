import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { magicLink } from "better-auth/plugins";
import { apiKey } from "@better-auth/api-key";
import { env } from "../env.ts";
import { db } from "../db/index.ts";
import { isInvited, recordInvite } from "./invites.ts";

/**
 * Who is allowed to use this instance.
 *
 * An invite is the allow-list. Someone already inside, or the CLI on the server, mints
 * one for an address; from then on that address can sign in with Google, or once with
 * the invite link itself. Google sign-in for an address nobody invited is refused before
 * an account exists. No passwords, no email delivery.
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

  /**
   * An account created by an invite link and a later Google sign-in with the same
   * address are one person. Spelled out rather than left to the library's default for
   * providers it happens to trust, because a spent invite link cannot be reissued to
   * someone stuck at "this address already has an account".
   */
  account: { accountLinking: { enabled: true, trustedProviders: ["google"] } },

  socialProviders:
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
            // Google's "choose an account" screen every time, so a shared laptop does
            // not silently sign in as whoever used it last.
            prompt: "select_account",
          },
        }
      : {},

  /**
   * The gate on account creation, and so on Google sign-in: an address with no live
   * invite gets no account. Linking (above) is what lets an account created by an
   * invite link sign in with Google afterwards.
   */
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          if (!isInvited(user.email)) {
            throw new APIError("FORBIDDEN", {
              code: "NOT_INVITED",
              message: "Ingen inbjudan finns för den här adressen.",
            });
          }
        },
      },
    },
  },

  plugins: [
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
