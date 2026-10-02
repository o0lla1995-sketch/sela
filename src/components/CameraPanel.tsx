/**
 * CameraPanel — shared live-vision component.
 * ─────────────────────────────────────────────────────────────────
 * MODE 'matching'  : continuously matches the frame against every
 *                    stored embedding and fires onMatch() above the
 *                    similarity threshold (with a per-product
 *                    cooldown), auto-adding products to the cart.
 * MODE 'capture'   : continuously refreshes the latest embedding in a
 *                    shared value; the host screen calls capture()
 *                    to consume it during product enrollment.
 *
 * The heavy pipeline (ROI crop → downsample → normalize → TFLite →
 * cosine similarity) runs entirely inside the Reanimated worklet on
 * a background thread — the JS thread only receives final matches.
 */
import React, {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
} from 'react';
import {View, Text, StyleSheet, TouchableOpacity, ActivityIndicator} from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useFrameProcessor,
} from 'react-native-vision-camera';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import {VisionRecognitionService} from '../services/vision/VisionRecognitionService';
import {
  buildModelInput,
  l2NormalizeInPlace,
  findBestMatch,
} from '../services/vision/worklets';
import {useCatalogStore} from '../stores/catalogStore';
import {useSettingsStore} from '../stores/settingsStore';
import {colors, radius, spacing, typography} from '../core/theme';
import {FRAME_PROCESS_INTERVAL_MS, NORM_MEAN, NORM_STD} from '../core/config';
import {logDiag} from '../core/diagnostics';

export interface CameraPanelHandle {
  /** Returns the freshest normalized embedding (or null if stale). */
  captureEmbedding: () => {vector: Float32Array; ageMs: number} | null;
  /** Takes a JPEG photo for the catalogue thumbnail. */
  takePhoto: () => Promise<string | null>;
  /** Resets the per-product cooldown so the next frame matches now. */
  forceScan: () => void;
}

interface CameraPanelProps {
  mode: 'matching' | 'capture';
  onMatch?: (productId: number, score: number) => void;
  /** Emits the live similarity score for UI feedback. */
  onScore?: (score: number) => void;
  enabled?: boolean;
}

export const CameraPanel = forwardRef<CameraPanelHandle, CameraPanelProps>(
  function CameraPanel({mode, onMatch, onScore, enabled = true}, ref) {
    const device = useCameraDevice('back');
    const {hasPermission, requestPermission} = useCameraPermission();

    const model = VisionRecognitionService.getModel();
    const modelInfo = VisionRecognitionService.getInfo();

    const embeddingsIndex = useCatalogStore(state => state.embeddingsIndex);
    const indexVersion = useCatalogStore(state => state.indexVersion);
    const settings = useSettingsStore(state => state.settings);

    const threshold = settings.matchThreshold;
    const cooldownMs = settings.recognitionCooldownMs;
    const inputSize = modelInfo.loaded ? modelInfo.inputSize : 224;
    const channelsLast = modelInfo.channelsLast;

    // ── Shared values (worklet ↔ JS bridge) ─────────────────────
    const lastProcessedAt = useSharedValue(0);
    const lastMatchId = useSharedValue(-1);
    const lastMatchAt = useSharedValue(0);
    const latestEmbedding = useSharedValue<Float32Array | null>(null);
    const latestEmbeddingAt = useSharedValue(0);
    const matchFlash = useSharedValue(0);

    // Stable JS callbacks delivered from the worklet.
    const onMatchRef = useRef(onMatch);
    onMatchRef.current = onMatch;
    const onScoreRef = useRef(onScore);
    onScoreRef.current = onScore;

    const handleMatchFromWorklet = useCallback(
      (productId: number, score: number) => {
        matchFlash.value = withTiming(1, {duration: 110}, finished => {
          if (finished) {
            matchFlash.value = withTiming(0, {duration: 420});
          }
        });
        onMatchRef.current?.(productId, score);
      },
      [matchFlash],
    );

    const handleScoreFromWorklet = useCallback((score: number) => {
      onScoreRef.current?.(score);
    }, []);

    const frameProcessor = useFrameProcessor(
      frame => {
        'worklet';
        const now = frame.timestamp;
        if (now - lastProcessedAt.value < FRAME_PROCESS_INTERVAL_MS) return;
        lastProcessedAt.value = now;

        // `model`, `embeddingsIndex`, … are captured per the official
        // react-native-fast-tflite frame processor pattern.
        if (model == null) return;

        // 1. Frame → normalized ROI-cropped model input.
        const input = buildModelInput(
          frame,
          inputSize,
          channelsLast,
          NORM_MEAN,
          NORM_STD,
        );

        // 2. Inference (synchronous inside the worklet).
        let outputs;
        try {
          outputs = model.runSync([input]);
        } catch {
          return;
        }
        const output = outputs?.[0];
        if (output == null || output.length === 0) return;

        // 3. Unit-normalize → cosine == dot product.
        const vector = output as Float32Array;
        l2NormalizeInPlace(vector);

        if (mode === 'capture') {
          latestEmbedding.value = vector;
          latestEmbeddingAt.value = Date.now();
          return;
        }

        // 4. Best product match across all stored fingerprints.
        if (embeddingsIndex == null) return;
        const result = findBestMatch(
          vector,
          embeddingsIndex.flat,
          embeddingsIndex.ids,
          embeddingsIndex.dim,
        );
        if (result == null) return;

        runOnJS(handleScoreFromWorklet)(result.score);

        if (result.score < threshold) return;

        // Per-product cooldown blocks duplicate adds of the same item
        // while allowing a different product to be matched instantly.
        const sameProduct = result.productId === lastMatchId.value;
        const sinceLast = Date.now() - lastMatchAt.value;
        if (sameProduct && sinceLast < cooldownMs) return;

        lastMatchId.value = result.productId;
        lastMatchAt.value = Date.now();
        runOnJS(handleMatchFromWorklet)(result.productId, result.score);
      },
      [
        mode,
        model,
        embeddingsIndex,
        indexVersion,
        inputSize,
        channelsLast,
        threshold,
        cooldownMs,
        handleMatchFromWorklet,
        handleScoreFromWorklet,
      ],
    );

    const flashStyle = useAnimatedStyle(() => ({
      opacity: matchFlash.value,
    }));

    const cameraRef = useRef<Camera>(null);

    useImperativeHandle(ref, () => ({
      captureEmbedding: () => {
        const vector = latestEmbedding.value;
        const at = latestEmbeddingAt.value;
        if (vector == null || at === 0) return null;
        return {vector, ageMs: Date.now() - at};
      },
      takePhoto: async () => {
        try {
          const photo = await cameraRef.current?.takePhoto({flash: 'off'});
          return photo?.path ?? null;
        } catch (error) {
          logDiag('camera', `فشل التقاط الصورة: ${String(error)}`, 'warn');
          return null;
        }
      },
      forceScan: () => {
        lastMatchId.value = -1;
        lastMatchAt.value = 0;
        lastProcessedAt.value = 0;
      },
    }));

    // ── Permission / device fallbacks ──────────────────────────
    if (!hasPermission) {
      return (
        <View style={styles.stateContainer}>
          <Text style={styles.stateEmoji}>📷</Text>
          <Text style={styles.stateTitle}>إذن الكاميرا مطلوب</Text>
          <Text style={styles.stateText}>
            التعرف البصري على المنتجات يحتاج الوصول للكاميرا — تُعالج كل الصور على
            جهازك ولا تُرسل أي بيانات للإنترنت.
          </Text>
          <TouchableOpacity style={styles.stateButton} onPress={requestPermission}>
            <Text style={styles.stateButtonText}>منح الإذن</Text>
          </TouchableOpacity>
        </View>
      );
    }

    if (device == null) {
      return (
        <View style={styles.stateContainer}>
          <ActivityIndicator color={colors.accent} size="large" />
          <Text style={styles.stateTitle}>جارٍ تهيئة الكاميرا…</Text>
        </View>
      );
    }

    return (
      <View style={styles.cameraWrap}>
        <Camera
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          device={device}
          isActive={enabled}
          photo
          pixelFormat="rgb"
          frameProcessor={frameProcessor}
        />
        {/* ROI guide — the square the shopper should fill with the product. */}
        <View style={styles.roiFrame} pointerEvents="none">
          <View style={[styles.roiCorner, styles.cornerTopRight]} />
          <View style={[styles.roiCorner, styles.cornerBottomRight]} />
          <View style={[styles.roiCorner, styles.cornerTopLeft]} />
          <View style={[styles.roiCorner, styles.cornerBottomLeft]} />
        </View>
        <Animated.View style={[styles.flashOverlay, flashStyle]} pointerEvents="none" />
        {modelInfo.loaded ? null : (
          <View style={styles.modelBadge}>
            <Text style={styles.modelBadgeText}>
              {modelInfo.loadError
                ? 'النموذج غير متاح — استخدم الوضع اليدوي'
                : 'جارٍ تحميل النموذج…'}
            </Text>
          </View>
        )}
      </View>
    );
  },
);

