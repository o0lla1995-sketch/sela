/**
 * ScannerCamera — v2 live vision component.
 * ─────────────────────────────────────────────────────────────────
 * A plain viewfinder + photo taker. Recognition happens in JS:
 *   takePhoto → native decodeRgb → normalize → TFLite → cosine.
 *
 * This replaces v1's CameraPanel whose frame processor crashed the
 * whole screen (missing worklets runtime). All state transitions are
 * guarded; the camera can never blank the app.
 *
 * Modes:
 *   'scan'    — auto-scan loop calling onMatch above threshold
 *   'capture' — manual captures for product enrollment
 */
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  Vibration,
  View,
} from 'react-native';
import {
  Camera,
  getCameraFormat,
  useCameraDevice,
  useCameraPermission,
  type PhotoFile,
} from 'react-native-vision-camera';
import {Icon} from './Icon';
import {colors, fonts, radius, spacing, typography} from '../core/theme';
import {AUTO_SCAN_INTERVAL_MS} from '../core/config';
import {VisionRecognitionService} from '../services/vision/VisionRecognitionService';
import {useCatalogStore} from '../stores/catalogStore';
import {useSettingsStore} from '../stores/settingsStore';
import {requirePlatformUtils} from '../native/nativeBridge';
import {logDiag} from '../core/diagnostics';
import type {AngleLabel} from '../core/types';

export interface ScanResult {
  productId: number;
  score: number;
}

export interface CaptureResult {
  embedding: Float32Array;
  thumbnailPath: string | null;
  photoPath: string;
}

export interface ScannerCameraHandle {
  /** Triggers one recognition pass; resolves null when no confident match. */
  scanOnce: () => Promise<ScanResult | null>;
  /** Captures an enrollment photo: embedding + thumbnail + photo path. */
  captureAngle: (angle: AngleLabel) => Promise<CaptureResult>;
  /** Whether a scan cycle is currently running. */
  isBusy: () => boolean;
}

interface ScannerCameraProps {
  mode: 'scan' | 'capture';
  /** scan mode: fires for every confident match (with per-product cooldown). */
  onMatch?: (result: ScanResult) => void;
  /** scan mode: fires for every completed pass, matched or not. */
  onScore?: (score: number | null) => void;
  /** scan mode: enable the automatic loop. */
  autoScan?: boolean;
}

