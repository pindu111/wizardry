// free-llm.js — one function, many free AI providers, automatic fallback.
//
// Usage:
//   import { chat } from "./free-llm.js";
//   const { text, provider } = await chat("Write a 3-sentence scary story");
//
// It tries providers in order. If one is rate-limited, down, slow or
// missing a key, it moves on to the next one. Providers with no key set
// are skipped. Works in Node 18+, Vercel/Netlify functions, Cloudflare
// Workers and Deno — anywhere with `fetch`.
//
// NEVER import this into browser code: your API keys would be visible
// to anyone. Call it from a server or a serverless function (see api/check-answer.js).

const env = (name) =>
  (typeof process !== "undefined" && process.env && process.env[name]) || undefined;

// ---------------------------------------------------------------------------
// Providers (all OpenAI-compatible). Order here = default fallback order.
// Override any model with an env var, e.g. GROQ_MODEL=openai/gpt-oss-20b
// ---------------------------------------------------------------------------
export const PROVIDERS = [
  {
    name: "groq",
    baseURL: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    model: "openai/gpt-oss-120b", // very fast; 30 RPM, 1,000/day free
  },
  {
    name: "gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEnv: "GEMINI_API_KEY",
    model: "gemini-3.5-flash-lite", // free prompts may be used by Google
  },
  {
    name: "mistral",
    baseURL: "https://api.mistral.ai/v1",
    keyEnv: "MISTRAL_API_KEY",
    model: "mistral-small-latest", // free prompts may train Mistral (opt-out available)
  },
  {
    name: "nvidia",
    baseURL: "https://integrate.api.nvidia.com/v1",
    keyEnv: "NVIDIA_API_KEY",
    model: "openai/gpt-oss-20b", // 40 RPM, 10,000/day free
  },
  {
    name: "cloudflare",
    // needs CLOUDFLARE_ACCOUNT_ID as well as the token
    baseURL: () =>
      env("CLOUDFLARE_ACCOUNT_ID") &&
      `https://api.cloudflare.com/client/v4/accounts/${env("CLOUDFLARE_ACCOUNT_ID")}/ai/v1`,
    keyEnv: "CLOUDFLARE_API_TOKEN",
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  },
  {
    name: "zai",
    baseURL: "https://api.z.ai/api/paas/v4",
    keyEnv: "ZAI_API_KEY",
    model: "glm-4.7-flash", // only 1 request at a time on free
  },
  {
    name: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    model: "openrouter/free", // auto-picks a free model; 50/day total
  },
  {
    name: "cohere",
    baseURL: "https://api.cohere.ai/compatibility/v1",
    keyEnv: "COHERE_API_KEY",
    model: "command-a-03-2025", // trial key: 1,000 calls/month, NON-COMMERCIAL only
  },
  {
    name: "aion",
    baseURL: "https://api.aionlabs.ai/v1",
    keyEnv: "AION_API_KEY",
    model: "aion-labs/aion-3.0-mini", // tuned for storytelling; 20K tokens/day
  },

  // --- No key needed. Last resort. These may log your prompts, so don't
  // --- send anything private. Turn off with FREE_LLM_ALLOW_KEYLESS=false
  {
    name: "llm7",
    baseURL: "https://api.llm7.io/v1",
    keyEnv: null,
    model: "gpt-oss:20b",
    keyless: true,
  },
  {
    name: "ovh",
    baseURL: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
    keyEnv: null,
    model: "gpt-oss-120b", // 2 requests/min per IP
    keyless: true,
  },
  {
    name: "kilo",
    baseURL: "https://api.kilo.ai/api/gateway",
    keyEnv: null,
    model: "kilo-auto/free",
    keyless: true,
  },
];

// Errors worth retrying on the SAME provider (temporary problems).
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);

