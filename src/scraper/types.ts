export type Target = "pj" | "oefa";

export interface RunConfig {
  target: Target;
  baseUrl: string;
  outDir: string;
  maxPages: number;
  maxDocs: number;
  downloadPdfs: boolean;
  delayMs: number;
  pdfConcurrency: number;
  timeoutMs: number;
  verbose: boolean;
}

export interface ScrapedRecord {
  source: Target;
  page: number;
  index: number;
  title: string;
  summary: string;
  url?: string;
  date?: string;
  formAction?: string;
  pdfUrl?: string;
  pdfPath?: string;
  rawHtml?: string;
  scrapedAt: string;
}

export interface ScrapeFailure {
  source: Target;
  page: number;
  at: string;
  url?: string;
  reason: string;
  status?: number;
  details?: string;
}

export interface ScrapeSummary {
  source: Target;
  requestedPages: number;
  pagesScraped: number;
  docsFound: number;
  pdfsDownloaded: number;
  downloadPdfs: boolean;
  jsonlPath: string;
  failuresPath: string;
  pdfDir?: string;
}

export interface JsfFormState {
  id?: string;
  action: string;
  method: "get" | "post";
  hiddenFields: Record<string, string>;
}

export interface JsfPostback {
  method: "get" | "post";
  url: string;
  data?: Record<string, string>;
  source?: string;
}
