/**
 * Mint an invite link from the server itself. `bun run invite <email> [name]`.
 *
 * This is the way in when nobody is inside yet: the first account on a fresh instance
 * has no one to invite it. Only the URL goes to stdout, so `bun run invite you@example
 * .com | pbcopy` does the obvious thing; everything else is on stderr.
 */
import { env, usingDevAuthSecret } from "../env.ts";
import { createInvite } from "../auth/invites.ts";
import { closeDb } from "../db/index.ts";

const [email, ...nameParts] = process.argv.slice(2);
const name = nameParts.join(" ").trim();

if (!email || !email.includes("@")) {
  console.error("Usage: bun run invite <email> [name]");
  process.exit(2);
}

if (usingDevAuthSecret) {
  console.error(
    "warning: AUTH_SECRET is unset, so this link is signed with the development secret.",
  );
}
if (new URL(env.AUTH_BASE_URL).hostname === "localhost") {
  console.error(
    `warning: AUTH_BASE_URL is ${env.AUTH_BASE_URL}, so this link only works on this machine.`,
  );
}

const invite = await createInvite({ email, name: name || undefined, createdBy: null });

console.error(`Invite for ${invite.email}, valid until ${invite.expiresAt}. Works once.`);
console.log(invite.url);

closeDb();
