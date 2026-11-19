import { describe, it, expect } from "vitest";
import { UnknownModelPriceError, computePriceChecksum, freeAllowanceMicrosPerDay, priceCall } from "../src";
import { LLAMA_70B, MELOTTS, PRICES, PRICE_TABLE_CHECKSUM, PRICE_VERSION, WHISPER_TURBO } from "../examples/ai";

describe("priceCall", () => {
  it("returns integer micros for token models", () => {
    expect(priceCall(PRICES, LLAMA_70B, 1_000_000, 0)).toBe(293_000);
    expect(priceCall(PRICES, LLAMA_70B, 0, 1_000_000)).toBe(2_253_000);
    expect(Number.isInteger(priceCall(PRICES, LLAMA_70B, 7, 13))).toBe(true);
  });

  it("bills audio per minute from seconds, in whichever slot the seconds arrive", () => {
    expect(priceCall(PRICES, WHISPER_TURBO, 120, 0)).toBe(1_000);
    expect(priceCall(PRICES, MELOTTS, 0, 60)).toBe(200);
    expect(priceCall(PRICES, MELOTTS, 60, 0)).toBe(priceCall(PRICES, MELOTTS, 0, 60));
  });

  it("clamps negative and fractional units rather than producing negative money", () => {
    expect(priceCall(PRICES, LLAMA_70B, -5, -5)).toBe(0);
    expect(priceCall(PRICES, LLAMA_70B, 1.9, 0)).toBe(priceCall(PRICES, LLAMA_70B, 1, 0));
  });

  it("throws on an unknown model: a missing price must be loud, never 0", () => {
    expect(() => priceCall(PRICES, "@cf/unknown", 1, 1)).toThrow(UnknownModelPriceError);
  });

  it("knows the Workers Paid free Neuron allowance in micros", () => {
    expect(freeAllowanceMicrosPerDay()).toBe(110_000); // 10k Neurons × $0.011/1k
  });
});

describe("price table pinning", () => {
  it("changes the checksum when any price field changes", () => {
    const edited = { ...PRICES, [LLAMA_70B]: { ...PRICES[LLAMA_70B], outPerMTok: 2_253_001 } };
    expect(computePriceChecksum(edited)).not.toBe(computePriceChecksum(PRICES));
  });

  it("is independent of key order", () => {
    const reversed = Object.fromEntries(Object.entries(PRICES).reverse());
    expect(computePriceChecksum(reversed)).toBe(computePriceChecksum(PRICES));
  });

  it("pins the example table to its PRICE_VERSION", () => {
    // Edited a price? Bump PRICE_VERSION in examples/ai.ts and update BOTH values here.
    expect({ PRICE_VERSION, PRICE_TABLE_CHECKSUM }).toMatchInlineSnapshot(`
      {
        "PRICE_TABLE_CHECKSUM": "5c064c4b",
        "PRICE_VERSION": "2026-09-05",
      }
    `);
  });
});
