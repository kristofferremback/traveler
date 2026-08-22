/** One-shot catalog sync. `bun run sync` -- useful before a deploy or after a wipe. */
import { syncCatalog } from "../sync/catalog.ts";
import { catalogCounts } from "../db/catalog.ts";
import { closeDb } from "../db/index.ts";

const outcomes = await syncCatalog();
const counts = catalogCounts();

console.log("\nCatalog");
console.table(outcomes);
console.log(
  `sites=${counts.sites} stop_points=${counts.stopPoints} lines=${counts.lines}`,
);
closeDb();