export const ScannerCamera = forwardRef<ScannerCameraHandle, ScannerCameraProps>(
  function ScannerCamera({mode, onMatch, onScore, autoScan = false}, ref) {
    const device = useCameraDevice('back');

    // A modest photo resolution (~2MP) is plenty for 224px embeddings —
    // it captures and decodes several times faster than the 12MP max.
    const photoFormat = React.useMemo(() => {
      if (device == null) {
        return undefined;
      }
      try {
        return getCameraFormat(device, [
          {photoResolution: {width: 1600, height: 1200}},
        ]);
      } catch {
        return undefined;
      }
    }, [device]);
    const {hasPermission, requestPermission} = useCameraPermission();

    const cameraRef = useRef<React.ElementRef<typeof Camera>>(null);
    const busyRef = useRef(false);
    const disposedRef = useRef(false);
    const loopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastMatchRef = useRef<{productId: number; at: number} | null>(null);

    const [busy, setBusy] = useState(false);
    const [statusText, setStatusText] = useState<string>(
      mode === 'scan' ? 'جاهز للمسح' : 'وجّه الكاميرا نحو المنتج',
    );
    const [flash, setFlash] = useState(false);

    const embeddingsIndex = useCatalogStore(state => state.embeddingsIndex);
    const threshold = useSettingsStore(state => state.settings.matchThreshold);
    const cooldownMs = useSettingsStore(
      state => state.settings.recognitionCooldownMs,
    );

    const onMatchRef = useRef(onMatch);
    onMatchRef.current = onMatch;
    const onScoreRef = useRef(onScore);
    onScoreRef.current = onScore;

    useEffect(() => {
      disposedRef.current = false;
      return () => {
        disposedRef.current = true;
        if (loopTimerRef.current != null) {
          clearTimeout(loopTimerRef.current);
          loopTimerRef.current = null;
        }
      };
    }, []);

    const takePhotoSafely = useCallback(async (): Promise<PhotoFile | null> => {
      const camera = cameraRef.current;
      if (camera == null) {
        return null;
      }
      try {
        return await camera.takePhoto({
          flash: 'off',
          enableAutoDistortionCorrection: false,
          enableShutterSound: false,
        });
      } catch (error) {
        logDiag(
          'camera',
          `فشل التقاط الصورة: ${error instanceof Error ? error.message : String(error)}`,
          'warn',
        );
        return null;
      }
    }, []);

    const deleteQuietly = useCallback(async (path: string) => {
      try {
        await requirePlatformUtils().deleteFile(path);
      } catch {
        // Temp photo cleanup is best-effort.
      }
    }, []);

    const beep = useCallback(() => {
      try {
        void requirePlatformUtils().beep(0);
      } catch {
        // Sound is a nicety.
      }
    }, []);

    // ── Recognition pass ────────────────────────────────────────
    const scanOnce = useCallback(async (): Promise<ScanResult | null> => {
      if (busyRef.current) {
        return null;
      }
      const modelInfo = VisionRecognitionService.getInfo();
      if (!modelInfo.loaded) {
        setStatusText('نموذج التعرف غير محمّل — استخدم الإضافة اليدوية');
        return null;
      }
      busyRef.current = true;
      setBusy(true);
      setStatusText('جارٍ المسح…');
      try {
        const photo = await takePhotoSafely();
        if (photo == null) {
          setStatusText('تعذر الالتقاط — حاول مجدداً');
          return null;
        }
        try {
          const vector = await VisionRecognitionService.embedPhoto(photo.path);
          const index = useCatalogStore.getState().embeddingsIndex;
          const best = VisionRecognitionService.match(vector, index);
          if (best == null) {
            onScoreRef.current?.(null);
            setStatusText('لا توجد بصمات محفوظة بعد');
            return null;
          }
          onScoreRef.current?.(best.score);
          if (best.score >= threshold) {
            const now = Date.now();
            const last = lastMatchRef.current;
            const cooled =
              last != null &&
              last.productId === best.productId &&
              now - last.at < cooldownMs;
            if (!cooled) {
              lastMatchRef.current = {productId: best.productId, at: now};
              setFlash(true);
              setTimeout(() => setFlash(false), 240);
              Vibration.vibrate(40);
              beep();
              setStatusText('تم التعرّف على المنتج');
              onMatchRef.current?.(best);
              return best;
            }
            setStatusText('تمت الإضافة للسلة');
            return best;
          }
          setStatusText(
            `أقرب تشابه ${(best.score * 100).toFixed(0)}% — حدّد الكاميرا أكثر`,
          );
          return null;
        } finally {
          await deleteQuietly(photo.path);
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'خطأ غير معروف';
        setStatusText(`فشل المسح: ${message}`);
        logDiag('camera', `فشل المسح: ${message}`, 'warn');
        return null;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    }, [beep, cooldownMs, deleteQuietly, takePhotoSafely, threshold]);

    // ── Enrollment capture ──────────────────────────────────────
    const captureAngle = useCallback(
      async (angle: AngleLabel): Promise<CaptureResult> => {
        if (busyRef.current) {
          throw new Error('عملية التقاط أخرى قيد التنفيذ');
        }
        busyRef.current = true;
        setBusy(true);
        setStatusText(`جارٍ التقاط الزاوية ${angle === 'front' ? 'الأمامية' : angle === 'back' ? 'الخلفية' : 'الجانبية'}…`);
        try {
          const photo = await takePhotoSafely();
          if (photo == null) {
            throw new Error('تعذر التقاط الصورة — حاول مرة أخرى');
          }
          const embedding = await VisionRecognitionService.embedPhoto(photo.path);
          const thumbnailPath =
            await VisionRecognitionService.saveThumbnail(photo.path);
          await deleteQuietly(photo.path);
          setStatusText('تم حفظ البصمة بنجاح');
          beep();
          Vibration.vibrate(30);
          return {embedding, thumbnailPath, photoPath: photo.path};
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'خطأ غير معروف';
          setStatusText(`فشل الالتقاط: ${message}`);
          throw error;
        } finally {
          busyRef.current = false;
          setBusy(false);
        }
      },
      [beep, deleteQuietly, takePhotoSafely],
    );

    useImperativeHandle(ref, () => ({
      scanOnce: async () => scanOnce(),
      captureAngle: async (angle: AngleLabel) => captureAngle(angle),
      isBusy: () => busyRef.current,
    }));

    // ── Auto-scan loop (POS) ────────────────────────────────────
    useEffect(() => {
      if (mode !== 'scan' || !autoScan) {
        return;
      }
      let stopped = false;
      const tick = async () => {
        if (stopped || disposedRef.current) {
          return;
        }
        await scanOnce();
        if (stopped || disposedRef.current) {
          return;
        }
        loopTimerRef.current = setTimeout(tick, AUTO_SCAN_INTERVAL_MS);
      };
      loopTimerRef.current = setTimeout(tick, 350);
      return () => {
        stopped = true;
        if (loopTimerRef.current != null) {
          clearTimeout(loopTimerRef.current);
          loopTimerRef.current = null;
        }
      };
    }, [mode, autoScan, scanOnce]);

    // ── Permission / device states ──────────────────────────────
    if (!hasPermission) {
      return (
        <View style={styles.state}>
          <Icon name="camera" size={34} color={colors.accent} />
          <Text style={styles.stateTitle}>إذن الكاميرا مطلوب</Text>
          <Text style={styles.stateText}>
            التعرف البصري يحتاج الوصول للكاميرا — كل المعالجة تتم على جهازك
            فقط ولا تُرسل أي صورة للإنترنت.
          </Text>
          <TouchableOpacity style={styles.stateButton} onPress={requestPermission}>
            <Text style={styles.stateButtonText}>منح الإذن</Text>
          </TouchableOpacity>
        </View>
      );
    }

    if (device == null) {
      return (
        <View style={styles.state}>
          <ActivityIndicator color={colors.accent} size="large" />
          <Text style={styles.stateTitle}>جارٍ تهيئة الكاميرا…</Text>
        </View>
      );
    }

    return (
      <View style={styles.wrap}>
        <Camera
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          device={device}
          format={photoFormat}
          isActive={true}
          photo
          onError={error => {
            logDiag('camera', `خطأ الكاميرا: ${error.message}`, 'error');
            setStatusText('خطأ في الكاميرا — أعد فتح الشاشة');
          }}
        />

        {/* ROI frame */}
        <View style={styles.roi} pointerEvents="none">
          <View style={[styles.corner, styles.cTopRight]} />
          <View style={[styles.corner, styles.cBottomRight]} />
          <View style={[styles.corner, styles.cTopLeft]} />
          <View style={[styles.corner, styles.cBottomLeft]} />
        </View>

        {/* Match flash */}
        {flash ? <View style={styles.flash} pointerEvents="none" /> : null}

        {/* Status pill */}
        <View style={styles.statusWrap} pointerEvents="none">
          <View style={styles.statusPill}>
            {busy ? (
              <ActivityIndicator size="small" color={colors.accent} />
            ) : (
              <Icon
                name={mode === 'scan' ? 'scan' : 'camera'}
                size={14}
                color={colors.accent}
              />
            )}
            <Text style={styles.statusText} numberOfLines={1}>
              {statusText}
            </Text>
          </View>
        </View>
      </View>
    );
  },
);

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: '#050508',
    overflow: 'hidden',
  },
  roi: {
    ...StyleSheet.absoluteFillObject,
  },
  corner: {
    position: 'absolute',
    width: 38,
    height: 38,
    borderColor: colors.roi,
  },
  cTopRight: {
    top: '14%',
    right: '10%',
    borderTopWidth: 4,
    borderRightWidth: 4,
    borderTopRightRadius: 12,
  },
  cBottomRight: {
    bottom: '14%',
    right: '10%',
    borderBottomWidth: 4,
    borderRightWidth: 4,
    borderBottomRightRadius: 12,
  },
  cTopLeft: {
    top: '14%',
    left: '10%',
    borderTopWidth: 4,
    borderLeftWidth: 4,
    borderTopLeftRadius: 12,
  },
  cBottomLeft: {
    bottom: '14%',
    left: '10%',
    borderBottomWidth: 4,
    borderLeftWidth: 4,
    borderBottomLeftRadius: 12,
  },
  flash: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.flash,
  },
  statusWrap: {
    position: 'absolute',
    bottom: spacing.md,
    left: spacing.md,
    right: spacing.md,
    alignItems: 'center',
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.scrim,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: 8,
    maxWidth: '100%',
  },
  statusText: {
    color: colors.text,
    fontFamily: fonts.bold,
    fontSize: typography.small,
    flexShrink: 1,
  },
  state: {
    flex: 1,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.sm,
  },
  stateTitle: {
    color: colors.text,
    fontFamily: fonts.bold,
    fontSize: typography.body,
    marginTop: spacing.xs,
  },
  stateText: {
    color: colors.textDim,
    fontFamily: fonts.regular,
    fontSize: typography.caption,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: spacing.md,
  },
  stateButton: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: 13,
    paddingHorizontal: spacing.xxl,
  },
  stateButtonText: {
    color: colors.onAccent,
    fontFamily: fonts.bold,
    fontSize: typography.body,
  },
});
