/**
 * VisionRecognitionService
 * ─────────────────────────────────────────────────────────────────
 * Owns the TFLite feature-extractor model and exposes everything the
 * camera panels need: model object (for the worklet), resolved input
 * geometry and live diagnostics.
 *
 * Model: MediaPipe MobileNetV3-Small float32 image embedder,
 * bundled at assets/models/mobilenet_v3_small.tflite (~4 MB,
 * CPU inference in a few milliseconds on mid-range phones).
 */
import {loadTensorflowModel, type TensorflowModel} from 'react-native-fast-tflite';
import {
  MODEL_INPUT_SIZE,
  NORM_MEAN,
  NORM_STD,
} from '../../core/config';
import {logDiag} from '../../core/diagnostics';
import type {VisionModelInfo} from '../../core/types';

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

      // Input geometry: NHWC [1,224,224,3] or NCHW [1,3,224,224].
      let inputSize = MODEL_INPUT_SIZE;
      let channelsLast = true;
      const dim0 = inputShape[1] ?? 0;
      const dim1 = inputShape[2] ?? 0;
      const dim2 = inputShape[3] ?? 0;
      if (dim0 === 3 && dim2 === 0) {
        // [1, 3, N, N]
        channelsLast = false;
        inputSize = dim1 || MODEL_INPUT_SIZE;
      } else if (dim2 === 3 && dim1 !== 0) {
        // [1, N, N, 3]
        channelsLast = true;
        inputSize = dim1;
      } else if (dim1 !== 0 && dim2 !== 0) {
        channelsLast = true;
        inputSize = dim1;
      }

      // Output dimension: last non-batch dimension, with a runtime
      // probe fallback for dynamic (-1) shapes.
      let embeddingDim = outputShape[outputShape.length - 1] ?? 0;
      if (!embeddingDim || embeddingDim < 0) {
        const probeInput = new Float32Array(
          inputSize * inputSize * 3,
        );
        const outputs = loaded.runSync([probeInput]);
        const probeOut = outputs?.[0];
        embeddingDim = probeOut ? probeOut.length : 0;
      }

      info = {
        loaded: true,
        inputSize,
        channelsLast,
        embeddingDim,
        inputName: loaded.inputs[0]?.name ?? '',
        outputName: loaded.outputs[0]?.name ?? '',
        loadError: null,
      };
      logDiag(
        'vision',
        `تم تحميل النموذج (إدخال ${inputSize}×${inputSize}، متجه ${embeddingDim} بُعد)`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      info = {...info, loaded: false, loadError: message};
      logDiag('vision', `فشل تحميل نموذج التعرف: ${message}`, 'error');
    }
  },

  /** Live model for the frame processor worklet (null while loading). */
  getModel(): TensorflowModel | null {
    return model;
  },

  getInfo(): VisionModelInfo {
    return info;
  },

  /** Normalization constants shared by every camera panel. */
  getNorm(): {mean: number; std: number} {
    return {mean: NORM_MEAN, std: NORM_STD};
  },
};
