import { CookieJar } from "tough-cookie";
import { CheerioCrawler, Configuration, type CheerioCrawlingContext } from "@crawlee/cheerio";
import type { Request, RequestOptions } from "@crawlee/core";

export interface HttpRequestOptions {
  method: "get" | "post";
  url: string;
  data?: Record<string, string>;
  headers?: Record<string, string>;
  timeoutMs?: number;
  responseType?: "arraybuffer" | "json" | "text";
}

export interface HttpResponse<T = string> {
  url: string;
  status: number;
  data: T;
  headers: Record<string, string>;
}

function isRetryableStatus(status?: number): boolean {
  return status === 429 || (status !== undefined && status >= 500 && status < 600);
}

function requestMethod(method: "get" | "post"): "GET" | "POST" {
  return method === "get" ? "GET" : "POST";
}

export class HttpClient {
  private readonly maxAttempts = 4;
  private readonly jar: CookieJar;
  private readonly userAgent: string;
  private readonly defaultTimeoutMs: number;
  private readonly runId: string;
  private readonly pending = new Map<number, {
    resolve: (response: HttpResponse<unknown>) => void;
    reject: (error: Error) => void;
  }>();
  private requestCounter = 0;

  constructor(userAgent: string, timeoutMs: number) {
    this.userAgent = userAgent;
    this.defaultTimeoutMs = timeoutMs;
    this.jar = new CookieJar();
    this.runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  private createCrawler(requestId: number): CheerioCrawler {
    const config = new Configuration({
      defaultRequestQueueId: `request-${this.runId}-${requestId}`,
      purgeOnStart: true,
      storageClientOptions: {
        localDataDirectory: `storage/request-${this.runId}-${requestId}`,
      },
    });

    return new CheerioCrawler(
      {
        maxRequestRetries: 0,
        maxConcurrency: 1,
        additionalMimeTypes: ["application/pdf", "application/octet-stream", "binary/octet-stream"],
        // avoid treating 403/429 as errors so we can handle them explicitly
        ignoreHttpErrorStatusCodes: [403, 404, 429],
        useSessionPool: false,
        preNavigationHooks: [
          (crawlingContext, gotOptions) => {
            const request = crawlingContext.request;
            const timeoutMs = request.userData?.timeoutMs;
            const userHeaders = request.headers || {};

            gotOptions.headers = {
              ...gotOptions.headers,
              accept: userHeaders.accept || userHeaders.Accept || "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "user-agent": userHeaders["user-agent"] || userHeaders["User-Agent"] || this.userAgent,
              ...userHeaders,
            };
            gotOptions.timeout = { request: timeoutMs ? Number(timeoutMs) : this.defaultTimeoutMs };
            gotOptions.cookieJar = this.jar;
          },
        ],
        requestHandler: this.handleRequest.bind(this),
        failedRequestHandler: this.handleRequestFailure.bind(this),
      },
      config,
    );
  }

  async request<T = string>(request: HttpRequestOptions): Promise<HttpResponse<T>> {
    let lastError: Error | null = null;
    const payload = request.data
      ? Object.entries(request.data)
          .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value ?? "")}`)
          .join("&")
      : undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const timeoutMs = request.timeoutMs || this.defaultTimeoutMs;
        const headers = {
          "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          ...request.headers,
        };
        const response = await this.executeOnce<T>({
          requestId: ++this.requestCounter,
          method: request.method,
          url: request.url,
          headers,
          payload,
          responseType: request.responseType,
          timeoutMs,
        });

        const status = response.status;
        const retryAfter = this.getRetryAfter(response.headers);
        if (isRetryableStatus(status) && attempt < this.maxAttempts) {
          const delayMs = this.getRetryDelay(attempt, retryAfter);
          await this.backoff(delayMs);
          continue;
        }

        return {
          url: response.url || request.url,
          status,
          data: response.data as T,
          headers: response.headers,
        };
      } catch (error) {
        const maybeError = error as Error & { code?: string; statusCode?: number; response?: { status: number } };
        lastError = maybeError;
        const status = maybeError.statusCode ?? maybeError.response?.status;

        if (
          maybeError.code === "ETIMEDOUT" ||
          maybeError.code === "ESOCKETTIMEDOUT" ||
          maybeError.code === "ECONNRESET" ||
          maybeError.code === "ENOTFOUND"
        ) {
          if (attempt >= this.maxAttempts) {
            throw maybeError;
          }
          await this.backoff(this.getRetryDelay(attempt));
          continue;
        }

        if (status && isRetryableStatus(status) && attempt < this.maxAttempts) {
          await this.backoff(this.getRetryDelay(attempt));
          continue;
        }

        throw maybeError;
      }
    }

    if (lastError) {
      throw lastError;
    }

    throw new Error("Request failed after retries");
  }

  async getText(url: string, timeoutMs: number): Promise<HttpResponse<string>> {
    return this.request<string>({ method: "get", url, timeoutMs, responseType: "text" });
  }

  async postText(url: string, data: Record<string, string>, timeoutMs: number): Promise<HttpResponse<string>> {
    return this.request<string>({
      method: "post",
      url,
      data,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      timeoutMs,
      responseType: "text",
    });
  }

  async postBuffer(url: string, data: Record<string, string>, timeoutMs: number): Promise<HttpResponse<ArrayBuffer>> {
    return this.request<ArrayBuffer>({
      method: "post",
      url,
      data,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      timeoutMs,
      responseType: "arraybuffer",
    });
  }

  async getBuffer(url: string, timeoutMs: number): Promise<HttpResponse<ArrayBuffer>> {
    return this.request<ArrayBuffer>({ method: "get", url, timeoutMs, responseType: "arraybuffer" });
  }

  private async executeOnce<T>(options: {
    requestId: number;
    method: "get" | "post";
    url: string;
    headers?: Record<string, string>;
    payload?: string;
    responseType?: "arraybuffer" | "json" | "text";
    timeoutMs: number;
  }): Promise<HttpResponse<T>> {
    const { requestId, method, url, headers, payload, responseType, timeoutMs } = options;
    const normalizedMethod = requestMethod(method);
    const uniqueKey = `${normalizedMethod} ${url}${payload ? ` ${payload}` : ""}`;

    return new Promise((resolve, reject) => {
      this.pending.set(
        requestId,
        {
          resolve: (response) => resolve(response as HttpResponse<T>),
          reject: (error) => reject(error),
        },
      );

      const request: RequestOptions = {
        url,
        method: normalizedMethod,
        headers,
        payload,
        uniqueKey,
        userData: {
          requestId,
          responseType,
          timeoutMs,
        },
      };

      const crawler = this.createCrawler(requestId);
      crawler
        .run([request])
        .then(() => {
          const result = this.pending.get(requestId);
          if (result) {
            this.pending.delete(requestId);
            reject(new Error(`No se recibió respuesta del crawler para: ${url}`));
          }
        })
        .catch((error) => {
          const entry = this.pending.get(requestId);
          if (entry) {
            this.pending.delete(requestId);
            entry.reject(error as Error);
          }
        });
    }) as Promise<HttpResponse<T>>;
  }

  private handleRequest(context: CheerioCrawlingContext): Promise<void> {
    const requestId = context.request.userData?.requestId;
    if (!requestId) {
      return Promise.resolve();
    }

    const responseType = context.request.userData?.responseType as "arraybuffer" | "json" | "text" | undefined;
    const contentTypeHeader = context.response.headers["content-type"];
    const rawResponseType =
      (typeof contentTypeHeader === "string" ? contentTypeHeader : Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : "") ||
      context.contentType.type ||
      "";

    let payload: unknown = context.body;
    if (typeof payload === "string") {
      const normalizedType = rawResponseType.toLowerCase();
      if (responseType === "arraybuffer" || /pdf|octet/i.test(normalizedType)) {
        payload = Buffer.from(payload, "binary");
      } else if (responseType === "json") {
        try {
          payload = JSON.parse(payload);
        } catch {
          payload = payload;
        }
      }
    } else if (responseType === "text" && payload instanceof ArrayBuffer) {
      payload = Buffer.from(payload).toString("utf8");
    } else if (Buffer.isBuffer(payload) && (responseType === "arraybuffer" || /pdf|octet/i.test(rawResponseType.toLowerCase()))) {
      payload = payload;
    } else if (payload && responseType === "json") {
      try {
        payload = JSON.parse(payload.toString());
      } catch {
        payload = payload;
      }
    }

    const headers = this.mapHeaders(context.response.headers);
    const resolved = this.pending.get(requestId);
    if (!resolved) {
      return Promise.resolve();
    }
    this.pending.delete(requestId);

    resolved.resolve({
      url: context.request.loadedUrl || context.request.url,
      status: context.response.statusCode || 0,
      data: payload as string | ArrayBuffer | Record<string, unknown>,
      headers,
    });

    return Promise.resolve();
  }

  private handleRequestFailure(context: { request: Request; error?: Error }): Promise<void> {
    const requestId = context.request.userData?.requestId;
    if (!requestId) {
      return Promise.resolve();
    }
    const entry = this.pending.get(requestId);
    if (entry) {
      this.pending.delete(requestId);
      entry.reject(context.error || new Error("Request failed"));
    }
    return Promise.resolve();
  }

  private async backoff(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getRetryAfter(headers: Record<string, string>): number | undefined {
    const header = headers["retry-after"] || headers["Retry-After"] || headers["Retry-after"];
    if (!header) {
      return undefined;
    }
    const seconds = Number.parseInt(header, 10);
    return Number.isFinite(seconds) ? seconds * 1000 : undefined;
  }

  private getRetryDelay(attempt: number, retryAfterMs?: number): number {
    const expo = 700 * 2 ** (attempt - 1);
    return retryAfterMs && retryAfterMs > 0 ? retryAfterMs : expo;
  }

  private mapHeaders(headers: Record<string, string | string[] | number | undefined>): Record<string, string> {
    const output: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (Array.isArray(value)) {
        output[key.toLowerCase()] = value.join(", ");
      } else if (typeof value === "string" || typeof value === "number") {
        output[key.toLowerCase()] = String(value);
      }
    }
    return output;
  }
}
