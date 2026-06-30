import { writeFile } from "node:fs/promises";
import path from "node:path";
import { HttpClient } from "../http/httpClient";
import { createLogger, isPdfLike, normalizeUrl, safePdfFilename } from "./utils";
import type { JsfPostback } from "./types";

export interface PdfDownloadTask {
  sourceUrl: string;
  title: string;
  baseUrl: string;
  outDir: string;
  page: number;
  index: number;
  postback?: JsfPostback;
}

export async function downloadPdf(client: HttpClient, task: PdfDownloadTask, timeoutMs: number, verbose: boolean): Promise<string | null> {
  const logger = createLogger(verbose);
  if (!task.postback && !isPdfLike(task.sourceUrl)) {
    return null;
  }

  const fileUrl = task.postback
    ? normalizeUrl(task.postback.url, task.baseUrl)
    : normalizeUrl(task.sourceUrl, task.baseUrl);
  if (!fileUrl) {
    return null;
  }

  const filename = safePdfFilename(fileUrl, task.title, task.page, task.index);
  const pdfPath = path.join(task.outDir, filename);

  try {
    const response = task.postback
      ? await client.postBuffer(fileUrl, task.postback.data || {}, timeoutMs)
      : await client.getBuffer(fileUrl, timeoutMs);
    const contentType = response.headers["content-type"] || "";
    const buffer = Buffer.from(response.data);
    const hasPdfMagic = buffer.slice(0, 4).toString() === "%PDF";
    if (
      !contentType.includes("pdf") &&
      !contentType.includes("octet") &&
      !fileUrl.toLowerCase().includes(".pdf") &&
      !hasPdfMagic
    ) {
      logger.log("Descarga no pdf ignorada", fileUrl, contentType);
      return null;
    }

    await writeFile(pdfPath, Buffer.from(new Uint8Array(response.data)));
    return pdfPath;
  } catch (error) {
    logger.warn("No se pudo descargar PDF", fileUrl, (error as Error).message);
    return null;
  }
}
