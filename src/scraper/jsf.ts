import { load } from "cheerio";
import { normalizeUrl } from "./utils";
import type { JsfFormState, JsfPostback } from "./types";

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let buffer = "";
  let quote: "'" | '"' | null = null;
  let depth = 0;

  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    const next = value[i + 1];

    if (quote) {
      if (ch === "\\") {
        buffer += ch;
        if (next !== undefined) {
          buffer += next;
          i += 1;
        }
      } else if (ch === quote) {
        quote = null;
        buffer += ch;
      } else {
        buffer += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      buffer += ch;
      continue;
    }

    if (ch === "{" || ch === "[" || ch === "(") {
      depth += 1;
    } else if (ch === "}" || ch === "]" || ch === ")") {
      depth = Math.max(0, depth - 1);
    }

    if (ch === "," && depth === 0) {
      parts.push(buffer.trim());
      buffer = "";
      continue;
    }

    buffer += ch;
  }

  if (buffer.trim()) {
    parts.push(buffer.trim());
  }

  return parts;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    const inner = trimmed.slice(1, -1);
    return inner.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, "\n");
  }
  return trimmed;
}

function indexOfUnquotedColon(value: string): number {
  let quote: "'" | '"' | null = null;
  let depth = 0;

  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    const next = value[i + 1];

    if (quote) {
      if (ch === "\\") {
        if (next !== undefined) {
          i += 1;
        }
        continue;
      }

      if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (ch === "{" || ch === "[" || ch === "(") {
      depth += 1;
      continue;
    }

    if (ch === "}" || ch === "]" || ch === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (ch === ":" && depth === 0) {
      return i;
    }
  }

  return -1;
}

export function parseJsfObjectLiteral(raw: string): Record<string, string> {
  const cleaned = raw.trim().replace(/^\{/, "").replace(/\}$/s, "");
  const tokens = splitTopLevel(cleaned);
  const output: Record<string, string> = {};

  for (const token of tokens) {
    if (!token.includes(":")) {
      continue;
    }
    const splitAt = indexOfUnquotedColon(token);
    if (splitAt < 0) {
      continue;
    }
    const key = unquote(token.slice(0, splitAt));
    const value = unquote(token.slice(splitAt + 1));
    if (key) {
      output[key.trim()] = value;
    }
  }

  return output;
}

export function parseJsfFromOnclickWithContext(onclick: string, formStates: JsfFormState[], baseUrl: string): JsfPostback | undefined {
  return parseJsfFromOnclick(onclick, formStates, baseUrl);
}

export function extractJsfPostbacksFromHtml(html: string, baseUrl: string, formStates: JsfFormState[]): JsfPostback[] {
  const $ = load(html);
  const postbacks: JsfPostback[] = [];
  const candidates = $("a, button, input[type='submit'], input[type='button']").toArray();

  for (const candidate of candidates) {
    const onClick = $(candidate).attr("onclick") || "";
    const post = parseJsfFromOnclick(onClick, formStates, baseUrl);
    if (post) {
      postbacks.push(post);
    }
  }

  return postbacks;
}

export function parseJsfFromOnclick(onclick: string, formStates: JsfFormState[], baseUrl: string): JsfPostback | undefined {
  if (!onclick) {
    return undefined;
  }
  const jsfMatch = onclick.match(/mojarra\.jsfcljs\((.*)\)/i);
  if (!jsfMatch || !jsfMatch[1]) {
    return undefined;
  }

  const args = splitTopLevel(jsfMatch[1]);
  if (args.length < 2) {
    return undefined;
  }

  const targetForm = args[0] || "";
  const params = parseJsfObjectLiteral(args[1]);
  let state: JsfFormState | undefined;

  const formId = targetForm.match(/getElementById\(\s*[\"']([^\"']+)[\"']\s*\)|\b(?:formId|form)\s*:\s*[\"']([^\"']+)[\"']/i);
  if (formId) {
    const candidate = formId[1] || formId[2];
    state = formStates.find((form) => form.id === candidate || (form.hiddenFields.formId || "") === candidate);
  }
  if (!state) {
    state = formStates[0];
  }

  if (!state) {
    return undefined;
  }

  return {
    method: "post",
    url: normalizeUrl(state.action, baseUrl),
    data: {
      ...state.hiddenFields,
      ...params,
    },
  };
}

export function extractJsfFormStates(html: string, baseUrl: string): JsfFormState[] {
  const $ = load(html);
  const forms = $("form").toArray();

  return forms.map((item) => {
    const form = $(item);
    const hiddenFields: Record<string, string> = {};
    form
      .find("input[type='hidden']")
      .toArray()
      .forEach((hidden) => {
        const input = $(hidden);
        const name = input.attr("name");
        if (name) {
          hiddenFields[name] = input.attr("value") || "";
        }
      });

    return {
      id: form.attr("id") || undefined,
      action: normalizeUrl(form.attr("action") || baseUrl, baseUrl),
      method: (form.attr("method") || "get").toLowerCase() === "post" ? "post" : "get",
      hiddenFields,
    };
  });
}

export function inferJsfNextAction(html: string, baseUrl: string): JsfPostback | undefined {
  const $ = load(html);
  const states = extractJsfFormStates(html, baseUrl);
  const candidates = $("a, button, input[type='submit'], input[type='button']").toArray();

  const hasNextHint = (value: string): boolean => {
    const lower = (value || "").toLowerCase();
    return lower.includes("siguiente") || lower.includes("next") || lower.includes("›") || lower.includes("»") || lower.includes(">>>");
  };

  for (const candidate of candidates) {
    const el = $(candidate);
    const label =
      ((el.attr("title") || "") + " " + (el.text() || "") + " " + (el.attr("value") || "") + " " + (el.attr("aria-label") || "")).trim();

    if (!hasNextHint(label)) {
      continue;
    }

    const onclick = el.attr("onclick") || "";
    const href = el.attr("href") || "";

    const fromJsf = parseJsfFromOnclick(onclick, states, baseUrl);
    if (fromJsf) {
      return fromJsf;
    }

    const cleanedHref = href.trim();
    if (cleanedHref && !/^javascript:/i.test(cleanedHref)) {
      return {
        method: "get",
        url: normalizeUrl(cleanedHref, baseUrl),
        source: `href:${cleanedHref}`,
      };
    }
  }

  return undefined;
}

export function findPdfPostTargets(html: string): string[] {
  const $ = load(html);
  const items = $("a, button, input[type='submit'], input[type='button']").toArray();
  const urls: string[] = [];

  items.forEach((item) => {
    const el = $(item);
    const href = el.attr("href") || "";
    const onclick = el.attr("onclick") || "";
    if (href && /\.pdf/i.test(href)) {
      urls.push(href);
    }
    const match = onclick.match(/document\.forms\[[^\]]+\]\.submit\(\)/i);
    if (match && href) {
      urls.push(href);
    }
  });

  return urls;
}
