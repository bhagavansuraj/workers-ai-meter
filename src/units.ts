// Billable units from what the model ACTUALLY returned, falling back to an estimate only
// when the provider reports nothing, and labelling the row `estimated` when it does. An
// estimate is never silently indistinguishable from a measurement.

import type { ModelPrice } from "./pricing";
import { parseWavDurationSeconds } from "./wav";

export type Units = { unitsIn: number; unitsOut: number; source: "reported" | "estimated" };

/** What the caller knows about audio that the response won't tell us. */
export type AudioHints = {
  /** Known duration of the audio this call consumes (ASR). Makes the row `reported`. */
  audioSeconds?: number;
  /** Byte length of the audio when the duration is NOT known. Yields an `estimated` row. */
  audioBytes?: number;
};

/** ~4 characters per token. Only ever used when the provider reports no usage. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** ~14 characters of prose per second of synthesized speech. */
export function estimateSpeechSeconds(text: string): number {
  return Math.max(1, Math.ceil(text.length / 14));
}

/** ~128 kbps browser-recorded audio, i.e. ~16 kB per second. */
export const ESTIMATED_AUDIO_BYTES_PER_SECOND = 16_000;
export function estimateAudioSeconds(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / ESTIMATED_AUDIO_BYTES_PER_SECOND));
}

function inputText(inputs: unknown): string {
  if (typeof inputs === "string") return inputs;
  try {
    return JSON.stringify(inputs) ?? "";
  } catch {
    // expected-failure: an unserializable input only costs us estimate precision
    return "";
  }
}

function reportedTokenUsage(result: unknown): { in: number; out: number } | null {
  if (typeof result !== "object" || result === null) return null;
  // Google's native generateContent response (reached through the AI Gateway provider path)
  // reports usage under `usageMetadata` with its own key names, not the OpenAI-style `usage`
  // block Workers AI returns. Without this branch every Gemini row would be a guess.
  const googleUsage = (result as { usageMetadata?: Record<string, unknown> }).usageMetadata;
  if (typeof googleUsage === "object" && googleUsage !== null) {
    const num = (value: unknown): number | null =>
      typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
    const input = num(googleUsage.promptTokenCount);
    const output = num(googleUsage.candidatesTokenCount);
    if (input !== null || output !== null) return { in: input ?? 0, out: output ?? 0 };
  }
  const usage = (result as { usage?: Record<string, unknown> }).usage;
  if (typeof usage !== "object" || usage === null) return null;
  const read = (...keys: string[]): number | null => {
    for (const key of keys) {
      const value = usage[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    }
    return null;
  };
  const input = read("prompt_tokens", "input_tokens");
  const output = read("completion_tokens", "output_tokens");
  if (input === null && output === null) return null;
  return { in: input ?? 0, out: output ?? 0 };
}

function ttsBytes(result: unknown): Uint8Array | null {
  if (result instanceof Uint8Array) return result;
  if (result instanceof ArrayBuffer) return new Uint8Array(result);
  const audio = (result as { audio?: unknown } | null)?.audio;
  if (typeof audio === "string") {
    try {
      const binary = atob(audio);
      const out = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
      return out;
    } catch {
      // expected-failure: a non-base64 payload only costs us estimate precision
      return null;
    }
  }
  return null;
}

/**
 * Derives billable units for one call. For audio models, exactly one of unitsIn/unitsOut is
 * non-zero: priceCall sums them, so this invariant is what prevents double-billing.
 */
export function extractUnits(
  price: ModelPrice | undefined, inputs: unknown, result: unknown, hints: AudioHints = {},
): Units {
  if (price?.unit === "per_audio_minute") {
    const parsed = ttsBytes(result);
    const generated = parsed ? parseWavDurationSeconds(parsed) : null;
    if (generated !== null) return { unitsIn: 0, unitsOut: Math.ceil(generated), source: "reported" };
    if (typeof hints.audioSeconds === "number" && hints.audioSeconds > 0) {
      return { unitsIn: Math.ceil(hints.audioSeconds), unitsOut: 0, source: "reported" };
    }
    if (typeof hints.audioBytes === "number" && hints.audioBytes > 0) {
      return { unitsIn: estimateAudioSeconds(hints.audioBytes), unitsOut: 0, source: "estimated" };
    }
    return { unitsIn: 0, unitsOut: estimateSpeechSeconds(inputText(inputs)), source: "estimated" };
  }
  const reported = reportedTokenUsage(result);
  if (reported) return { unitsIn: reported.in, unitsOut: reported.out, source: "reported" };
  return {
    unitsIn: estimateTokens(inputText(inputs)),
    unitsOut: estimateTokens(inputText(result)),
    source: "estimated",
  };
}
