import { load } from "cheerio";
import path from "node:path";
import pLimit from "p-limit";
import { HttpClient } from "../http/httpClient";
import { parseResultRows, ParsedPage, sanitizeRecordTitle } from "./base";
import {
  extractJsfFormStates,
  findPdfPostTargets,
  inferJsfNextAction,
  parseJsfFromOnclick,
} from "./jsf";
import type { JsfPostback, RunConfig, ScrapeFailure, ScrapeSummary, ScrapedRecord } from "./types";
import { createLogger, ensureDir, normalizeUrl, sleep, writeJsonFile, writeJsonLines } from "./utils";
import { downloadPdf } from "./downloader";

function inferNextFromHints(html: string, baseUrl: string): JsfPostback | undefined {
  const $ = load(html);
  const formStates = extractJsfFormStates(html, baseUrl);

  const elements = $("a, button, input[type='submit'], input[type='button']").toArray();
  const hasNext = (value: string): boolean => {
    const n = (value || "").toLowerCase();
    return n.includes("siguiente") || n.includes("next") || n.includes("»") || n.includes("›") || n.includes("page next");
  };

  for (const element of elements) {
    const $el = $(element);
    const candidateText =
      ($el.text() || "") + " " + ($el.attr("title") || "") + " " + ($el.attr("aria-label") || "") + " " + ($el.val() || "");
    if (!hasNext(candidateText)) {
      continue;
    }

    const onclick = $el.attr("onclick") || "";
    const post = parseJsfFromOnclick(onclick, formStates, baseUrl);
    if (post) {
      return post;
    }

    const href = $el.attr("href") || "";
    if (href && !/^javascript:/i.test(href)) {
      return {
        method: "get",
        url: normalizeUrl(href, baseUrl),
        source: "link",
      };
    }
  }

  const fallback = inferJsfNextAction(html, baseUrl);
  if (fallback) {
    return fallback;
  }

  return undefined;
}

