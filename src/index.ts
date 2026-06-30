import { parseArguments } from "./cli";
import { HttpClient } from "./http/httpClient";
import type { ScrapeSummary, RunConfig } from "./scraper/types";
import { runPjScraper } from "./scraper/pj";
import { runOefaScraper } from "./scraper/oefa";

async function run(): Promise<void> {
  const config: RunConfig = parseArguments(process.argv);
  const userAgent =
    "Mozilla/5.0 (compatible; scraper-challenge/1.0; +https://example.invalid)";
  const client = new HttpClient(userAgent, config.timeoutMs);

  const summary: ScrapeSummary =
    config.target === "pj" ? await runPjScraper(client, config) : await runOefaScraper(client, config);

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));
}

run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Scraper finalizó con error:", (error as Error).message || error);
  process.exit(1);
});
