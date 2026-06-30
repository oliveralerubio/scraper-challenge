import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import type { RunConfig, Target } from "./scraper/types";
import { parseIntEnv, toBoolean } from "./scraper/utils";

const PJ_DEFAULT_URL = "https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/resultado.xhtml";
const OEFA_DEFAULT_URL = "https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml";

export function parseArguments(args: string[]): RunConfig {
  const parsed = yargs(hideBin(args))
    .option("target", {
      type: "string",
      choices: ["pj", "oefa"] as const,
      default: "pj",
      desc: "Sitio objetivo: pj u oefa",
    })
    .option("base-url", {
      type: "string",
      desc: "URL base del buscador a visitar",
    })
    .option("out-dir", {
      type: "string",
      default: "out",
      desc: "Directorio de salida",
    })
    .option("max-pages", {
      type: "number",
      default: 3,
      desc: "Máximo de páginas a recorrer",
    })
    .option("max-docs", {
      type: "number",
      default: 100,
      desc: "Máximo de documentos a guardar",
    })
    .option("download-pdfs", {
      type: "boolean",
      default: false,
      desc: "Descargar PDFs vinculados",
    })
    .option("delay-ms", {
      type: "number",
      default: 800,
      desc: "Pausa entre fases de solicitud (ms)",
    })
    .option("pdf-concurrency", {
      type: "number",
      default: 2,
      desc: "Concurrencia máxima de descargas de PDF",
    })
    .option("timeout-ms", {
      type: "number",
      default: 30000,
      desc: "Timeout para cada petición HTTP",
    })
    .option("verbose", {
      type: "boolean",
      default: false,
      desc: "Logs detallados",
    })
    .strict()
    .help()
    .parseSync();

  const target = parsed.target as Target;
  const envDefaults = {
    timeoutMs: parseIntEnv(process.env.TIMEOUT_MS, 30000),
    maxPages: parseIntEnv(process.env.MAX_PAGES, 3),
    maxDocs: parseIntEnv(process.env.MAX_DOCS, 100),
    delayMs: parseIntEnv(process.env.DELAY_MS, 800),
    pdfConcurrency: parseIntEnv(process.env.PDF_CONCURRENCY, 2),
  };

  const base =
    parsed.baseUrl ||
    (target === "pj"
      ? process.env.PJ_URL || PJ_DEFAULT_URL
      : process.env.OEFA_URL || OEFA_DEFAULT_URL);

  return {
    target,
    baseUrl: base,
    outDir: parsed.outDir || "out",
    maxPages: parsed.maxPages ?? envDefaults.maxPages,
    maxDocs: parsed.maxDocs ?? envDefaults.maxDocs,
    downloadPdfs: parsed.downloadPdfs || toBoolean(process.env.DOWNLOAD_PDFS),
    delayMs: parsed.delayMs ?? envDefaults.delayMs,
    pdfConcurrency: parsed.pdfConcurrency ?? envDefaults.pdfConcurrency,
    timeoutMs: parsed.timeoutMs ?? envDefaults.timeoutMs,
    verbose: parsed.verbose || toBoolean(process.env.VERBOSE),
  };
}