export async function runPjScraper(client: HttpClient, config: RunConfig): Promise<ScrapeSummary> {
  const logger = createLogger(config.verbose);
  const outDir = path.resolve(config.outDir, config.target);
  const pdfDir = path.resolve(outDir, "pdfs");
  const jsonlPath = path.resolve(outDir, `${config.target}-resultados.jsonl`);
  const failuresPath = path.resolve(outDir, `${config.target}-fallos.json`);

  await ensureDir(outDir);
  if (config.downloadPdfs) {
    await ensureDir(pdfDir);
  }

  const failures: ScrapeFailure[] = [];
  const records: ScrapedRecord[] = [];
  const limit = pLimit(config.pdfConcurrency);
  const downloadJobs: Promise<string | null>[] = [];

  let page = 1;
  let pagesScraped = 0;
  let pdfsDownloaded = 0;
  let shouldApplyDelay = false;

  const withDelay = async <T>(label: string, request: () => Promise<T>): Promise<T> => {
    if (shouldApplyDelay && config.delayMs > 0) {
      if (config.verbose) {
        logger.log("PJ request delay", label, `${config.delayMs}ms`);
      }
      await sleep(config.delayMs);
    }
    const value = await request();
    shouldApplyDelay = true;
    return value;
  };

  let currentAction: JsfPostback = {
    method: "get",
    url: config.baseUrl,
  };

  const visited = new Set<string>();

  while (page <= config.maxPages && records.length < config.maxDocs) {
    const actionKey = `${currentAction.method}:${currentAction.url}:${JSON.stringify(currentAction.data || {})}`;
    if (visited.has(actionKey)) {
      logger.log("Página repetida detectada, se detiene el recorrido.", actionKey);
      break;
    }
    visited.add(actionKey);

    let html: string;
    let actualUrl = currentAction.url;
    try {
      const response = await withDelay("page request", () =>
        currentAction.method === "post"
          ? client.postText(currentAction.url, currentAction.data || {}, config.timeoutMs)
          : client.getText(currentAction.url, config.timeoutMs),
      );

      if (response.status === 429) {
        logger.warn("Recibió 429 y agotó reintentos", currentAction.url);
        failures.push({
          source: config.target,
          page,
          at: new Date().toISOString(),
          url: currentAction.url,
          reason: "429 after retries",
          status: response.status,
        });
        break;
      }

      if (response.status >= 400) {
        const reason = response.status === 403
          ? "HTTP 403: bloqueo geográfico/anti-bot, probar desde VPN Perú"
          : `HTTP ${response.status}`;
        failures.push({
          source: config.target,
          page,
          at: new Date().toISOString(),
          url: currentAction.url,
          reason,
          status: response.status,
        });
        break;
      }

      html = response.data as unknown as string;
      actualUrl = response.url;
      pagesScraped += 1;
    } catch (error) {
      const axiosError = error as { message: string; response?: { status?: number; config?: { url?: string } } };
      failures.push({
        source: config.target,
        page,
        at: new Date().toISOString(),
        url: currentAction.url,
        reason: axiosError.message || "request-failed",
        status: axiosError.response?.status,
        details: JSON.stringify(axiosError.response?.config || {}),
      });
      break;
    }

    const parsed: ParsedPage = parseResultRows(html, actualUrl, logger.log);
    const jsfFormStates = extractJsfFormStates(html, actualUrl);

    parsed.records.forEach((item, idx) => {
      if (records.length >= config.maxDocs) {
        return;
      }

      const absolute = item.allLinks.map((link) => normalizeUrl(link, actualUrl)).filter(Boolean);
      const pdfLinks = item.pdfLinks.length > 0 ? item.pdfLinks : findPdfPostTargets(item.rowHtml);

      const record: ScrapedRecord = {
        source: config.target,
        page,
        index: records.length + 1,
        title: item.title,
        summary: item.summary,
        url: absolute[0],
        date: item.date,
        formAction: normalizeUrl(item.formAction || "", actualUrl) || undefined,
        pdfUrl: (pdfLinks[0] ? normalizeUrl(pdfLinks[0], actualUrl) : undefined) || undefined,
        rawHtml: item.rowHtml,
        scrapedAt: new Date().toISOString(),
      };

      records.push(record);

      if (config.downloadPdfs) {
        const uniquePdfLinks = Array.from(new Set(item.allLinks.concat(pdfLinks))).filter(Boolean);
        for (const pdfUrl of uniquePdfLinks) {
          downloadJobs.push(
            limit(async () => {
              const savedPath = await withDelay("PDF download", () =>
                downloadPdf(
                  client,
                  {
                    sourceUrl: pdfUrl,
                    title: sanitizeRecordTitle(record.title, page, records.length),
                    baseUrl: actualUrl,
                    outDir: pdfDir,
                    page,
                    index: idx,
                  },
                  config.timeoutMs,
                  config.verbose,
                ),
              );
              if (savedPath) {
                pdfsDownloaded += 1;
                record.pdfPath = path.resolve(pdfDir, path.basename(savedPath));
              }
              return savedPath;
            }),
          );
        }
      }
    });

    if (records.length >= config.maxDocs || page >= config.maxPages) {
      break;
    }

    const nextAction = inferNextFromHints(html, actualUrl) || inferJsfNextAction(html, actualUrl);
    if (!nextAction) {
      logger.log("Sin acción de siguiente página inferida en PJ.");
      break;
    }

    if (!nextAction.url) {
      break;
    }

    if (!jsfFormStates.length && nextAction.method === "post") {
      logger.warn("No se detectaron estados JSF, intentando continuar como GET.");
      currentAction = { method: "get", url: nextAction.url };
    } else {
      currentAction = nextAction;
    }

    page += 1;
  }

  await Promise.all(downloadJobs);

  await writeJsonLines(jsonlPath, records);
  await writeJsonFile(failuresPath, {
    generatedAt: new Date().toISOString(),
    source: config.target,
    totals: {
      docs: records.length,
      pages: pagesScraped,
      failings: failures.length,
    },
    failures,
  });

  return {
    source: config.target,
    requestedPages: config.maxPages,
    pagesScraped,
    docsFound: records.length,
    pdfsDownloaded,
    downloadPdfs: config.downloadPdfs,
    jsonlPath,
    failuresPath,
    pdfDir: config.downloadPdfs ? pdfDir : undefined,
  };
}
