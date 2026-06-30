import { load } from "cheerio";
import path from "node:path";
import pLimit from "p-limit";
import { HttpClient } from "../http/httpClient";
import { parseResultRows, ParsedPage, sanitizeRecordTitle } from "./base";
import type { JsfFormState, JsfPostback, RunConfig, ScrapeFailure, ScrapeSummary, ScrapedRecord } from "./types";
import { createLogger, ensureDir, normalizeUrl, sleep, writeJsonFile, writeJsonLines } from "./utils";
import { downloadPdf } from "./downloader";
import { extractJsfFormStates, extractJsfPostbacksFromHtml } from "./jsf";

const OEFA_FORM_ID = "listarDetalleInfraccionRAAForm";
const OEFA_PAGE_SIZE = 10;

function decodeCData(value: string): string {
  return value
    .replace(/^\s*<!\[CDATA\[/, "")
    .replace(/\]\]>\s*$/, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractAjaxUpdates(xmlText: string, targetIds?: string[]): Record<string, string> {
  const updates: Record<string, string> = {};
  const updateMatcher = /<update[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/update>/g;
  let match: RegExpExecArray | null = null;

  while ((match = updateMatcher.exec(xmlText))) {
    const rawId = match[1] || "";
    const rawBody = match[2] || "";
    const normalized = decodeCData(rawBody);
    if (!targetIds || targetIds.includes(rawId)) {
      updates[rawId] = normalized;
    }
  }

  return updates;
}

function findUpdate(updates: Record<string, string>, candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (updates[candidate]) {
      return updates[candidate];
    }
  }
  return undefined;
}

function findFieldInUpdates(updates: Record<string, string>, field: string): string | undefined {
  const direct = updates[`${OEFA_FORM_ID}:${field}`] || updates[field];
  if (direct) {
    return direct;
  }
  const allNames = Object.keys(updates);
  const candidate = allNames.find((name) => name.toLowerCase().includes(`viewstate`) && /javax\.faces\.ViewState/i.test(name));
  if (!candidate) {
    return undefined;
  }
  return updates[candidate];
}

function buildBlankSearchPayload(state: JsfFormState): Record<string, string> {
  return {
    ...state.hiddenFields,
    "javax.faces.partial.ajax": "true",
    "javax.faces.source": `${OEFA_FORM_ID}:btnBuscar`,
    "javax.faces.partial.execute": `${OEFA_FORM_ID}:btnBuscar ${OEFA_FORM_ID}:txtNroexp`,
    "javax.faces.partial.render": `${OEFA_FORM_ID}:pgLista ${OEFA_FORM_ID}:txtNroexp`,
    [`${OEFA_FORM_ID}:btnBuscar`]: `${OEFA_FORM_ID}:btnBuscar`,
    [`${OEFA_FORM_ID}:txtNroexp`]: "",
  };
}

function buildPaginationPayload(state: JsfFormState, firstRow: number): Record<string, string> {
  return {
    ...state.hiddenFields,
    "javax.faces.partial.ajax": "true",
    "javax.faces.source": `${OEFA_FORM_ID}:dt`,
    "javax.faces.partial.execute": `${OEFA_FORM_ID}:dt`,
    "javax.faces.partial.render": `${OEFA_FORM_ID}:pgLista ${OEFA_FORM_ID}:txtNroexp`,
    [`${OEFA_FORM_ID}:dt_pagination`]: "true",
    [`${OEFA_FORM_ID}:dt_first`]: `${firstRow}`,
    [`${OEFA_FORM_ID}:dt_rows`]: `${OEFA_PAGE_SIZE}`,
    [`${OEFA_FORM_ID}:dt_encodeFeature`]: "true",
  };
}

function applyViewStateFromUpdates(state: JsfFormState, updates: Record<string, string>): void {
  const viewState = findFieldInUpdates(updates, "javax.faces.ViewState");
  if (viewState) {
    state.hiddenFields["javax.faces.ViewState"] = viewState;
  }
  const scrollState = findFieldInUpdates(updates, "dt_scrollState");
  if (scrollState) {
    state.hiddenFields[`${OEFA_FORM_ID}:dt_scrollState`] = scrollState;
  }
}

function collectOefaPdfActions(rowHtml: string, formStates: JsfFormState[], baseUrl: string): JsfPostback | undefined {
  const $ = load(rowHtml);
  const actionCandidates = extractJsfPostbacksFromHtml($.html(), baseUrl, formStates);
  return actionCandidates.find((post) => Object.keys(post.data || {}).some((key) => key.includes("param_uuid") || key.includes("Archivo")));
}

export async function runOefaScraper(client: HttpClient, config: RunConfig): Promise<ScrapeSummary> {
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

  let searchUrl = config.baseUrl;
  let formStates: JsfFormState[] = [];
  let formState: JsfFormState | undefined;
  let currentTableHtml = "";

  try {
    const response = await client.getText(searchUrl, config.timeoutMs);
    if (response.status >= 400) {
      failures.push({
        source: config.target,
        page: 1,
        at: new Date().toISOString(),
        url: searchUrl,
        reason: `HTTP ${response.status}`,
        status: response.status,
      });
      throw new Error(`HTTP ${response.status}`);
    }
    searchUrl = response.url;
    pagesScraped += 1;
    formStates = extractJsfFormStates(response.data, searchUrl);
    formState = formStates.find((state) => state.id === OEFA_FORM_ID) || formStates[0];

    if (!formState) {
      throw new Error("No se detectó formulario JSF en OEFA");
    }

    const payload = buildBlankSearchPayload(formState);
    if (config.verbose) {
      logger.log("OEFA POST payload keys", Object.keys(payload).length);
    }
    const searchResponse = await client.postText(formState.action, payload, config.timeoutMs);
    if (config.verbose) {
      logger.log("OEFA post status", searchResponse.status, "content-type", searchResponse.headers["content-type"]);
    }
    if (searchResponse.status >= 400) {
      failures.push({
        source: config.target,
        page: 1,
        at: new Date().toISOString(),
        url: formState.action,
        reason: `HTTP ${searchResponse.status}`,
        status: searchResponse.status,
      });
      throw new Error(`HTTP ${searchResponse.status}`);
    }

    const updates = extractAjaxUpdates(searchResponse.data as unknown as string, undefined);
    if (config.verbose) {
      logger.log("Update keys (OEFA):", Object.keys(updates));
    }
    applyViewStateFromUpdates(formState, updates);
    const lista = findUpdate(updates, [`${OEFA_FORM_ID}:pgLista`, `${OEFA_FORM_ID}:dt`, `${OEFA_FORM_ID}:tb`]);
    currentTableHtml = lista || "";
    if (config.verbose) {
      logger.log("Página 1 tabla inicial longitud:", currentTableHtml.length);
    }
  } catch (error) {
    if (config.verbose) {
      logger.warn("OEFA error en inicialización", (error as Error).message || error);
    }
    if (records.length === 0) {
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
    throw error;
  }

  let noMoreRows = false;

  while (!noMoreRows && page <= config.maxPages && records.length < config.maxDocs) {
    const url = searchUrl;
    const parsed: ParsedPage = parseResultRows(currentTableHtml, url, logger.log);
    if (config.verbose) {
      logger.log("OEFA página", page, "filas", parsed.records.length, "hints", parsed.nextHints);
    }

    const parsedCount = parsed.records.length;
    if (parsedCount === 0) {
      noMoreRows = true;
      logger.log("No hay filas nuevas en OEFA");
    }

    parsed.records.forEach((item, rowIndex) => {
      if (records.length >= config.maxDocs) {
        return;
      }

      const links = item.allLinks.map((value) => normalizeUrl(value, url)).filter(Boolean);
      const pdfAction = collectOefaPdfActions(item.rowHtml, formStates, url);

      const record: ScrapedRecord = {
        source: config.target,
        page,
        index: records.length + 1,
        title: item.title,
        summary: item.summary,
        url: links[0],
        date: item.date,
        formAction: item.formAction,
        pdfUrl: pdfAction?.data ? "jsf-postback" : normalizeUrl(item.pdfLinks[0] || "", url) || undefined,
        rawHtml: item.rowHtml,
        scrapedAt: new Date().toISOString(),
      };

      records.push(record);

      if (config.downloadPdfs) {
        const candidates = pdfAction ? [pdfAction] : [];
        if (!pdfAction) {
          for (const candidate of links) {
            if (candidate.toLowerCase().includes(".pdf") || candidate.toLowerCase().includes("download")) {
              candidates.push({ method: "get", url: candidate });
            }
          }
        }

        for (const candidate of candidates) {
          downloadJobs.push(
            limit(async () => {
              const file = await downloadPdf(
                client,
                {
                  sourceUrl: candidate.url,
                  title: sanitizeRecordTitle(record.title, page, record.index + rowIndex),
                  baseUrl: url,
                  outDir: pdfDir,
                  page,
                  index: record.index + rowIndex,
                  postback: candidate.method === "post" ? candidate : undefined,
                },
                config.timeoutMs,
                config.verbose,
              );
              if (file) {
                pdfsDownloaded += 1;
                record.pdfPath = file;
              }
              return file;
            }),
          );
        }
      }
    });

    if (page >= config.maxPages || parsedCount === 0) {
      break;
    }

    if (!formState) {
      break;
    }

    try {
      const payload = buildPaginationPayload(formState, page * OEFA_PAGE_SIZE);
      const paginationResponse = await client.postText(formState.action, payload, config.timeoutMs);
      if (paginationResponse.status >= 400) {
        failures.push({
          source: config.target,
          page: page + 1,
          at: new Date().toISOString(),
          url: formState.action,
          reason: `HTTP ${paginationResponse.status}`,
          status: paginationResponse.status,
        });
        break;
      }

      const updates = extractAjaxUpdates(paginationResponse.data as unknown as string, undefined);
      applyViewStateFromUpdates(formState, updates);
      const nextHtml = findUpdate(updates, [`${OEFA_FORM_ID}:pgLista`, `${OEFA_FORM_ID}:dt`, `${OEFA_FORM_ID}:tb`]);
      if (!nextHtml) {
        noMoreRows = true;
        break;
      }
      currentTableHtml = nextHtml;
      pagesScraped += 1;
      page += 1;
      if (config.delayMs > 0) {
        await sleep(config.delayMs);
      }
    } catch (error) {
      failures.push({
        source: config.target,
        page: page + 1,
        at: new Date().toISOString(),
        url: formState?.action,
        reason: (error as Error).message || "error-paginación",
      });
      break;
    }
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
