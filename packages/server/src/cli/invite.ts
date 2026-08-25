/**
 * Mint an invite link from the server itself. `bun run invite <email> [name]`.
 *
 * This is the way in when nobody is inside yet: the first account on a fresh instance
 * has no one to invite it. Only the URL goes to stdout, so `bun run invite you@example
 * .com | pbcopy` does the obvious thing; everything else is on stderr.
 */

// Boot and migration logging goes to stdout, and stdout here is the link. The logger
// reads its level when it is first imported, so this has to happen before the modules
// that use it are loaded -- hence the dynamic imports.
process.env.LOG_LEVEL ??= "warn";

const { env, usingDevAuthSecret } = await import("../env.ts");
const { createInvite } = await import("../auth/invites.ts");
const { closeDb } = await import("../db/index.ts");
const { hasWeb } = await import("../app.ts");

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
const base = new URL(env.AUTH_BASE_URL);
if (base.hostname === "localhost") {
  console.error(
    `warning: AUTH_BASE_URL is ${env.AUTH_BASE_URL}, so this link only works on this machine.`,
  );
  // The link opens a page, and in a split-port run the pages live on Vite, not here.
  // A link on this origin then 404s until `bun run build` has run, which is a
  // confusing way to learn that.
  if (base.port === String(env.PORT) && !hasWeb) {
    console.error(
      `warning: no web build is present, so ${base.origin} cannot show the invite page. For bun run dev, set AUTH_BASE_URL=http://localhost:5173 in .env first.`,
    );
  }
}

const invite = await createInvite({ email, name: name || undefined, createdBy: null });

console.error(`Invite for ${invite.email}, valid until ${invite.expiresAt}. Works once.`);
console.log(invite.url);

closeDb();