const styles = StyleSheet.create({
  cameraWrap: {
    flex: 1,
    backgroundColor: '#000000',
    overflow: 'hidden',
  },
  roiFrame: {
    ...StyleSheet.absoluteFillObject,
  },
  roiCorner: {
    position: 'absolute',
    width: 34,
    height: 34,
    borderColor: colors.roi,
  },
  cornerTopRight: {
    top: '16%',
    right: '11%',
    borderTopWidth: 4,
    borderRightWidth: 4,
    borderTopRightRadius: 10,
  },
  cornerBottomRight: {
    bottom: '16%',
    right: '11%',
    borderBottomWidth: 4,
    borderRightWidth: 4,
    borderBottomRightRadius: 10,
  },
  cornerTopLeft: {
    top: '16%',
    left: '11%',
    borderTopWidth: 4,
    borderLeftWidth: 4,
    borderTopLeftRadius: 10,
  },
  cornerBottomLeft: {
    bottom: '16%',
    left: '11%',
    borderBottomWidth: 4,
    borderLeftWidth: 4,
    borderBottomLeftRadius: 10,
  },
  flashOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.flash,
  },
  modelBadge: {
    position: 'absolute',
    bottom: spacing.sm,
    left: spacing.sm,
    right: spacing.sm,
    backgroundColor: 'rgba(17,17,17,0.85)',
    borderRadius: radius.md,
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
  },
  modelBadgeText: {
    color: colors.warning,
    fontSize: typography.small,
    textAlign: 'center',
    fontWeight: '700',
  },
  stateContainer: {
    flex: 1,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  stateEmoji: {
    fontSize: 44,
    marginBottom: spacing.md,
  },
  stateTitle: {
    color: colors.text,
    fontSize: typography.body,
    fontWeight: '800',
    marginBottom: spacing.sm,
  },
  stateText: {
    color: colors.textDim,
    fontSize: typography.caption,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: spacing.lg,
  },
  stateButton: {
    backgroundColor: colors.accent,
    borderRadius: radius.lg,
    paddingVertical: 12,
    paddingHorizontal: spacing.xl,
  },
  stateButtonText: {
    color: '#FFFFFF',
    fontWeight: '800',
  },
});