// Providers that just hit a rate limit are benched until this time (ms).
const cooldownUntil = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ProviderError extends Error {
  constructor(message, { status, retryable, retryAfterMs } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

function parseRetryAfter(header) {
  if (!header) return undefined;
  const secs = Number(header);
  if (!Number.isNaN(secs)) return secs * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Which providers are usable right now, in order. */
export function availableProviders(order) {
  const allowKeyless = env("FREE_LLM_ALLOW_KEYLESS") !== "false";
  let list = PROVIDERS;

  const wanted = order || env("FREE_LLM_ORDER")?.split(",").map((s) => s.trim());
  if (wanted?.length) {
    list = wanted.map((n) => PROVIDERS.find((p) => p.name === n)).filter(Boolean);
  }

  return list
    .map((p) => ({
      ...p,
      baseURL: typeof p.baseURL === "function" ? p.baseURL() : p.baseURL,
      key: p.keyEnv ? env(p.keyEnv) : null,
      model: env(`${p.name.toUpperCase()}_MODEL`) || p.model,
    }))
    .filter((p) => p.baseURL && (p.keyless ? allowKeyless : p.key))
    .filter((p) => (cooldownUntil.get(p.name) || 0) <= Date.now());
}

async function callOnce(p, messages, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const headers = { "Content-Type": "application/json" };
  if (p.key) headers.Authorization = `Bearer ${p.key}`;

  let res;
  try {
    res = await fetch(`${p.baseURL}/chat/completions`, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: p.model,
        messages,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature,
        ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      }),
    });
  } catch (err) {
    const timedOut = err.name === "AbortError";
    throw new ProviderError(timedOut ? "timed out" : `network error: ${err.message}`, {
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ProviderError(`HTTP ${res.status}: ${body.slice(0, 200)}`, {
      status: res.status,
      retryable: RETRYABLE.has(res.status),
      retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
    });
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text || !text.trim()) {
    // Reasoning models sometimes spend all tokens "thinking" and return nothing.
    throw new ProviderError("empty response", { retryable: false });
  }
  return { text: text.trim(), usage: data.usage };
}

/**
 * Ask an AI something. Tries each provider until one answers.
 *
 * @param {string | Array<{role: string, content: string}>} input
 *   A prompt string, or a full OpenAI-style messages array.
 * @param {object} [opts]
 * @param {string}   [opts.system]      System prompt (when input is a string)
 * @param {number}   [opts.maxTokens=2048]
 * @param {number}   [opts.temperature=0.8]
 * @param {boolean}  [opts.json=false]  Ask for a JSON object back
 * @param {number}   [opts.timeoutMs=30000]  Per attempt
 * @param {number}   [opts.retries=1]   Extra tries per provider on temporary errors
 * @param {string[]} [opts.order]       Provider names to use, in order
 * @returns {Promise<{text: string, provider: string, model: string, usage?: object}>}
 */
export async function chat(input, opts = {}) {
  const o = { maxTokens: 2048, temperature: 0.8, timeoutMs: 30000, retries: 1, ...opts };
  const messages =
    typeof input === "string"
      ? [...(o.system ? [{ role: "system", content: o.system }] : []), { role: "user", content: input }]
      : input;

  const providers = availableProviders(o.order);
  if (!providers.length) {
    throw new Error(
      "No AI providers available. Add at least one API key (see .env.example), " +
        "or allow keyless providers."
    );
  }

  const failures = [];
  for (const p of providers) {
    for (let attempt = 0; attempt <= o.retries; attempt++) {
      try {
        const out = await callOnce(p, messages, o);
        if (failures.length) console.warn(`[free-llm] answered by ${p.name} after: ${failures.join(" | ")}`);
        return { ...out, provider: p.name, model: p.model };
      } catch (err) {
        const reason = `${p.name}: ${err.message}`;

        // Rate limited: bench this provider and move on rather than wait long.
        if (err.status === 429) {
          cooldownUntil.set(p.name, Date.now() + Math.max(err.retryAfterMs || 0, 60_000));
          failures.push(reason);
          break;
        }
        // Bad key, bad model name, etc. — retrying won't help.
        if (!err.retryable || attempt === o.retries) {
          failures.push(reason);
          break;
        }
        // Temporary problem: back off with jitter, honour retry-after if short.
        const backoff = Math.min(err.retryAfterMs ?? 500 * 2 ** attempt, 5000);
        await sleep(backoff + Math.random() * 250);
      }
    }
  }

  throw new Error(`All AI providers failed:\n  ${failures.join("\n  ")}`);
}

/** For tests only. */
export function _resetCooldowns() {
  cooldownUntil.clear();
}
