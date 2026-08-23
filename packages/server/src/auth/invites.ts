import { db } from "../db/index.ts";
import { AppError } from "../lib/errors.ts";
import { auth } from "./auth.ts";

/** Invite links last a week. Long enough to reach someone, short enough to expire. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The link produced by the most recent `sendMagicLink` call.
 *
 * Better Auth hands the link to a "send" callback and returns nothing to the caller, so
 * this is the only place it can be read. Passing it back through a module variable is
 * safe because `createInvite` serialises the calls: no second invite starts until the
 * first has taken its link, so two people inviting at the same moment cannot swap links.
 */
let pending: { email: string; url: string } | null = null;

/** One invite at a time, so `pending` always belongs to the call that is reading it. */
let queue: Promise<unknown> = Promise.resolve();

export function recordInvite(email: string, url: string): void {
  pending = { email, url };
}

/** Read and clear the captured link. Declared return type, so the narrowing is honest. */
function takePending(): { email: string; url: string } | null {
  const link = pending;
  pending = null;
  return link;
}

export interface Invite {
  email: string;
  url: string;
  expiresAt: string;
}

/**
 * Mint an invite link for an address.
 *
 * Following it signs the person in, creating the account on first use, and lands them on
 * /welcome to add a passkey. The link works once: Better Auth deletes the verification
 * row it consumes, so a forwarded link is already spent.
 */
export async function createInvite(input: {
  email: string;
  name?: string;
  createdBy?: string | null;
}): Promise<Invite> {
  const run = queue.then(async () => {
    takePending();
    await auth.api.signInMagicLink({
      body: {
        email: input.email,
        // Better Auth needs a name for the account it may create; the address will do
        // until the person changes it.
        name: input.name?.trim() || input.email,
        callbackURL: "/welcome",
      },
      headers: new Headers(),
    });

    const link = takePending();
    if (!link) {
      throw new AppError(
        "invite_failed",
        "Kunde inte skapa inbjudan. Försök igen.",
        500,
      );
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
    db.query(
      `INSERT INTO invites (email, url, created_by, created_at, expires_at)
       VALUES ($email, $url, $createdBy, $createdAt, $expiresAt)`,
    ).run({
      email: input.email,
      url: link.url,
      createdBy: input.createdBy ?? null,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });

    return { email: input.email, url: link.url, expiresAt: expiresAt.toISOString() };
  });

  // A failed invite must not wedge the queue for every later one.
  queue = run.catch(() => undefined);
  return run;
}

export interface InviteRow {
  id: number;
  email: string;
  url: string;
  created_at: string;
  expires_at: string;
}

/** The caller's own unexpired invites, newest first. */
export function listInvites(createdBy: string): InviteRow[] {
  return db
    .query(
      `SELECT id, email, url, created_at, expires_at
         FROM invites
        WHERE created_by = $createdBy AND expires_at > $now
        ORDER BY created_at DESC
        LIMIT 50`,
    )
    .all({ createdBy, now: new Date().toISOString() }) as InviteRow[];
}
