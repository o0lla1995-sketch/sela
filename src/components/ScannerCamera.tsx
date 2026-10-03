/**
 * ScannerCamera — v4 on the hand-written native SelaCameraView.
 * ─────────────────────────────────────────────────────────────────
 * Camera history (why this file exists in this shape):
 *  v1 react-native-vision-camera frame-processor → black screen
 *     (worklets runtime missing).
 *  v2 vision-camera photo pipeline → black screen + freezes (format
 *     selection + takePhoto on several devices).
 *  v3 react-native-camera-kit → STILL black screen + full-app
 *     freeze: camera-kit created a NEW ML Kit client on EVERY frame
 *     (memory/CPU flood) and its capture() promise hung forever when
 *     the camera died, leaving the scanner dead until app restart.
 *  v4 our own CameraX view (SelaCameraView.kt): one ML Kit client,
 *     single 4:3 bind, analyzer paused during capture, native barcode
 *     dedupe, 6s capture watchdog. JS side adds hard timeouts on
 *     every native call + automatic camera rebind on fatal errors,
 *     so nothing can freeze or hang the flow again.
 *
 * Public API (unchanged since v3 — PosScreen/ProductForm untouched):
 *   <ScannerCamera mode="scan"|"capture" barcodeEnabled onBarcode
 *                   onMatch onScore autoScan height />
 *   ref.scanOnce()      → ScanResult | null
 *   ref.captureAngle(a) → { embedding, thumbnailPath }
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
  PermissionsAndroid,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  Vibration,
  View,
  findNodeHandle,
  requireNativeComponent,
  type NativeMethods,
} from 'react-native';
import {Icon} from './Icon';
import {useThemeColors} from '../core/theme';
import {
  AUTO_SCAN_INTERVAL_MS,
  BARCODE_DEDUPE_MS,
  CAPTURE_TIMEOUT_MS,
} from '../core/config';
import {VisionRecognitionService} from '../services/vision/VisionRecognitionService';
import {useCatalogStore} from '../stores/catalogStore';
import {useSettingsStore} from '../stores/settingsStore';
import {requirePlatformUtils} from '../native/nativeBridge';
import {logDiag} from '../core/diagnostics';
import type {AngleLabel} from '../core/types';
import {SelaCameraNative} from '../native/nativeBridge';

export interface ScanResult {
  productId: number;
  score: number;
}

export interface CaptureResult {
  embedding: Float32Array;
  thumbnailPath: string | null;
}

export interface ScannerCameraHandle {
  /** Triggers one visual recognition pass; resolves null when no match. */
  scanOnce: () => Promise<ScanResult | null>;
  /** Captures an enrollment photo: embedding + thumbnail. */
  captureAngle: (angle: AngleLabel) => Promise<CaptureResult>;
  /** Whether a scan cycle is currently running. */
  isBusy: () => boolean;
}

export type ScannerCameraMode = 'scan' | 'capture';

interface ScannerCameraProps {
  mode: ScannerCameraMode;
  /** Whether barcode scanning is active (from Settings → scannerMode). */
  barcodeEnabled?: boolean;
  /** scan mode: fires for every barcode read (already deduped natively). */
  onBarcode?: (code: string) => void;
  /** scan mode: fires for every confident visual match. */
  onMatch?: (result: ScanResult) => void;
  /** scan mode: fires for every completed visual pass, matched or not. */
  onScore?: (score: number | null) => void;
  /** scan mode: enable the automatic visual loop. */
  autoScan?: boolean;
  /** Compact height (POS sheet) vs tall (enrollment). */
  height?: number;
}

interface NativeCameraProps {
  barcodeEnabled: boolean;
  torch: boolean;
  permissionGranted: boolean;
  onReadCode?: (event: {nativeEvent: {codeStringValue: string}}) => void;
  onCameraError?: (event: {nativeEvent: {errorMessage: string}}) => void;
  onCameraReady?: (event: unknown) => void;
  style?: unknown;
}

const SelaCameraView =
  requireNativeComponent<NativeCameraProps>('SelaCameraView');

