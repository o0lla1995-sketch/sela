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
} from '../../core/config';
import {logDiag} from '../../core/diagnostics';
import type {EmbeddingsIndex, VisionModelInfo} from '../../core/types';
import {ImageDecoderNative} from '../../native/nativeBridge';
import {
  base64ToBytes,
  bytesToModelInput,
  findBestMatch,
  l2NormalizeInPlace,
  serializeEmbedding,
} from './embedding';

// Metro resolves this require to a bundled asset because 'tflite' is
// registered in metro.config.js assetExts.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const MODEL_SOURCE = require('../../../assets/models/mobilenet_v3_small.tflite');

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
