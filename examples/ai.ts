// An example wiring. Copy this into your Worker and replace the operations and prices.
//
// Prices were read from the provider pages on the dates shown. They WILL drift: re-check
// before trusting a projection, and bump PRICE_VERSION when you change one (the checksum test
// will remind you).

import {
  computePriceChecksum, createMeter, readSpendState, type PriceTable, type SpendPolicy,
} from "../src";

const CF = "https://developers.cloudflare.com/workers-ai/platform/pricing/";
const GOOGLE = "https://ai.google.dev/gemini-api/docs/pricing";

export const LLAMA_70B = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const MISTRAL_SMALL = "@cf/mistralai/mistral-small-3.1-24b-instruct";
// The turbo variant takes audio as a base64 STRING; plain @cf/openai/whisper takes number[].
// Each hard-rejects the other's shape (AiError 5006). Base64 also avoids an ~8x number[]
// blow-up that can OOM a 128 MiB isolate on longer clips.
export const WHISPER_TURBO = "@cf/openai/whisper-large-v3-turbo";
export const MELOTTS = "@cf/myshell-ai/melotts";
// NOT an @cf/ id: reached through the AI Gateway provider path (meter.runGateway).
export const GEMINI_FLASH_LITE = "gemini-2.5-flash-lite";

export const PRICE_VERSION = "2026-09-05";

export const PRICES: PriceTable = {
  [LLAMA_70B]: {
    id: LLAMA_70B, provider: "workers-ai", unit: "per_mtok",
    inPerMTok: 293_000, outPerMTok: 2_253_000,
    neurons: "26668 in / 204805 out per MTok", sourcedAt: "2026-08-27", sourceUrl: CF,
  },
  [MISTRAL_SMALL]: {
    id: MISTRAL_SMALL, provider: "workers-ai", unit: "per_mtok",
    inPerMTok: 351_000, outPerMTok: 555_000,
    neurons: "31876 in / 50488 out per MTok", sourcedAt: "2026-08-27", sourceUrl: CF,
  },
  [WHISPER_TURBO]: {
    id: WHISPER_TURBO, provider: "workers-ai", unit: "per_audio_minute",
    perMinute: 500, neurons: "46.63 per audio minute", sourcedAt: "2026-09-05", sourceUrl: CF,
  },
  [MELOTTS]: {
    id: MELOTTS, provider: "workers-ai", unit: "per_audio_minute",
    perMinute: 200, neurons: "18.63 per audio minute", sourcedAt: "2026-08-27", sourceUrl: CF,
  },
  [GEMINI_FLASH_LITE]: {
    id: GEMINI_FLASH_LITE, provider: "google-ai-studio", unit: "per_mtok",
    inPerMTok: 100_000, outPerMTok: 400_000, sourcedAt: "2026-09-05", sourceUrl: GOOGLE,
  },
};

/** Pinned in test/example.test.ts. Change a price → this changes → bump PRICE_VERSION. */
export const PRICE_TABLE_CHECKSUM = computePriceChecksum(PRICES);

export const OPERATIONS = [
  "doc.extract",     // the core call: the product doesn't work without it
  "doc.ocr_page",    // fallback for scanned documents
  "doc.summarize",
  "doc.tags",        // cosmetic
  "audio.transcribe",
  "audio.speak",
] as const;
export type Operation = (typeof OPERATIONS)[number];

export const meter = createMeter<Operation>({
  prices: PRICES,
  priceVersion: PRICE_VERSION,
  operationModel: {
    "doc.extract": GEMINI_FLASH_LITE,
    "doc.ocr_page": MISTRAL_SMALL,
    "doc.summarize": LLAMA_70B,
    "doc.tags": LLAMA_70B,
    "audio.transcribe": WHISPER_TURBO,
    "audio.speak": MELOTTS,
  },
});

export const SPEND_POLICY: SpendPolicy<Operation> = {
  softCapMicros: 25_000_000,   // $25/month: alert once
  hardCapMicros: 100_000_000,  // $100/month: start shedding
  stepMicros: 50_000_000,      // each further $50 sheds the next operation
  // Least load-bearing first. "doc.extract" is deliberately absent: shedding the core call
  // doesn't save money, it breaks the product.
  degradationOrder: ["doc.tags", "doc.ocr_page", "doc.summarize"],
};

// In a request handler:
//
//   const { shed } = await readSpendState(env.DB, SPEND_POLICY, Math.floor(Date.now() / 1000), {
//     logger, onSoftCap: (micros) => postToSlack(`AI spend passed $25 (now $${micros / 1e6})`),
//   });
//   const summary = await meter.run(
//     { ai: env.AI, db: env.DB, waitUntil: ctx.waitUntil.bind(ctx), logger, shed, gatewayId: env.AI_GATEWAY_ID },
//     { operation: "doc.summarize", subjectId: workspaceId, attempt: 1 },
//     { messages },
//   );
export { readSpendState };
