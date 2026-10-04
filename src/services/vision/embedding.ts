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

/**
 * Top-N matches by cosine similarity (probe must be unit-length).
 * Used by the POS vision result sheet so the merchant can pick the
 * right product when the top score is below the auto-add threshold.
 */
export function findTopMatches(
  probe: Float32Array,
  flat: Float32Array,
  ids: number[],
  dim: number,
  topN: number,
): {productId: number; score: number}[] {
  if (
    flat == null ||
    ids == null ||
    ids.length === 0 ||
    dim <= 0 ||
    probe.length !== dim
  ) {
    return [];
  }
  const rows = ids.length;
  const scores = new Float32Array(rows);
  for (let r = 0; r < rows; r++) {
    let dot = 0;
    const base = r * dim;
    for (let d = 0; d < dim; d++) {
      dot += probe[d] * flat[base + d];
    }
    scores[r] = dot;
  }
  const order = Array.from({length: rows}, (_, i) => i);
  order.sort((a, b) => scores[b] - scores[a]);
  const limit = Math.min(topN, order.length);
  const results: {productId: number; score: number}[] = [];
  for (let i = 0; i < limit; i++) {
    const row = order[i];
    results.push({
      productId: ids[row],
      score: Math.max(-1, Math.min(1, scores[row])),
    });
  }
  return results;
}

/**
 * v9.1 (round-14 #2): MULTI-PROBE × per-product aggregation.
 * ─────────────────────────────────────────────────────────────
 * Every query photo produces SEVERAL probe vectors (ensemble crops:
 * classic center, two deeper zooms, whole-frame fit). Each product's
 * score is the MAX over (probes × its registered fingerprint rows) —
 * so the best crop wins, and a product registered with several
 * angles/mirrors gets full credit for its best row.
 *
 * Returns DISTINCT products ranked by their best score — unlike
 * findTopMatches which ranks raw rows (4 rows of the same product
 * used to eat the whole top-4 and hide the true alternatives).
 */
