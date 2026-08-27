import { describe, expect, test } from "bun:test";
import { entryAsset } from "../useNewVersion.ts";

/** What `vite build` emits, and what the server hands back on a `no-cache` fetch of "/". */
const built = `<!doctype html>
<html lang="sv">
  <head>
    <meta charset="UTF-8" />
    <title>Traveler</title>
    <script type="module" crossorigin src="/assets/index-DyqBXQwz.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/react-Dcqu4LRQ.js">
    <link rel="stylesheet" crossorigin href="/assets/index-KEbo_6ys.css">
  </head>
  <body><div id="root"></div></body>
</html>`;

describe("entryAsset", () => {
  test("names the fingerprinted entry bundle", () => {
    expect(entryAsset(built)).toBe("/assets/index-DyqBXQwz.js");
  });

  test("a redeploy of the same source is the same name, so nothing is prompted", () => {
    expect(entryAsset(built)).toBe(entryAsset(built));
  });

  test("the entry is the one that changed, not the chunks preloaded beside it", () => {
    expect(entryAsset(built.replace("DyqBXQwz", "aB3cD4eF"))).toBe("/assets/index-aB3cD4eF.js");
  });

  test("the dev server's shell has no fingerprint, and is not a version to compare", () => {
    const dev = `<script type="module" src="/@vite/client"></script>
      <script type="module" src="/src/main.tsx"></script>`;
    expect(entryAsset(dev)).toBeNull();
  });

  test("a sign-in redirect or an error page is not read as a new version", () => {
    expect(entryAsset("<html><body>502 Bad Gateway</body></html>")).toBeNull();
  });
});
