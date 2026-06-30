import { load, type CheerioAPI } from "cheerio";
import sanitizeFilename from "sanitize-filename";
import { isPdfLike, matchDate, normalizeUrl } from "./utils";

export interface ParsedRecord {
  title: string;
  summary: string;
  url?: string;
  date?: string;
  formAction?: string;
  rowHtml: string;
  allLinks: string[];
  pdfLinks: string[];
}

export interface ParsedPage {
  records: ParsedRecord[];
  nextHints: string[];
}

function bestTableRows($: CheerioAPI): unknown[] {
  const tables = $("table").toArray() as unknown[];
  let best: unknown[] = [];
  let bestScore = 0;

  for (const table of tables) {
    const rows = $(table as never).find("tr").toArray() as unknown[];
    let score = 0;
    for (const row of rows) {
      const $row = $(row as never);
      const cols = $row.find("td").length;
      const links = $row.find("a[href], a[onclick], button[onclick], input[onclick]").length;
      if (cols >= 2 && (links >= 1 || cols >= 4)) {
        score += cols + links;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = rows;
    }
  }

  if (bestScore > 0) {
    return best;
  }

  return $("main, #content, .content").find("tr").toArray() as unknown[];
}

interface MinimalCheerioRow {
  find(selector: string): {
    first: () => { text: () => string };
    text: () => string;
  };
}

function pickTitle(cells: string[], $row: MinimalCheerioRow): string {
  const anchor = $row.find("a").first().text().trim();
  return cells[0] || anchor || "Sin título";
}

function buildSummary(cells: string[]): string {
  return cells.filter(Boolean).join(" | ");
}

export function parseResultRows(
  html: string,
  baseUrl: string,
  logger: (message: string, details?: unknown) => void = () => {},
): ParsedPage {
  const $ = load(html);
  const rows = bestTableRows($);
  const records: ParsedRecord[] = [];

  for (const row of rows) {
    const $row = $(row as never);
    const cells = $row
      .find("td, th")
      .toArray()
      .map((cell) => $(cell).text().replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (cells.length === 0) {
      continue;
    }

    const links = $row
      .find("a[href], form[action], input[formaction]")
      .toArray()
      .map((element) => {
        const $el = $(element);
        return normalizeUrl($el.attr("href") || $el.attr("action") || $el.attr("formaction") || "", baseUrl);
      })
      .filter(Boolean);

    const inputLinks = $row
      .find("form").toArray()
      .map((form) => normalizeUrl($(form).attr("action") || "", baseUrl))
      .filter(Boolean);

    const onclickActions = $row
      .find("a[onclick], button[onclick], input[onclick]")
      .toArray()
      .map((element) => $(element).attr("onclick") || "")
      .filter(Boolean);

    const allLinks = [...links, ...inputLinks].filter(Boolean);
    const pdfLinks = allLinks.filter(isPdfLike);
    const title = pickTitle(cells, $row);
    const summary = buildSummary(cells);
    const date = cells.find((cell) => /\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}/.test(cell));

    records.push({
      title,
      summary,
      date: matchDate(date || "") || undefined,
      rowHtml: $row.html() || "",
      allLinks: [...allLinks, ...onclickActions],
      pdfLinks,
      formAction: $row.closest("form").attr("action") || undefined,
    });

    logger("row", { title, links: allLinks.length, pdf: pdfLinks.length });
  }

  const nextHints = $("a, button, input[type='submit'], input[type='button']")
    .toArray()
    .map((candidate) => {
      const $candidate = $(candidate);
      return (
        ($candidate.text() || "") + " " + ($candidate.attr("title") || "") + " " + ($candidate.attr("aria-label") || "")
      ).toLowerCase();
    })
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter((value) => {
      const normalized = value.toLowerCase();
      return (
        normalized.includes("siguiente") ||
        normalized.includes("next") ||
        normalized.includes("»") ||
        normalized.includes("›") ||
        normalized.includes("final")
      );
    });

  return {
    records,
    nextHints,
  };
}

export function sanitizeRecordTitle(title: string, page: number, index: number): string {
  const raw = sanitizeFilename(`${page}-${index}-${title || "documento"}`.trim());
  return (raw || `documento-${page}-${index}`).replace(/\s+/g, "-").slice(0, 80);
}
