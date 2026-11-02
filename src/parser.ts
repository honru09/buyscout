// Mission parser: turns plain-language shopping requests into a structured
// mission. If an LLM key is configured (LLM_API_KEY) it is tried first; any
// failure falls back to the deterministic rule-based parser below, so the
// demo never hard-depends on an external AI service.

import type { ParsedMission } from "./types.ts";

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

function parseQuantity(text: string): { quantity: number; cleaned: string } {
  let cleaned = text;
  let quantity = 1;

  const pair = cleaned.match(/\ba pair of\b/i);
  if (pair) {
    quantity = 2;
    cleaned = cleaned.replace(pair[0], " ");
  }
  const xNum = cleaned.match(/\bx\s*(\d+)\b/i) || cleaned.match(/\b(\d+)\s*x\b/i);
  if (xNum) {
    quantity = parseInt(xNum[1], 10);
    cleaned = cleaned.replace(xNum[0], " ");
  }
  const wordNum = cleaned.match(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+(?=of\b|units|pieces|pcs|copies)/i,
  );
  if (wordNum) {
    quantity = NUMBER_WORDS[wordNum[1].toLowerCase()];
    cleaned = cleaned.replace(wordNum[0], " ");
  }
  const numOf = cleaned.match(/\b(\d+)\s+of\b/i);
  if (numOf) {
    quantity = parseInt(numOf[1], 10);
    cleaned = cleaned.replace(numOf[0], " ");
  }
  return { quantity, cleaned };
}

// Finds price mentions and classifies them: "target" prices are what the
// agent aims for; "max/under/below" prices are ceilings. A single bare price
// becomes both.
function parsePrices(text: string): {
  targetPrice: number | null;
  maxPrice: number | null;
  cleaned: string;
} {
  let cleaned = text;
  let target: number | null = null;
  let max: number | null = null;

  const patterns: Array<{ re: RegExp; kind: "target" | "max" | "bare" }> = [
    { re: /\btarget(?:\s*price)?\s*(?:is|of|:)?\s*\$?\s*(\d+(?:\.\d{1,2})?)/i, kind: "target" },
    { re: /\baim(?:ing)?\s+for\s+\$?\s*(\d+(?:\.\d{1,2})?)/i, kind: "target" },
    { re: /\b(?:under|below|less than|at most|up to|max(?:imum)?|budget(?:\s+of)?|no more than)\s+\$?\s*(\d+(?:\.\d{1,2})?)/i, kind: "max" },
    { re: /\$\s*(\d+(?:\.\d{1,2})?)/, kind: "bare" },
  ];

  for (const { re, kind } of patterns) {
    const m = cleaned.match(re);
    if (m) {
      const value = parseFloat(m[1]);
      if (kind === "target" && target === null) target = value;
      if (kind === "max" && max === null) max = value;
      if (kind === "bare") {
        if (target === null) target = value;
        if (max === null) max = value;
      }
      cleaned = cleaned.replace(m[0], " ");
    }
  }
  if (target === null && max !== null) target = max;
  if (max === null && target !== null) max = target;
  return { targetPrice: target, maxPrice: max, cleaned };
}

export function parseWithRules(text: string): ParsedMission {
  const prices = parsePrices(text);
  const qty = parseQuantity(prices.cleaned);

  let query = qty.cleaned
    .replace(/^\s*(please\s+)?(buy|get|find|grab|order|purchase|watch\s+for|i\s+want|i\s+need|looking\s+for)\s+/i, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s,.:;]+|[\s,.:;]+$/g, "")
    .trim();

  if (!query) query = text.trim();
  return {
    itemQuery: query,
    keywords: tokenize(query),
    targetPrice: prices.targetPrice,
    maxPrice: prices.maxPrice,
    quantity: qty.quantity,
    currency: "USD",
    source: "rules",
  };
}

// Optional LLM parse. Uses any OpenAI-compatible chat endpoint configured via
// LLM_API_KEY / LLM_API_BASE / LLM_MODEL. Returns null on any problem so the
// caller falls back to rules.
async function parseWithLLM(text: string): Promise<ParsedMission | null> {
  const key = process.env.LLM_API_KEY;
  if (!key) return null;
  const base = process.env.LLM_API_BASE || "https://api.openai.com/v1";
  const model = process.env.LLM_MODEL || "gpt-4o-mini";
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Extract a shopping mission as JSON: {itemQuery, targetPrice, maxPrice, quantity, currency}. " +
              "targetPrice is the price to trigger a buy, maxPrice is a hard ceiling (default to targetPrice). " +
              "Use null for unknown prices. Currency is a 3-letter code, default USD.",
          },
          { role: "user", content: text },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content) as Partial<ParsedMission>;
    if (!parsed.itemQuery) return null;
    const target = typeof parsed.targetPrice === "number" ? parsed.targetPrice : null;
    const max = typeof parsed.maxPrice === "number" ? parsed.maxPrice : target;
    return {
      itemQuery: String(parsed.itemQuery),
      keywords: tokenize(String(parsed.itemQuery)),
      targetPrice: target,
      maxPrice: max,
      quantity: typeof parsed.quantity === "number" && parsed.quantity > 0 ? parsed.quantity : 1,
      currency: typeof parsed.currency === "string" ? parsed.currency : "USD",
      source: "llm",
    };
  } catch {
    return null;
  }
}

export async function parseMission(text: string): Promise<ParsedMission> {
  const llm = await parseWithLLM(text);
  if (llm) return llm;
  return parseWithRules(text);
}