export function matchProductsMulti(
  probes: Float32Array[],
  flat: Float32Array,
  ids: number[],
  dim: number,
  topN: number,
): {productId: number; score: number}[] {
  if (
    flat == null ||
    ids == null ||
    ids.length === 0 ||
    dim <= 0 ||
    probes.length === 0
  ) {
    return [];
  }
  const usable = probes.filter(probe => probe.length === dim);
  if (usable.length === 0) {
    return [];
  }
  // productId → best cosine seen from ANY probe × ANY row.
  const best = new Map<number, number>();
  const rows = ids.length;
  for (const probe of usable) {
    for (let r = 0; r < rows; r++) {
      let dot = 0;
      const base = r * dim;
      for (let d = 0; d < dim; d++) {
        dot += probe[d] * flat[base + d];
      }
      if (dot > 1) {
        dot = 1;
      }
      const productId = ids[r];
      const previous = best.get(productId);
      if (previous == null || dot > previous) {
        best.set(productId, dot);
      }
    }
  }
  return Array.from(best.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(1, topN))
    .map(([productId, score]) => ({productId, score}));
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

// ═════════════════════════════════════════════════════════════════
// v10 (round-16 #4) — multi-product window recognition
// ═════════════════════════════════════════════════════════════════

/** A square probe window in fractional frame coordinates. */
export interface WindowSpec {
  /** Window center, 0..1 of frame width/height. */
  cx: number;
  cy: number;
  /** Window side as a fraction of the frame's short side. */
  w: number;
}

/** One window's match outcome against the fingerprint index. */
export interface WindowHit {
  window: WindowSpec;
  productId: number;
  score: number;
  runnerUpId: number | null;
  runnerUpScore: number;
}

export interface SelectedDetection {
  productId: number;
  units: number;
  score: number;
}

export interface WindowSelection {
  detections: SelectedDetection[];
  ambiguous: {productId: number; score: number}[];
}

/**
 * v10: per-window best + runner-up across the whole fingerprint
 * index. Every window votes for ONE product; the runner-up score is
 * kept so lookalike protection (ambiguity margin) works per window.
 */
export function matchWindowProbes(
  probes: {spec: WindowSpec; vector: Float32Array}[],
  flat: Float32Array,
  ids: number[],
  dim: number,
): WindowHit[] {
  if (
    flat == null ||
    ids == null ||
    ids.length === 0 ||
    dim <= 0 ||
    probes.length === 0
  ) {
    return [];
  }
  const hits: WindowHit[] = [];
  for (const probe of probes) {
    if (probe.vector.length !== dim) {
      continue;
    }
    // Best = the strongest row of the winning PRODUCT; the runner-up
    // is always a DIFFERENT product (a product's own mirror/angle
    // rows must never trigger the lookalike guard).
    let bestId = -1;
    let bestScore = -2;
    let runnerUpId: number | null = null;
    let runnerUpScore = -2;
    const rows = ids.length;
    for (let r = 0; r < rows; r++) {
      const id = ids[r];
      if (id === bestId) {
        // Another fingerprint of the current winner — only upgrades
        // its own score, never becomes the runner-up.
        let dot = 0;
        const base = r * dim;
        for (let d = 0; d < dim; d++) {
          dot += probe.vector[d] * flat[base + d];
        }
        if (dot > bestScore) {
          bestScore = dot;
        }
        continue;
      }
      let dot = 0;
      const base = r * dim;
      for (let d = 0; d < dim; d++) {
        dot += probe.vector[d] * flat[base + d];
      }
      if (dot > bestScore) {
        runnerUpId = bestId >= 0 ? bestId : runnerUpId;
        runnerUpScore = bestScore > -2 ? bestScore : runnerUpScore;
        bestScore = dot;
        bestId = id;
      } else if (dot > runnerUpScore) {
        runnerUpScore = dot;
        runnerUpId = id;
      }
    }
    if (bestId >= 0) {
      hits.push({
        window: probe.spec,
        productId: bestId,
        score: Math.max(-1, Math.min(1, bestScore)),
        runnerUpId: runnerUpId != null && runnerUpId >= 0 ? runnerUpId : null,
        runnerUpScore:
          runnerUpScore > -2 ? Math.max(-1, Math.min(1, runnerUpScore)) : 0,
      });
    }
  }
  return hits;
}

/** Intersection-over-union of two square windows (fraction space). */
export function windowIoU(a: WindowSpec, b: WindowSpec): number {
  const ax1 = a.cx - a.w / 2;
  const ax2 = a.cx + a.w / 2;
  const ay1 = a.cy - a.w / 2;
  const ay2 = a.cy + a.w / 2;
  const bx1 = b.cx - b.w / 2;
  const bx2 = b.cx + b.w / 2;
  const by1 = b.cy - b.w / 2;
  const by2 = b.cy + b.w / 2;
  const interW = Math.min(ax2, bx2) - Math.max(ax1, bx1);
  const interH = Math.min(ay2, by2) - Math.max(ay1, by1);
  if (interW <= 0 || interH <= 0) {
    return 0;
  }
  const inter = interW * interH;
  const union = a.w * a.w + b.w * b.w - inter;
  return union <= 0 ? 0 : inter / union;
}

/**
 * v10: greedy detection selection over the window hits.
 * ─────────────────────────────────────────────────────────────────
 *  • a window accepts its best product when the score clears the
 *    merchant threshold AND the runner-up is far enough behind (the
 *    same lookalike margin the single-probe engine used);
 *  • a SECOND unit of an already-accepted product only counts when
 *    the window barely overlaps the product's first window (IoU) and
 *    scores even higher than the base threshold — two bottles of the
 *    same soda side by side read as ×2, one big box spanning the
 *    frame does not;
 *  • near-miss hits (threshold-0.05..threshold) become the candidate
 *    strip exactly like before.
 */
export function selectDetections(
  hits: WindowHit[],
  options: {
    threshold: number;
    margin: number;
    unitIou: number;
    unitExtra: number;
    maxUnits: number;
  },
): WindowSelection {
  const sorted = [...hits].sort((a, b) => b.score - a.score);
  const accepted = new Map<
    number,
    {score: number; windows: WindowSpec[]; units: number}
  >();
  const ambiguous: {productId: number; score: number}[] = [];
  const nearMiss = options.threshold - 0.05;

  for (const hit of sorted) {
    const existing = accepted.get(hit.productId);
    if (existing != null) {
      // Potential extra UNIT of the same product.
      if (
        existing.units < options.maxUnits &&
        hit.score >= options.threshold + options.unitExtra &&
        existing.windows.every(
          spec => windowIoU(spec, hit.window) < options.unitIou,
        )
      ) {
        existing.windows.push(hit.window);
        existing.units += 1;
      }
      continue;
    }
    const looksLikeRunnerUp =
      hit.runnerUpId != null &&
      hit.score - hit.runnerUpScore < options.margin;
    if (hit.score >= options.threshold && !looksLikeRunnerUp) {
      accepted.set(hit.productId, {
        score: hit.score,
        windows: [hit.window],
        units: 1,
      });
    } else if (hit.score >= nearMiss) {
      if (
        !ambiguous.some(entry => entry.productId === hit.productId)
      ) {
        ambiguous.push({productId: hit.productId, score: hit.score});
      }
    }
  }

  const detections: SelectedDetection[] = Array.from(accepted.entries())
    .map(([productId, value]) => ({
      productId,
      units: value.units,
      score: value.score,
    }))
    .sort((a, b) => b.score - a.score);

  return {detections, ambiguous};
}
