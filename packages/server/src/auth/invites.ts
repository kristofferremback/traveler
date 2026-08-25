import { db } from "../db/index.ts";
import { AppError } from "../lib/errors.ts";
import { env } from "../env.ts";
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

/**
 * Turn Better Auth's verify URL into the link people are given.
 *
 * The verify endpoint signs in whoever fetches it, and chat apps and mail clients fetch
 * links to preview them, so handing out the verify URL got invites spent before anyone
 * saw them. The link points at the /invite page instead, with the token in the fragment:
 * browsers never send a fragment to a server, so a preview fetch learns nothing, and the
 * page makes the verify request only when the person presses the button.
 */
export function inviteUrl(verifyUrl: string): string {
  const token = new URL(verifyUrl).searchParams.get("token");
  if (!token) {
    throw new AppError("invite_failed", "Kunde inte skapa inbjudan. Försök igen.", 500);
  }
  return `${env.AUTH_BASE_URL}/invite#token=${encodeURIComponent(token)}`;
}

export function recordInvite(email: string, url: string): void {
  pending = { email, url: inviteUrl(url) };
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
 * Following it signs the person in, creating the account on first use. The link works
 * once: Better Auth deletes the verification row it consumes, so a forwarded link is
 * already spent. The invite row itself outlives the link: it is what lets the same
 * address sign in with Google.
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
        // The app sends a signed-in visitor of /signin to the home screen; a spent link
        // arrives there with ?error=, which the sign-in page explains.
        callbackURL: "/signin",
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

const invitedQuery = db.query<{ n: number }, { email: string; now: string }>(
  `SELECT COUNT(*) AS n FROM invites
    WHERE lower(email) = lower($email) AND expires_at > $now`,
);

/**
 * Whether an address may get an account: someone minted it an invite in the last week.
 * Checked once, when the account is created; after that the account itself is the
 * permission. Compared case-insensitively, since Google and people differ on that.
 */
export function isInvited(email: string): boolean {
  return (invitedQuery.get({ email, now: new Date().toISOString() })?.n ?? 0) > 0;
}

export interface InviteRow {
  id: number;
  email: string;
  url: string;
  created_at: string;
  expires_at: string;
}

/** The token inside an invite link, which is also the verification row's identifier. */
export function tokenOf(url: string): string | null {
  try {
    return new URLSearchParams(new URL(url).hash.replace(/^#/, "")).get("token");
  } catch {
    return null;
  }
}

const verificationExists = db.query<{ n: number }, [string]>(
  `SELECT COUNT(*) AS n FROM verification WHERE identifier = ?1`,
);
const markUsed = db.query(`UPDATE invites SET used_at = ?1 WHERE id = ?2`);

/**
 * The caller's own invites that can still be followed, newest first.
 *
 * Better Auth consumes the verification row when a link is used and says nothing to us,
 * so "spent" is discovered here: a link whose token no longer has a row is marked used
 * and left out. Listing a link that would only answer "already used" helps nobody.
 */
export function listInvites(createdBy: string): InviteRow[] {
  const now = new Date().toISOString();
  const rows = db
    .query(
      `SELECT id, email, url, created_at, expires_at
         FROM invites
        WHERE created_by = $createdBy AND expires_at > $now AND used_at IS NULL
        ORDER BY created_at DESC
        LIMIT 50`,
    )
    .all({ createdBy, now }) as InviteRow[];

  return rows.filter((row) => {
    const token = tokenOf(row.url);
    const live = token !== null && (verificationExists.get(token)?.n ?? 0) > 0;
    if (!live) markUsed.run(now, row.id);
    return live;
  });
}
