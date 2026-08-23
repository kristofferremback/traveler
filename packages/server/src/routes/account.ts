import { Hono } from "hono";
import { InviteRequest, type InvitesResponse, type MeResponse } from "@traveler/shared";
import { auth } from "../auth/auth.ts";
import { createInvite, listInvites } from "../auth/invites.ts";
import { AppError } from "../lib/errors.ts";

export const account = new Hono();

/** Dates arrive from better-auth as Date, string or nothing depending on the driver. */
function iso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return null;
}

/**
 * Everything the settings page needs about the caller, in one request.
 *
 * The passkey and api-key lists come from Better Auth's own endpoints rather than a
 * query of our own, so a plugin that changes what it stores cannot leave this reading
 * columns that moved.
 */
account.get("/me", async (c) => {
  const user = c.get("user");
  const headers = c.req.raw.headers;

  const passkeys = await auth.api.listPasskeys({ headers }).catch(() => []);
  // listApiKeys answers with a bare array or a paginated envelope depending on the
  // query; we ask for neither page nor filter, so both shapes have to be accepted.
  const listed = await auth.api.listApiKeys({ headers }).catch(() => []);
  const apiKeys = Array.isArray(listed) ? listed : listed.apiKeys;

  const body: MeResponse = {
    user: { id: user.id, email: user.email, name: user.name },
    passkeys: passkeys.map((p) => ({
      id: p.id,
      name: p.name ?? null,
      createdAt: iso(p.createdAt),
    })),
    apiKeys: apiKeys.map((k) => ({
      id: k.id,
      name: k.name ?? null,
      start: k.start ?? null,
      createdAt: iso(k.createdAt),
      lastRequest: iso(k.lastRequest),
      expiresAt: iso(k.expiresAt),
    })),
  };
  return c.json(body);
});

/**
 * Mint an invite link.
 *
 * The link comes back in the response and goes nowhere else: no mail is sent, so passing
 * it on is the inviter's job and is deliberately visible to them.
 */
account.post("/invites", async (c) => {
  const body = InviteRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) {
    const issue = body.error.issues[0];
    throw new AppError(
      "invalid_body",
      issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Ogiltig inbjudan",
      400,
      body.error.issues,
    );
  }

  const invite = await createInvite({
    email: body.data.email,
    name: body.data.name,
    createdBy: c.get("user").id,
  });
  return c.json(invite, 201);
});

/** The caller's own unexpired invites. The link stays readable so it can be resent. */
account.get("/invites", (c) => {
  const rows = listInvites(c.get("user").id);
  const body: InvitesResponse = {
    invites: rows.map((r) => ({
      email: r.email,
      url: r.url,
      expiresAt: r.expires_at,
    })),
  };
  return c.json(body);
});
