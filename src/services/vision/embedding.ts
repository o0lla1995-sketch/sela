/**
 * Vision math helpers — plain JS (no worklets).
 * ─────────────────────────────────────────────────────────────────
 * v1 ran this math inside a Reanimated frame-processor worklet, which
 * silently crashed because the worklets runtime was never bundled.
 * v2 computes embeddings in the JS thread from photos decoded by the
 * native ImageDecoderModule — slower per frame (~0.5s) but 100%
 * reliable, which matters more at a checkout counter.
 */

/** Decodes a base64 string into raw bytes. */
export function base64ToBytes(b64: string): Uint8Array {
  if (b64 == null || b64.length === 0) {
    return new Uint8Array(0);
  }
  const table = BASE64_TABLE;
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, '');
  const len = clean.length;
  const out = new Uint8Array(Math.floor((len * 3) / 4));
  let o = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < len; i++) {
    const c = clean.charCodeAt(i);
    const v = table[c];
    if (v === undefined || v === 255) {
      continue;
    }
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

const BASE64_TABLE = (() => {
  const table = new Uint8Array(256).fill(255);
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < alphabet.length; i++) {
    table[alphabet.charCodeAt(i)] = i;
  }
  return table;
})();

/**
 * Raw RGB bytes (size×size×3, row-major HWC) → normalized model input.
 * Handles both NHWC (default) and NCHW layouts.
 */
export function bytesToModelInput(
  bytes: Uint8Array,
  size: number,
  mean: number,
  std: number,
  channelsLast: boolean,
): Float32Array {
  const n = size * size;
  if (bytes.length < n * 3) {
    throw new Error(
      `بيانات الصورة ناقصة (${bytes.length} بايت بدلاً من ${n * 3})`,
    );
  }
  const input = new Float32Array(n * 3);
  if (channelsLast) {
    for (let i = 0; i < n * 3; i++) {
      input[i] = (bytes[i] - mean) / std;
    }
  } else {
    // NCHW: all R plane, then G, then B.
    for (let p = 0; p < n; p++) {
      input[p] = (bytes[p * 3] - mean) / std;
      input[n + p] = (bytes[p * 3 + 1] - mean) / std;
      input[n * 2 + p] = (bytes[p * 3 + 2] - mean) / std;
    }
  }
  return input;
}

/** L2-normalizes a vector in place. After this, cosine == dot product. */
export function l2NormalizeInPlace(vec: Float32Array): void {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) {
    sum += vec[i] * vec[i];
  }
  const norm = Math.sqrt(sum);
  if (norm < 1e-12) {
    return;
  }
  for (let i = 0; i < vec.length; i++) {
    vec[i] /= norm;
  }
}

/** Cosine similarity between a normalized probe and the index. */
export function findBestMatch(
  probe: Float32Array,
  flat: Float32Array,
  ids: number[],
  dim: number,
): {productId: number; score: number} | null {
  if (flat == null || ids == null || ids.length === 0 || dim <= 0) {
    return null;
  }
  if (probe.length !== dim) {
    return null;
  }
  let bestId = -1;
  let bestScore = -1;
  const rows = ids.length;
  for (let r = 0; r < rows; r++) {
    let dot = 0;
    const base = r * dim;
    for (let d = 0; d < dim; d++) {
      dot += probe[d] * flat[base + d];
    }
    if (dot > bestScore) {
      bestScore = dot;
      bestId = ids[r];
    }
  }
  return {productId: bestId, score: Math.max(-1, Math.min(1, bestScore))};
}

/** Rounds + serializes a Float32 embedding to compact JSON. */
export function serializeEmbedding(
  vec: Float32Array,
  decimals: number,
): string {
  const factor = Math.pow(10, decimals);
  const rounded = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    rounded[i] = Math.round(vec[i] * factor) / factor;
  }
  return JSON.stringify(Array.from(rounded));
}

/** Parses a stored embedding JSON back into a Float32Array. */
export function deserializeEmbedding(json: string): Float32Array {
  const arr = JSON.parse(json) as number[];
  const vec = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    vec[i] = arr[i];
  }
  return vec;
}
