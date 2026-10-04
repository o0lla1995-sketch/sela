/**
 * VisionRecognitionService — v2 photo-pipeline.
 * ─────────────────────────────────────────────────────────────────
 * Owns the TFLite feature-extractor model and the full
 * photo → embedding → match pipeline:
 *
 *   1. Camera takePhoto() → JPEG file
 *   2. ImageDecoderModule.decodeRgb() → base64 RGB bytes (native)
 *   3. bytesToModelInput() → normalized Float32Array (JS)
 *   4. model.runSync() → 576-d embedding (JSI, fast)
 *   5. l2Normalize → findBestMatch (cosine)
 *
 * No frame processors, no worklets — the crash that blacked out the
 * POS screen in v1 cannot happen again.
 */
import {
  loadTensorflowModel,
  type TensorflowModel,
} from 'react-native-fast-tflite';
import {
  MODEL_INPUT_SIZE,
  NORM_MEAN,
  NORM_STD,
  EMBEDDING_DECIMALS,
  VISION_WINDOW_CENTER,
  VISION_WINDOW_GRID,
  VISION_GRID_POSITIONS,
} from '../../core/config';
import {logDiag} from '../../core/diagnostics';
import type {EmbeddingsIndex, VisionModelInfo} from '../../core/types';
import {ImageDecoderNative} from '../../native/nativeBridge';
import {
  base64ToBytes,
  bytesToModelInput,
  findBestMatch,
  l2NormalizeInPlace,
  matchProductsMulti,
  serializeEmbedding,
  type WindowSpec,
} from './embedding';

// Metro resolves this require to a bundled asset because 'tflite' is
// registered in metro.config.js assetExts.
//
// v10 (round-16 #4): MobileNetV3-Small-075 → EfficientNet-B0
// feature extractor (ImageNet, GAP, 1280-d). Benchmarked on real
// product photos: same-product crop similarity 0.83 vs 0.72 and
// +15% separation margin — lookalike products resolve, and at the
// 0.80 threshold the best-window true-accept climbs from 75% to
// 92% with false accepts at 0%. The model includes its own input
// rescaling, so pixels are passed through RAW [0,255].
// eslint-disable-next-line @typescript-eslint/no-var-requires
const MODEL_SOURCE = require('../../../assets/models/efficientnet_b0.tflite');

let model: TensorflowModel | null = null;

let info: VisionModelInfo = {
  loaded: false,
  inputSize: MODEL_INPUT_SIZE,
  channelsLast: true,
  embeddingDim: 0,
  inputName: '',
  outputName: '',
  loadError: null,
};

