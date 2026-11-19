// Duration of a PCM WAV from its header alone, so TTS output can be billed per generated
// audio minute without a decode library.

function readAscii(view: DataView, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

/**
 * Duration of a canonical PCM WAV, computed as data-chunk-bytes ÷ byteRate —
 * pure byte-offset arithmetic, no decode library. Best-effort by contract:
 * returns null (never throws, never NaN/Infinity/negative) for anything that
 * isn't a well-formed WAV — a truncated buffer, a missing RIFF/WAVE header, a
 * zero byteRate (divide-by-zero), or a data chunk claiming more bytes than the
 * buffer physically holds. A null duration is non-fatal: the meter falls back to an
 * estimate and marks the row `estimated`.
 */
export function parseWavDurationSeconds(bytes: Uint8Array): number | null {
  try {
    if (bytes.byteLength < 44) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (readAscii(view, 0, 4) !== "RIFF") return null;
    if (readAscii(view, 8, 4) !== "WAVE") return null;

    // Walk the chunk list from just after "WAVE" to find fmt (byteRate) + data.
    let byteRate = 0;
    let dataBytes: number | null = null;
    let offset = 12;
    while (offset + 8 <= bytes.byteLength) {
      const chunkId = readAscii(view, offset, 4);
      const chunkSize = view.getUint32(offset + 4, true);
      if (chunkId === "fmt " && offset + 8 + 16 <= bytes.byteLength) {
        // fmt body: audioFormat(2) channels(2) sampleRate(4) byteRate(4) …
        byteRate = view.getUint32(offset + 8 + 8, true);
      } else if (chunkId === "data") {
        dataBytes = chunkSize;
        // A data chunk claiming more bytes than actually present is corrupt —
        // never let it inflate the duration past what the buffer can hold.
        const available = bytes.byteLength - (offset + 8);
        if (dataBytes > available) return null;
        break;
      }
      // Chunks are word-aligned: an odd size carries a trailing pad byte.
      offset += 8 + chunkSize + (chunkSize % 2);
    }

    if (dataBytes === null || byteRate <= 0) return null;
    const duration = dataBytes / byteRate;
    if (!Number.isFinite(duration) || duration < 0) return null;
    return duration;
  } catch {
    // expected-failure: any malformed input degrades to "no known duration"
    return null;
  }
}
