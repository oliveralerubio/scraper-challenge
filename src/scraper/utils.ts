import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import sanitizeFilename from "sanitize-filename";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeUrl(value: string, baseUrl: string): string {
  if (!value) {
    return "";
  }
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  if (/^javascript:/i.test(value)) {
    return "";
  }
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return "";
  }
}

export function parseIntEnv(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function toBoolean(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function safePdfFilename(url: string | undefined, title: string, page: number, index: number): string {
  const fallback = `document-${page}-${index}`;
  const titlePart = title ? sanitizeFilename(title) : fallback;
  const base = `${titlePart || fallback}.pdf`.replace(/\s+/g, "-").toLowerCase();
  const compact = base.slice(0, 80);
  const token = url ? Buffer.from(url).toString("base64url").slice(0, 8) : "no-url";
  return `${compact}-${token}.pdf`;
}

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export async function writeJsonLines(filePath: string, records: unknown[]): Promise<void> {
  const payload = records.map((record) => JSON.stringify(record)).join("\n");
  await writeFile(filePath, payload + (payload.length ? "\n" : ""), "utf-8");
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

export function isPdfLike(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const candidate = value.split("#")[0].toLowerCase();
  return candidate.includes(".pdf") || candidate.includes("download?file") || candidate.includes("/pdf/");
}

export function matchDate(value: string): string | undefined {
  const normalized = (value || "").replace(/\s+/g, " ").trim();
  const match = normalized.match(/\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/);
  return match ? match[0] : undefined;
}

export function createLogger(verbose: boolean) {
  return {
    log: (...parts: unknown[]) => {
      if (verbose) {
        // eslint-disable-next-line no-console
        console.log(...parts);
      }
    },
    warn: (...parts: unknown[]) => console.warn(...parts),
  };
}
