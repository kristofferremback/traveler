import { expect, test } from "@playwright/test";

/**
 * The agent-facing contract, fetched the way an agent fetches it: no cookie, no key.
 *
 * Deliberately its own file, because every test in the smoke suite signs in first and
 * "answers without a session" is the point of this one.
 */
test.describe("the OpenAPI document", () => {
  test("is public, and describes the API an agent would call", async ({ request }) => {
    const res = await request.get("/api/openapi.json");
    expect(res.status()).toBe(200);
    expect(res.headers()["cache-control"]).toBe("public, max-age=3600");

    const doc = (await res.json()) as {
      openapi: string;
      servers: Array<{ url: string }>;
      paths: Record<string, Record<string, { parameters?: Array<{ name: string; in: string }> }>>;
      components: { securitySchemes: Record<string, { type: string; in: string; name: string }> };
    };

    expect(doc.openapi.startsWith("3.1")).toBe(true);
    expect(doc.servers[0]?.url).toBe("http://localhost:3111");

    // The route an agent reaches for, with the two parameters it cannot work without.
    const commute = doc.paths["/api/commute"]?.get;
    expect(commute).toBeTruthy();
    const query = (commute?.parameters ?? [])
      .filter((p) => p.in === "query")
      .map((p) => p.name);
    expect(query).toContain("from");
    expect(query).toContain("to");

    expect(doc.components.securitySchemes.apiKey).toMatchObject({
      type: "apiKey",
      in: "header",
      name: "x-api-key",
    });
  });
});