/** Rejects if a promise doesn't settle within ms — a hung native call
 *  can never freeze the scan loop again (the v3 killer). */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} — انتهت المهلة`));
    }, ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export const ScannerCamera = forwardRef<
  ScannerCameraHandle,
  ScannerCameraProps
>(function ScannerCamera(
  {
    mode,
    barcodeEnabled = false,
    onBarcode,
    onMatch,
    onScore,
    autoScan = false,
    height,
  },
  ref,
) {
  const c = useThemeColors();

  const [permission, setPermission] = useState<
    'unknown' | 'granted' | 'denied'
  >('unknown');
  const [camState, setCamState] = useState<'starting' | 'ready' | 'error'>(
    'starting',
  );
  /** Real native failure reason ("" when the JS watchdog fired instead). */
  const [nativeError, setNativeError] = useState<string>('');
  const [remountKey, setRemountKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState<string>(
    mode === 'capture'
      ? 'وجّه الكاميرا نحو المنتج'
      : barcodeEnabled
      ? 'باركود جاهز — وجّه الكاميرا نحو الملصق'
      : 'جاهز للمسح البصري',
  );
  const [flash, setFlash] = useState(false);
  const [torch, setTorch] = useState(false);

  const viewRef = useRef<
    (React.Component<NativeCameraProps> & Readonly<NativeMethods>) | null
  >(null);
  const busyRef = useRef(false);
  const disposedRef = useRef(false);
  const loopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastMatchRef = useRef<{productId: number; at: number} | null>(null);
  const lastBarcodeRef = useRef<{code: string; at: number} | null>(null);
  const readyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const threshold = useSettingsStore(state => state.settings.matchThreshold);
  const cooldownMs = useSettingsStore(
    state => state.settings.recognitionCooldownMs,
  );
  const embeddingsCount = useCatalogStore(state => state.embeddingsCount);

  const onBarcodeRef = useRef(onBarcode);
  onBarcodeRef.current = onBarcode;
  const onMatchRef = useRef(onMatch);
  onMatchRef.current = onMatch;
  const onScoreRef = useRef(onScore);
  onScoreRef.current = onScore;

  // ── Camera permission BEFORE mounting the native view. ──────
  useEffect(() => {
    let mounted = true;
    const ensurePermission = async () => {
      try {
        if (Platform.OS !== 'android') {
          setPermission('granted');
          return;
        }
        const already = await PermissionsAndroid.check(
          PermissionsAndroid.PERMISSIONS.CAMERA as never,
        );
        if (already) {
          if (mounted) setPermission('granted');
          return;
        }
        const result = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.CAMERA as never,
          {
            title: 'إذن الكاميرا',
            message:
              'sela يحتاج الكاميرا لمسح الباركود والتعرف البصري على المنتجات. كل المعالجة تتم على جهازك فقط.',
            buttonPositive: 'سماح',
            buttonNegative: 'لاحقاً',
          } as never,
        );
        if (!mounted) return;
        setPermission(
          result === PermissionsAndroid.RESULTS.GRANTED ? 'granted' : 'denied',
        );
      } catch (error) {
        logDiag(
          'camera',
          `تعذر طلب إذن الكاميرا: ${
            error instanceof Error ? error.message : String(error)
          }`,
          'warn',
        );
        if (mounted) setPermission('denied');
      }
    };
    void ensurePermission();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      if (loopTimerRef.current != null) {
        clearTimeout(loopTimerRef.current);
        loopTimerRef.current = null;
      }
      if (readyTimerRef.current != null) {
        clearTimeout(readyTimerRef.current);
        readyTimerRef.current = null;
      }
    };
  }, []);

  // ── Ready watchdog: if the native camera doesn't come up within
  //    8s (cold CameraX init + the v5.2 retry/fallback ladder can
  //    legitimately take a few seconds on budget hardware), show
  //    the retry overlay instead of a silent black box.
  useEffect(() => {
    if (permission !== 'granted') {
      return;
    }
    setCamState('starting');
    setNativeError('');
    if (readyTimerRef.current != null) {
      clearTimeout(readyTimerRef.current);
    }
    readyTimerRef.current = setTimeout(() => {
      setCamState(current => (current === 'starting' ? 'error' : current));
    }, 8000);
    return () => {
      if (readyTimerRef.current != null) {
        clearTimeout(readyTimerRef.current);
        readyTimerRef.current = null;
      }
    };
  }, [remountKey, permission]);

  const capturePhoto = useCallback(async (): Promise<string | null> => {
    const viewHandle = findNodeHandle(viewRef.current);
    if (viewHandle == null || SelaCameraNative == null) {
      setStatusText('الكاميرا غير جاهزة بعد');
      return null;
    }
    try {
      const path = await withTimeout(
        SelaCameraNative.capture(viewHandle),
        CAPTURE_TIMEOUT_MS,
        'التقاط الصورة',
      );
      if (!path) {
        setStatusText('تعذر الالتقاط — حاول مجدداً');
        return null;
      }
      return path;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logDiag('camera', `فشل التقاط الصورة: ${message}`, 'warn');
      if (message.includes('المهلة') || message.includes('تجمد')) {
        // Camera is dead — force a full rebind via remount.
        setCamState('error');
        setRemountKey(key => key + 1);
      }
      setStatusText('فشل الالتقاط — أعد المحاولة');
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

  // ── Visual recognition pass ──────────────────────────────────
  const scanOnce = useCallback(async (): Promise<ScanResult | null> => {
    if (busyRef.current) {
      return null;
    }
    if (camState !== 'ready') {
      setStatusText('انتظر جهوزية الكاميرا…');
      return null;
    }
    const modelInfo = VisionRecognitionService.getInfo();
    if (!modelInfo.loaded) {
      setStatusText('نموذج التعرف غير محمّل — استخدم اللمس أو الباركود');
      return null;
    }
    if (embeddingsCount === 0) {
      setStatusText('لا توجد بصمات محفوظة — سجّل منتجاتك أولاً');
      onScoreRef.current?.(null);
      return null;
    }
    busyRef.current = true;
    setBusy(true);
    setStatusText('جارٍ المسح البصري…');
    try {
      const path = await capturePhoto();
      if (path == null) {
        return null;
      }
      try {
        const vector = await VisionRecognitionService.embedPhoto(path);
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
        // In "both" mode keep the barcode hint visible between visual
        // passes — a "no match" line would hide it every ~1s.
        setStatusText(
          barcodeEnabled
            ? `أقرب تشابه ${(best.score * 100).toFixed(0)}% — الباركود يعمل`
            : `أقرب تشابه ${(best.score * 100).toFixed(0)}% — قرّب الكاميرا أكثر`,
        );
        return null;
      } finally {
        await deleteQuietly(path);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'خطأ غير معروف';
      // E_CAMERA_NOT_READY / busy in barcode mode are transient (the
      // analyzer frame lands a beat later) — keep the barcode hint
      // instead of scaring the merchant with an error line.
      if (barcodeEnabled && message.includes('غير جاهزة')) {
        setStatusText('باركود جاهز — وجّه الكاميرا نحو الملصق');
      } else {
        setStatusText(`فشل المسح: ${message}`);
        logDiag('camera', `فشل المسح البصري: ${message}`, 'warn');
      }
      return null;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [
    barcodeEnabled,
    beep,
    camState,
    capturePhoto,
    cooldownMs,
    deleteQuietly,
    embeddingsCount,
    threshold,
  ]);

  // ── Enrollment capture ───────────────────────────────────────
  const captureAngle = useCallback(
    async (angle: AngleLabel): Promise<CaptureResult> => {
      if (busyRef.current) {
        throw new Error('عملية التقاط أخرى قيد التنفيذ');
      }
      if (camState !== 'ready') {
        throw new Error('الكاميرا غير جاهزة — انتظر أو أعد المحاولة');
      }
      busyRef.current = true;
      setBusy(true);
      setStatusText(
        `جارٍ التقاط الزاوية ${
          angle === 'front'
            ? 'الأمامية'
            : angle === 'back'
            ? 'الخلفية'
            : 'الجانبية'
        }…`,
      );
      try {
        const path = await capturePhoto();
        if (path == null) {
          throw new Error('تعذر التقاط الصورة — حاول مرة أخرى');
        }
        const embedding = await VisionRecognitionService.embedPhoto(path);
        const thumbnailPath = await VisionRecognitionService.saveThumbnail(
          path,
        );
        await deleteQuietly(path);
        setStatusText('تم حفظ البصمة بنجاح');
        beep();
        Vibration.vibrate(30);
        return {embedding, thumbnailPath};
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
    [beep, camState, deleteQuietly, capturePhoto],
  );

  useImperativeHandle(ref, () => ({
    scanOnce: async () => scanOnce(),
    captureAngle: async (angle: AngleLabel) => captureAngle(angle),
    isBusy: () => busyRef.current,
  }));

  // ── Barcode handler (native dedupe + JS-side guard) ──────────
  const handleReadCode = useCallback(
    (event: {nativeEvent: {codeStringValue: string}}) => {
      const code = event.nativeEvent?.codeStringValue;
      if (!code) return;
      const now = Date.now();
      const last = lastBarcodeRef.current;
      if (
        last != null &&
        last.code === code &&
        now - last.at < BARCODE_DEDUPE_MS
      ) {
        return;
      }
      lastBarcodeRef.current = {code, at: now};
      setFlash(true);
      setTimeout(() => setFlash(false), 180);
      Vibration.vibrate(35);
      beep();
      setStatusText(`باركود: ${code}`);
      onBarcodeRef.current?.(code);
    },
    [beep],
  );

  // ── Auto visual-scan loop ────────────────────────────────────
  // Skips the pass entirely while the camera isn't ready or no
  // product embeddings exist yet — no wasted inference, no freeze.
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
    loopTimerRef.current = setTimeout(tick, 500);
    return () => {
      stopped = true;
      if (loopTimerRef.current != null) {
        clearTimeout(loopTimerRef.current);
        loopTimerRef.current = null;
      }
    };
  }, [mode, autoScan, scanOnce]);

  // ── Permission / error states ────────────────────────────────
  if (permission === 'unknown') {
    return (
      <View style={[styles.state, {backgroundColor: '#0B0B10'}]}>
        <ActivityIndicator color={c.accent} size="large" />
        <Text style={[styles.stateTitle, {color: '#F4F4F5'}]}>
          جارٍ تجهيز الكاميرا…
        </Text>
      </View>
    );
  }

  if (permission === 'denied') {
    return (
      <View style={[styles.state, {backgroundColor: '#0B0B10'}]}>
        <Icon name="camera" size={34} color={c.accent} />
        <Text style={[styles.stateTitle, {color: '#F4F4F5'}]}>
          إذن الكاميرا مطلوب
        </Text>
        <Text style={[styles.stateText, {color: '#A1A1AA'}]}>
          المسح بالباركود والتعرف البصري يحتاجان الوصول للكاميرا — كل المعالجة
          تتم على جهازك فقط ولا تُرسل أي صورة للإنترنت.
        </Text>
        <TouchableOpacity
          style={styles.stateButton}
          onPress={async () => {
            try {
              const result = await PermissionsAndroid.request(
                PermissionsAndroid.PERMISSIONS.CAMERA as never,
              );
              setPermission(
                result === PermissionsAndroid.RESULTS.GRANTED
                  ? 'granted'
                  : 'denied',
              );
            } catch {
              setPermission('denied');
            }
          }}>
          <Text style={styles.stateButtonText}>منح الإذن</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={[styles.wrap, height != null ? {height} : null]}>
      <SelaCameraView
        key={remountKey}
        ref={viewRef}
        style={StyleSheet.absoluteFill}
        barcodeEnabled={barcodeEnabled}
        torch={torch}
        permissionGranted={permission === 'granted'}
        onReadCode={handleReadCode}
        onCameraError={(event: {nativeEvent: {errorMessage: string}}) => {
          const message = event.nativeEvent?.errorMessage ?? 'خطأ غير معروف';
          logDiag('camera', `خطأ الكاميرا: ${message}`, 'error');
          setNativeError(message);
          setCamState('error');
          setStatusText(message);
        }}
        onCameraReady={() => {
          setCamState('ready');
          if (mode === 'capture') {
            setStatusText('وجّه الكاميرا نحو المنتج');
          }
        }}
      />

      {/* Camera error overlay + one-tap full rebind */}
      {camState === 'error' ? (
        <View style={styles.errorOverlay}>
          <Icon name="camera" size={30} color={c.accent} />
          <Text style={styles.errorTitle}>تعذر تشغيل الكاميرا</Text>
          <Text style={styles.errorText}>
            {nativeError
              ? `السبب من الجهاز: ${nativeError}`
              : 'لم تجهز الكاميرا خلال المهلة.'}
            {'\n'}إعادة المحاولة تعيد تشغيلها من الصفر — إن تكرر الخطأ أغلق
            التطبيقات الأخرى التي تستخدم الكاميرا.
          </Text>
          <TouchableOpacity
            style={styles.retryButton}
            onPress={() => {
              setRemountKey(key => key + 1);
              setStatusText('جارٍ إعادة تشغيل الكاميرا…');
            }}
            activeOpacity={0.85}>
            <Icon name="refresh" size={16} color="#FFFFFF" />
            <Text style={styles.retryText}>إعادة المحاولة</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {/* ROI frame */}
      <View style={styles.roi} pointerEvents="none">
        <View style={[styles.corner, styles.cTopRight]} />
        <View style={[styles.corner, styles.cBottomRight]} />
        <View style={[styles.corner, styles.cTopLeft]} />
        <View style={[styles.corner, styles.cBottomLeft]} />
      </View>

      {/* Match flash */}
      {flash ? <View style={styles.flash} pointerEvents="none" /> : null}

      {/* Torch toggle */}
      <TouchableOpacity
        style={styles.torchButton}
        onPress={() => setTorch(value => !value)}
        activeOpacity={0.8}>
        <Icon name="flash" size={17} color={torch ? c.accent : '#E4E4E7'} />
      </TouchableOpacity>

      {/* Status pill */}
      <View style={styles.statusWrap} pointerEvents="none">
        <View style={styles.statusPill}>
          {busy ? (
            <ActivityIndicator size="small" color={c.accent} />
          ) : (
            <Icon
              name={
                barcodeEnabled && mode === 'scan'
                  ? 'barcode'
                  : mode === 'scan'
                  ? 'scan'
                  : 'camera'
              }
              size={14}
              color={c.accent}
            />
          )}
          <Text style={styles.statusText} numberOfLines={1}>
            {statusText}
          </Text>
        </View>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: '#0B0B10',
    overflow: 'hidden',
  },
  roi: {
    ...StyleSheet.absoluteFillObject,
  },
  corner: {
    position: 'absolute',
    width: 38,
    height: 38,
    borderColor: '#F97316',
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
    backgroundColor: 'rgba(34, 197, 94, 0.24)',
  },
  torchButton: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(14, 14, 18, 0.72)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusWrap: {
    position: 'absolute',
    bottom: 10,
    left: 12,
    right: 12,
    alignItems: 'center',
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(14, 14, 18, 0.84)',
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 8,
    maxWidth: '100%',
  },
  statusText: {
    color: '#F4F4F5',
    fontFamily: 'Tajawal-Bold',
    fontSize: 12,
    flexShrink: 1,
  },
  state: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 8,
  },
  stateTitle: {
    fontFamily: 'Tajawal-Bold',
    fontSize: 15.5,
    marginTop: 4,
  },
  stateText: {
    fontFamily: 'Tajawal-Regular',
    fontSize: 13.5,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 12,
  },
  stateButton: {
    backgroundColor: '#F97316',
    borderRadius: 12,
    paddingVertical: 13,
    paddingHorizontal: 32,
  },
  stateButtonText: {
    color: '#FFFFFF',
    fontFamily: 'Tajawal-Bold',
    fontSize: 15.5,
  },
  errorOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(11, 11, 16, 0.94)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 6,
  },
  errorTitle: {
    fontFamily: 'Tajawal-Bold',
    fontSize: 16,
    color: '#F4F4F5',
    marginTop: 6,
  },
  errorText: {
    fontFamily: 'Tajawal-Regular',
    fontSize: 13,
    color: '#A1A1AA',
    textAlign: 'center',
    lineHeight: 21,
    marginBottom: 10,
  },
  retryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#F97316',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 28,
  },
  retryText: {
    color: '#FFFFFF',
    fontFamily: 'Tajawal-Bold',
    fontSize: 14.5,
  },
});
