#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parseArguments } from "../cli";
import { HttpClient } from "../http/httpClient";
import { runOefaScraper } from "../scraper/oefa";
import type { RunConfig, ScrapedRecord, ScrapeSummary } from "../scraper/types";

async function readJsonLines(filePath: string): Promise<ScrapedRecord[]> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const documents: ScrapedRecord[] = [];
  for (const line of lines) {
    documents.push(JSON.parse(line) as ScrapedRecord);
  }
  return documents;
}

async function hasPdfMagic(pathToFile: string): Promise<boolean> {
  const head = await readFile(pathToFile, { encoding: null });
  return head.slice(0, 4).toString() === "%PDF";
}

async function validatePdf(dir: string): Promise<boolean> {
  const files = await readdir(dir, { withFileTypes: true });
  for (const file of files) {
    if (!file.isFile()) {
      continue;
    }
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      continue;
    }
    const filePath = path.join(dir, file.name);
    if (await hasPdfMagic(filePath)) {
      return true;
    }
  }
  return false;
}

async function run(): Promise<void> {
  const parsed = parseArguments(process.argv);
  const config: RunConfig = {
    ...parsed,
    target: "oefa",
    maxPages: 1,
    maxDocs: 1,
    downloadPdfs: true,
  };

  const client = new HttpClient("oefa-e2e/1.0 (Mozilla/5.0)", config.timeoutMs);
  const summary: ScrapeSummary = await runOefaScraper(client, config);

  const records = await readJsonLines(summary.jsonlPath);
  if (!records.length) {
    throw new Error("No se obtuvo ningún documento en OEFA en corrida e2e");
  }

  const first = records[0];
  if (first.source !== "oefa" || !first.summary || first.pdfUrl !== "jsf-postback") {
    throw new Error("El documento OEFA no contiene los campos mínimos esperados");
  }

  await readFile(summary.failuresPath, "utf-8").then((content) => JSON.parse(content));

  if (!summary.pdfDir) {
    throw new Error("No se definió directorio de PDFs para validación e2e");
  }
  if (summary.pdfsDownloaded < 1) {
    throw new Error("La corrida e2e no reportó PDFs descargados");
  }

  const validPdf = await validatePdf(summary.pdfDir);
  if (!validPdf) {
    throw new Error("No se encontró ningún PDF descargado con magic bytes %PDF");
  }

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        source: summary.source,
        docsFound: summary.docsFound,
        failures: summary.failuresPath,
        jsonlPath: summary.jsonlPath,
        pdfsDownloaded: summary.pdfsDownloaded,
        validatedPdf: true,
      },
      null,
      2,
    ),
  );
}

run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("OEFA e2e failed:", (error as Error).message || error);
  process.exit(1);
});
