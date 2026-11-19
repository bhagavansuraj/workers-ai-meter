// The price table type and the arithmetic over it.
//
// Pure and dependency-free: no D1, no network, no bindings, so it can be imported by the
// Worker (to price ledger rows at write time) and by offline projection scripts alike.
//
// MONEY NEVER TOUCHES A FLOAT AS A STORED VALUE. Prices are held as integer USD micros
// (millionths of a dollar) per million tokens or per audio minute, and every public
// function returns an integer number of micros. The single division is by a literal
// (1e6 or 60) immediately before one Math.round.

export type PriceUnit = "per_mtok" | "per_audio_minute";

export type ModelPrice = {
  readonly id: string;
  /** Free-form: "workers-ai", "google-ai-studio", "anthropic", … Recorded on every ledger row. */
  readonly provider: string;
  readonly unit: PriceUnit;
  /** micros per million input tokens (per_mtok) */
  readonly inPerMTok?: number;
  /** micros per million output tokens (per_mtok) */
  readonly outPerMTok?: number;
  /** micros per audio minute (per_audio_minute) */
  readonly perMinute?: number;
  /** Cloudflare bills Neurons; keep the figure so a derived USD price can be re-checked. */
  readonly neurons?: string;
  /** When the price was read, and where. A price without provenance can't be audited. */
  readonly sourcedAt: string;
  readonly sourceUrl: string;
};

export type PriceTable = Readonly<Record<string, ModelPrice>>;

export class UnknownModelPriceError extends Error {
  constructor(modelId: string) {
    super(`no pinned price for model ${modelId}`);
    this.name = "UnknownModelPriceError";
  }
}

/**
 * Cost of one call, in integer USD micros.
 *
 * For `per_mtok` models, `unitsIn`/`unitsOut` are tokens. For `per_audio_minute` models they
 * are SECONDS of audio (input seconds for ASR, generated seconds for TTS). Seconds are what
 * call sites can actually measure, so the conversion lives here rather than at every caller.
 *
 * Throws on an unknown model. A missing price must be loud: returning 0 is how spend hides
 * from a ledger.
 */
export function priceCall(prices: PriceTable, modelId: string, unitsIn: number, unitsOut: number): number {
  const price = prices[modelId];
  if (!price) throw new UnknownModelPriceError(modelId);
  const inUnits = Math.max(0, Math.floor(unitsIn));
  const outUnits = Math.max(0, Math.floor(unitsOut));
  if (price.unit === "per_audio_minute") {
    // Audio is billed per minute of the ONE stream the model touches: the output for TTS,
    // the input for ASR. Sum, so a caller that puts it in either slot is priced identically
    // instead of silently at zero. (extractUnits guarantees one side is always 0.)
    return Math.round(((inUnits + outUnits) * (price.perMinute ?? 0)) / 60);
  }
  return Math.round((inUnits * (price.inPerMTok ?? 0) + outUnits * (price.outPerMTok ?? 0)) / 1_000_000);
}

/** Workers Paid: $0.011 per 1,000 Neurons, 10,000 Neurons/day free. */
export const NEURON_MICROS_PER_1K = 11_000;
export const FREE_NEURONS_PER_DAY = 10_000;

/** The free daily Neuron allowance expressed in USD micros. */
export function freeAllowanceMicrosPerDay(): number {
  return Math.round((FREE_NEURONS_PER_DAY * NEURON_MICROS_PER_1K) / 1_000);
}

/**
 * Order-independent FNV-1a checksum over the price FIELDS only (not the version string).
 *
 * Pin `computePriceChecksum(PRICES)` next to your `PRICE_VERSION` in a test. Then editing a
 * price without bumping the version fails CI, and every ledger row's `price_version` keeps
 * meaning exactly one set of numbers.
 */
export function computePriceChecksum(prices: PriceTable): string {
  const canonical = Object.keys(prices)
    .sort()
    .map((key) => {
      const p = prices[key];
      return [p.id, p.provider, p.unit, p.inPerMTok ?? "", p.outPerMTok ?? "", p.perMinute ?? ""].join(":");
    })
    .join("|");
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
