/**
 * Vision worklets — the hot path that runs inside the camera frame
 * processor on the Reanimated worklet runtime.
 * ─────────────────────────────────────────────────────────────────
 * Pipeline (100% on-device, no network):
 *   Frame(RGB buffer)
 *     → center-square ROI crop
 *     → nearest-neighbour downsample to modelInput×modelInput×3
 *     → normalize to [-1, 1]
 *     → TFLite runSync (called by the caller with the built input)
 *     → L2 normalize the embedding
 *     → cosine similarity against every stored product vector
 *
 * Every function here MUST keep its 'worklet' directive so the
 * Reanimated babel plugin compiles it for the worklet runtime.
 */
import type {Frame} from 'react-native-vision-camera';

/**
 * Converts the current frame into a normalized, ROI-cropped model
 * input. Handles both channels-last (NHWC) and channels-first (NCHW)
 * models and both RGB (3 bytes) and RGBA (4 bytes) row layouts.
 *
 * @param frame      The live camera frame (pixelFormat: 'rgb').
 * @param inputSize  Model spatial size (e.g. 224).
 * @param channelsLast  true for [1,N,N,3] models, false for [1,3,N,N].
 * @param normMean   Normalization mean (127.5 → [-1,1] range).
 * @param normStd    Normalization std (127.5).
 * @returns a fresh Float32Array sized exactly to the model input.
 */
export function buildModelInput(
  frame: Frame,
  inputSize: number,
  channelsLast: boolean,
  normMean: number,
  normStd: number,
): Float32Array {
  'worklet';
  const width = frame.width;
  const height = frame.height;
  const bytesPerRow = frame.bytesPerRow;

  // Detect packed RGB (3) vs padded RGBA (4) vs grayscale (1).
  let bytesPerPixel = Math.floor(bytesPerRow / Math.max(width, 1));
  if (bytesPerPixel !== 3 && bytesPerPixel !== 4) {
    bytesPerPixel = 3;
  }

  const buffer = new Uint8Array(frame.toArrayBuffer());

  // Center square ROI — the on-screen guide shows the same region.
  const roiSize = Math.min(width, height);
  const roiX0 = Math.floor((width - roiSize) / 2);
  const roiY0 = Math.floor((height - roiSize) / 2);

  const channels = 3;
  const output = new Float32Array(1 * inputSize * inputSize * channels);

  for (let oy = 0; oy < inputSize; oy += 1) {
    const sy = roiY0 + Math.floor((oy * roiSize) / inputSize);
    const rowOffset = sy * bytesPerRow;
    for (let ox = 0; ox < inputSize; ox += 1) {
      const sx = roiX0 + Math.floor((ox * roiSize) / inputSize);
      const pixelIndex = rowOffset + sx * bytesPerPixel;
      const r = buffer[pixelIndex];
      const g = buffer[pixelIndex + 1];
      const b = buffer[pixelIndex + 2];

      // Grayscale fallback (Y-only frames) — still consistent.
      const rr = r == null ? buffer[pixelIndex] ?? 0 : r;
      const gg = g == null ? rr : g;
      const bb = b == null ? rr : b;

      if (channelsLast) {
        const base = (oy * inputSize + ox) * channels;
        output[base] = (rr - normMean) / normStd;
        output[base + 1] = (gg - normMean) / normStd;
        output[base + 2] = (bb - normMean) / normStd;
      } else {
        const plane = inputSize * inputSize;
        output[oy * inputSize + ox] = (rr - normMean) / normStd;
        output[plane + oy * inputSize + ox] = (gg - normMean) / normStd;
        output[2 * plane + oy * inputSize + ox] = (bb - normMean) / normStd;
      }
    }
  }
  return output;
}

/**
 * Normalizes a vector to unit length IN PLACE so cosine similarity
 * degenerates to a plain dot product (fast path for the worklet).
 */
export function l2NormalizeInPlace(vector: Float32Array): number {
  'worklet';
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) {
    const v = vector[i];
    sum += v * v;
  }
  const norm = Math.sqrt(sum);
  if (norm > 0) {
    for (let i = 0; i < vector.length; i += 1) {
      vector[i] = vector[i] / norm;
    }
  }
  return norm;
}

export interface MatchResult {
  productId: number;
  score: number;
}

/**
 * Cosine similarity of a unit query vector against every stored
 * (already unit-normalized) embedding. Returns the best product or
 * null when the index is empty.
 *
 *   similarity = (A · B) / (‖A‖ ‖B‖)   ← A and B are unit vectors,
 *                                          so this is just A · B.
 */
export function findBestMatch(
  query: Float32Array,
  flat: Float32Array,
  ids: number[],
  dim: number,
): MatchResult | null {
  'worklet';
  const count = ids.length;
  if (count === 0 || dim === 0 || query.length !== dim) {
    return null;
  }
  let bestScore = -1;
  let bestIndex = -1;
  for (let row = 0; row < count; row += 1) {
    const base = row * dim;
    let dot = 0;
    for (let i = 0; i < dim; i += 1) {
      dot += query[i] * flat[base + i];
    }
    if (dot > bestScore) {
      bestScore = dot;
      bestIndex = row;
    }
  }
  if (bestIndex < 0) {
    return null;
  }
  return {productId: ids[bestIndex], score: bestScore};
}

/**
 * Computes similarity of the query against ALL embeddings of one
 * product and returns the best (max) score for that product — used
 * by the "second opinion" check to reduce cross-product confusion.
 */
export function bestScoreForProduct(
  query: Float32Array,
  flat: Float32Array,
  ids: number[],
  dim: number,
  productId: number,
): number {
  'worklet';
  let best = -1;
  for (let row = 0; row < ids.length; row += 1) {
    if (ids[row] !== productId) continue;
    const base = row * dim;
    let dot = 0;
    for (let i = 0; i < dim; i += 1) {
      dot += query[i] * flat[base + i];
    }
    if (dot > best) best = dot;
  }
  return best;
}