export const VisionRecognitionService = {
  /** Loads the model and resolves its exact input/output geometry. */
  async loadModel(): Promise<void> {
    if (model != null) {
      return;
    }
    try {
      const loaded = await loadTensorflowModel(MODEL_SOURCE, 'default');
      model = loaded;

      const inputShape: number[] = loaded.inputs[0]?.shape ?? [];
      const outputShape: number[] = loaded.outputs[0]?.shape ?? [];

      let inputSize = MODEL_INPUT_SIZE;
      let channelsLast = true;
      const dim0 = inputShape[1] ?? 0;
      const dim1 = inputShape[2] ?? 0;
      const dim2 = inputShape[3] ?? 0;
      if (dim0 === 3 && dim2 === 0) {
        channelsLast = false;
        inputSize = dim1 || MODEL_INPUT_SIZE;
      } else if (dim2 === 3 && dim1 !== 0) {
        channelsLast = true;
        inputSize = dim1;
      } else if (dim1 !== 0 && dim2 !== 0) {
        channelsLast = true;
        inputSize = dim1;
      }

      let embeddingDim = outputShape[outputShape.length - 1] ?? 0;
      if (!embeddingDim || embeddingDim < 0) {
        const probeInput = new Float32Array(inputSize * inputSize * 3);
        const outputs = loaded.runSync([probeInput]);
        const probeOut = outputs?.[0];
        embeddingDim = probeOut ? probeOut.length : 0;
      }

      info = {
        loaded: true,
        inputSize,
        channelsLast,
        embeddingDim,
        inputName: String(loaded.inputs[0]?.name ?? ''),
        outputName: String(loaded.outputs[0]?.name ?? ''),
        loadError: null,
      };
      logDiag(
        'vision',
        `تم تحميل النموذج: مدخل ${inputSize}×${inputSize}${
          channelsLast ? ' NHWC' : ' NCHW'
        }، خرج ${embeddingDim} بُعد`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logDiag('vision', `فشل تحميل النموذج: ${message}`, 'error');
      info = {...info, loaded: false, loadError: message};
    }
  },

  getModel(): TensorflowModel | null {
    return model;
  },

  getInfo(): VisionModelInfo {
    return info;
  },

  /**
   * Full pipeline: photo file → normalized embedding vector.
   * Throws with a readable Arabic message on any failure.
   */
  async embedPhoto(photoPath: string): Promise<Float32Array> {
    if (model == null) {
      throw new Error('نموذج التعرف غير محمّل');
    }
    if (ImageDecoderNative == null) {
      throw new Error('وحدة معالجة الصور غير متوفرة في هذا الإصدار');
    }
    const size = info.loaded ? info.inputSize : MODEL_INPUT_SIZE;

    // 1. Native decode → base64 RGB bytes.
    const b64 = await ImageDecoderNative.decodeRgb(photoPath, size);
    if (typeof b64 !== 'string' || b64.length === 0) {
      throw new Error('تعذر استخراج بيانات الصورة');
    }
    const bytes = base64ToBytes(b64);
    if (bytes.length < size * size * 3) {
      throw new Error('بيانات الصورة غير مكتملة');
    }

    // 2. Normalize into the model's expected layout.
    const input = bytesToModelInput(
      bytes,
      size,
      NORM_MEAN,
      NORM_STD,
      info.channelsLast,
    );

    // 3. Inference.
    const outputs = model.runSync([input]);
    const output = outputs?.[0];
    if (output == null || output.length === 0) {
      throw new Error('النموذج لم يُرجع نتيجة');
    }

    // 4. Unit vector (cosine == dot afterwards).
    const vector = new Float32Array(output.length);
    vector.set(output as Float32Array);
    l2NormalizeInPlace(vector);
    return vector;
  },

  /**
   * v9.1 (round-14 #2): ensemble variant of embedPhoto — one probe
   * per (zoom / fit / flip) view of the SAME photo. Used by the POS
   * scanner so the best crop wins (a product shot off-center or
   * small in frame used to fail with the single classic crop).
   */
  async embedPhotoEx(
    photoPath: string,
    view: {zoom?: number; fit?: boolean; flip?: boolean},
  ): Promise<Float32Array> {
    if (model == null) {
      throw new Error('نموذج التعرف غير محمّل');
    }
    if (ImageDecoderNative == null) {
      throw new Error('وحدة معالجة الصور غير متوفرة في هذا الإصدار');
    }
    const size = info.loaded ? info.inputSize : MODEL_INPUT_SIZE;
    const zoom = view.zoom ?? 1;
    const fit = view.fit ?? false;
    const flip = view.flip ?? false;

    const b64 = await ImageDecoderNative.decodeRgbEx(
      photoPath,
      size,
      zoom,
      fit,
      flip,
    );
    if (typeof b64 !== 'string' || b64.length === 0) {
      throw new Error('تعذر استخراج بيانات الصورة');
    }
    const bytes = base64ToBytes(b64);
    if (bytes.length < size * size * 3) {
      throw new Error('بيانات الصورة غير مكتملة');
    }
    const input = bytesToModelInput(
      bytes,
      size,
      NORM_MEAN,
      NORM_STD,
      info.channelsLast,
    );
    const outputs = model.runSync([input]);
    const output = outputs?.[0];
    if (output == null || output.length === 0) {
      throw new Error('النموذج لم يُرجع نتيجة');
    }
    const vector = new Float32Array(output.length);
    vector.set(output as Float32Array);
    l2NormalizeInPlace(vector);
    return vector;
  },

  /**
   * v9.1 (round-14 #2): the STRONG query — a four-crop ensemble of
   * one photo: classic center square, 0.78 zoom, 0.56 zoom and a
   * whole-frame fit. A probe that fails to decode/infer is skipped
   * (the remaining crops still match); at least one must succeed.
   */
  async embedPhotoEnsemble(photoPath: string): Promise<Float32Array[]> {
    const views: {zoom?: number; fit?: boolean}[] = [
      {zoom: 1},
      {zoom: 0.78},
      {zoom: 0.56},
      {fit: true},
    ];
    const probes: Float32Array[] = [];
    let lastError: unknown = null;
    for (const view of views) {
      try {
        probes.push(await this.embedPhotoEx(photoPath, view));
      } catch (error) {
        lastError = error;
      }
    }
    if (probes.length === 0) {
      throw lastError instanceof Error
        ? lastError
        : new Error('فشل تحليل صورة المسح');
    }
    return probes;
  },

  /**
   * v10 (round-16 #4): the CASCADE — step 1 is a single whole-frame
   * FIT probe. One product roughly filling the frame (the everyday
   * case) matches here and the scan resolves after ONE inference —
   * faster than the old four-crop ensemble while running a much
   * stronger model.
   */
  async embedFitProbe(photoPath: string): Promise<Float32Array> {
    return this.embedPhotoEx(photoPath, {fit: true});
  },

  /**
   * v10 (round-16 #4): the CASCADE — step 2, the multi-product
   * WINDOW pass. One center window (a product filling the frame but
   * slightly off-center) + a 3×3 grid of local windows that each
   * read ONE item from a shelf-style photo. The JPEG is decoded
   * ONCE natively (cached) and every window is a cheap crop, so the
   * 10-window pass costs one decode + 10 small crops + 10 inferences.
   * A failed window is skipped; at least one must succeed.
   */
  async embedWindowProbes(
    photoPath: string,
  ): Promise<{spec: WindowSpec; vector: Float32Array}[]> {
    if (model == null) {
      throw new Error('نموذج التعرف غير محمّل');
    }
    if (ImageDecoderNative == null) {
      throw new Error('وحدة معالجة الصور غير متوفرة في هذا الإصدار');
    }
    const size = info.loaded ? info.inputSize : MODEL_INPUT_SIZE;
    const windows: WindowSpec[] = [
      {cx: 0.5, cy: 0.5, w: VISION_WINDOW_CENTER},
    ];
    for (const cy of VISION_GRID_POSITIONS) {
      for (const cx of VISION_GRID_POSITIONS) {
        windows.push({cx, cy, w: VISION_WINDOW_GRID});
      }
    }
    const probes: {spec: WindowSpec; vector: Float32Array}[] = [];
    let lastError: unknown = null;
    for (const spec of windows) {
      try {
        const b64 = await ImageDecoderNative.decodeRgbWindow(
          photoPath,
          size,
          spec.cx,
          spec.cy,
          spec.w,
        );
        if (typeof b64 !== 'string' || b64.length === 0) {
          throw new Error('تعذر استخراج بيانات الصورة');
        }
        const bytes = base64ToBytes(b64);
        if (bytes.length < size * size * 3) {
          throw new Error('بيانات الصورة غير مكتملة');
        }
        const input = bytesToModelInput(
          bytes,
          size,
          NORM_MEAN,
          NORM_STD,
          info.channelsLast,
        );
        const outputs = model.runSync([input]);
        const output = outputs?.[0];
        if (output == null || output.length === 0) {
          throw new Error('النموذج لم يُرجع نتيجة');
        }
        const vector = new Float32Array(output.length);
        vector.set(output as Float32Array);
        l2NormalizeInPlace(vector);
        probes.push({spec, vector});
      } catch (error) {
        lastError = error;
      }
    }
    if (probes.length === 0) {
      throw lastError instanceof Error
        ? lastError
        : new Error('فشل تحليل نوافذ الصورة');
    }
    return probes;
  },

  /** v10: frees the native window-decode cache after a photo pass. */
  async releaseDecodeCache(): Promise<void> {
    try {
      await ImageDecoderNative?.releaseDecodeCache();
    } catch {
      // Best-effort — the cache also rolls over on the next photo.
    }
  },

  /**
   * v9.1: ensemble matching — best cosine per DISTINCT product
   * across all probes × all registered rows (see matchProductsMulti).
   */
  matchMulti(
    probes: Float32Array[],
    index: EmbeddingsIndex | null,
    topN: number,
  ): {productId: number; score: number}[] {
    if (index == null) {
      return [];
    }
    return matchProductsMulti(probes, index.flat, index.ids, index.dim, topN);
  },

  /** Serializes an embedding for database storage. */
  serialize(vector: Float32Array): string {
    return serializeEmbedding(vector, EMBEDDING_DECIMALS);
  },

  /** Best product match for a probe vector. */
  match(
    vector: Float32Array,
    index: EmbeddingsIndex | null,
  ): {productId: number; score: number} | null {
    if (index == null) {
      return null;
    }
    return findBestMatch(vector, index.flat, index.ids, index.dim);
  },

  /** Saves a downscaled JPEG copy for catalogue thumbnails. */
  async saveThumbnail(photoPath: string): Promise<string | null> {
    try {
      if (ImageDecoderNative == null) {
        return null;
      }
      return await ImageDecoderNative.saveScaled(photoPath, 400, 82);
    } catch (error) {
      logDiag(
        'vision',
        `فشل حفظ الصورة المصغرة: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'warn',
      );
      return null;
    }
  },
};
