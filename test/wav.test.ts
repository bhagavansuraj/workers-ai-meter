import { describe, it, expect } from "vitest";
import { extractUnits, parseWavDurationSeconds } from "../src";
import { MELOTTS, PRICES } from "../examples/ai";

function wav(seconds: number, byteRate = 8_000): Uint8Array {
  const dataBytes = Math.round(seconds * byteRate);
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (text: string, at: number) => { for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i)); };
  ascii("RIFF", 0); ascii("WAVE", 8); ascii("fmt ", 12);
  view.setUint32(16, 16, true);
  view.setUint32(28, byteRate, true);
  ascii("data", 36);
  view.setUint32(40, dataBytes, true);
  return bytes;
}

describe("parseWavDurationSeconds", () => {
  it("reads duration from the header", () => {
    expect(parseWavDurationSeconds(wav(2.5))).toBeCloseTo(2.5);
  });

  it("returns null, never NaN/Infinity/a throw, for malformed input", () => {
    expect(parseWavDurationSeconds(new Uint8Array(10))).toBeNull();
    expect(parseWavDurationSeconds(wav(1, 0))).toBeNull(); // byteRate 0
    const lying = wav(1);
    new DataView(lying.buffer).setUint32(40, 10_000_000, true); // data chunk longer than the buffer
    expect(parseWavDurationSeconds(lying)).toBeNull();
  });
});

describe("TTS billing", () => {
  it("bills generated seconds from the WAV the model returned, as reported", () => {
    expect(extractUnits(PRICES[MELOTTS], { prompt: "hi" }, wav(3))).toEqual({ unitsIn: 0, unitsOut: 3, source: "reported" });
  });

  it("estimates from the prompt length when the output isn't a WAV", () => {
    expect(extractUnits(PRICES[MELOTTS], { prompt: "x".repeat(140) }, { audio: "not base64!!" }).source).toBe("estimated");
  });
});
