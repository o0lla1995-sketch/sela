package com.sela.native_modules.camera

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.SparseArray
import android.view.Surface
import android.widget.FrameLayout
import androidx.camera.core.AspectRatio
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.UseCase
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.ThemedReactContext
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.common.InputImage
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * SelaCameraView
 * ─────────────────────────────────────────────────────────────────
 * v5 of the camera stack — the one that actually renders.
 *
 * Field history on the target device (every stack showed a BLACK
 * preview even with permission granted):
 *  v1 vision-camera frame-processor  → black (worklets missing)
 *  v2 vision-camera photo pipeline   → black + freeze
 *  v3 react-native-camera-kit        → black + freeze (ML Kit flood)
 *  v4 our CameraX view, PreviewView PERFORMANCE → STILL black.
 *
 * v4's black screen had two plausible killers, both removed now:
 *
 *  1. PreviewView PERFORMANCE mode renders through a **SurfaceView**,
 *     a separate compositor layer. On some OEM Android builds (cheap
 *     camera HALs / aggressive compositor tweaks) the surface simply
 *     never composites inside a React view tree — black forever.
 *     → v5 uses **COMPATIBLE mode (TextureView)**: the preview is a
 *       normal view in the hierarchy, immune to compositor quirks.
 *
 *  2. Preview + ImageCapture + ImageAnalysis bound TOGETHER = three
 *     concurrent streams. Budget camera HALs often cap at two usable
 *     streams and quietly fail to produce preview frames.
 *     → v5 binds exactly TWO use cases: Preview + ImageCapture when
 *       capturing/visual mode, Preview + ImageAnalysis when barcode
 *       mode is on. Switching modes performs a controlled rebind.
 *
 *  3. v4 also cast the current activity to AppCompatActivity before
 *     binding — a hidden coupling. v5 owns a tiny LifecycleOwner
 *     driven by window attach/detach instead (works inside Modals
 *     and any host activity type).
 *
 * v5.1 — "both mode" capture without rebinds:
 *   v5 bound Preview + ImageCapture OR Preview + ImageAnalysis.
 *   In scanner mode "كلاهما" (barcode + visual) the JS scan loop
 *   called capture() while only ImageAnalysis was bound →
 *   E_CAMERA_NOT_READY → visual auto-scan silently broken.
 *   v5.1: when capture() arrives in barcode mode, the analyzer's
 *   NEXT frame is converted YUV→NV21→JPEG on the spot (no camera
 *   rebind, no third stream, no preview glitch — barcode keeps
 *   running between passes). Pixel rotation is intentionally NOT
 *   applied: the embedding decoder ignores EXIF, and ImageCapture
 *   JPEGs store unrotated pixels too — both paths therefore feed
 *   the model identically-oriented pixels, keeping cosine
 *   similarity consistent between enrollment and scanning.
 *
 * Kept from v4: ONE ML Kit client per view, analyzer paused during
 * capture, single-flight capture with a 6s watchdog, native barcode
 * dedupe, JS-recoverable rebind.
 */
class SelaCameraView(
    private val reactContext: ThemedReactContext,
) : FrameLayout(reactContext) {

    companion object {
        /** Live view registry keyed by RN view tag (module looks up here). */
        private val instances = SparseArray<SelaCameraView>()

        fun find(tag: Int): SelaCameraView? = synchronized(instances) { instances.get(tag) }
    }

    /**
     * Minimal lifecycle the camera binds to. Created per bind cycle:
     * INITIALIZED → RESUMED on bind, DESTROYED on release. Tying the
     * camera to the VIEW (not the activity) means unbinding always
     * happens when this view goes away — no leaked cameras from
     * modals, tabs or navigation transitions.
     */
    private class CameraHost : LifecycleOwner {
        private val registry = LifecycleRegistry(this)
        override val lifecycle: Lifecycle get() = registry

        fun resume() {
            registry.currentState = Lifecycle.State.RESUMED
        }

        fun destroy() {
            try {
                registry.currentState = Lifecycle.State.DESTROYED
            } catch (_: Exception) {
                // Double-destroy is harmless.
            }
        }
    }

    private val mainHandler = Handler(Looper.getMainLooper())

    private val previewView = PreviewView(context).apply {
        // COMPATIBLE = TextureView — see class docs (the v4 black screen).
        implementationMode = PreviewView.ImplementationMode.COMPATIBLE
        scaleType = PreviewView.ScaleType.FILL_CENTER
    }

    // Camera state
    private var cameraProvider: ProcessCameraProvider? = null
    private var camera: androidx.camera.core.Camera? = null
    private var preview: Preview? = null
    private var imageCapture: ImageCapture? = null
    private var imageAnalysis: ImageAnalysis? = null
    private var barcodeScanner: BarcodeScanner? = null
    private var host: CameraHost? = null
    private var analysisExecutor: ExecutorService? = null

    // Props
    private var propBarcodeEnabled = false
    private var propTorch = false
    private var propPermissionGranted = false

    // Lifecycle flags
    private val attached = AtomicBoolean(false)
    private val bound = AtomicBoolean(false)
    private val binding = AtomicBoolean(false)
    private val deadCamera = AtomicBoolean(false)
    private val analyzing = AtomicBoolean(false)
    private val captureInFlight = AtomicBoolean(false)

    // Barcode dedupe
    private var lastCode: String? = null
    private var lastCodeAt = 0L

    // ── Frame-grab snapshot state (barcode-mode capture, v5.1) ──
    private val wantSnapshot = AtomicBoolean(false)
    @Volatile private var snapshotFile: File? = null
    @Volatile private var snapshotPromise: Promise? = null
    private val snapshotSettled = AtomicBoolean(true)
    private var snapshotWatchdog: Runnable? = null

    init {
        previewView.layoutParams = LayoutParams(
            LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT
        )
        addView(previewView)
    }

    // ── React props (called from the UI manager thread) ─────────

    fun setBarcodeEnabledProp(enabled: Boolean) {
        if (propBarcodeEnabled == enabled) return
        propBarcodeEnabled = enabled
        mainHandler.post {
            if (bound.get()) {
                // The use-case set changes with the mode → controlled rebind.
                rebindNow()
            } else {
                ensureBound()
            }
        }
    }

    fun setTorchProp(enabled: Boolean) {
        if (propTorch == enabled) return
        propTorch = enabled
        mainHandler.post {
            try {
                camera?.cameraControl?.enableTorch(enabled)
            } catch (_: Exception) {
                // Torch is best-effort on devices without a flash unit.
            }
        }
    }

    fun setPermissionGrantedProp(granted: Boolean) {
        if (propPermissionGranted == granted) return
        propPermissionGranted = granted
        if (granted) mainHandler.post { ensureBound() }
    }

    // ── Lifecycle ───────────────────────────────────────────────

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        attached.set(true)
        synchronized(instances) { instances.put(id, this) }
        mainHandler.post { ensureBound() }
    }

    override fun onDetachedFromWindow() {
        attached.set(false)
        synchronized(instances) { instances.remove(id) }
        mainHandler.post { releaseCamera() }
        super.onDetachedFromWindow()
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        super.onLayout(changed, l, t, r, b)
        if (!bound.get() && !binding.get() && attached.get()) {
            mainHandler.post { ensureBound() }
        }
    }

    private fun hasCameraPermission(): Boolean {
        if (propPermissionGranted) return true
        return ContextCompat.checkSelfPermission(
            context, Manifest.permission.CAMERA
        ) == PackageManager.PERMISSION_GRANTED
    }

    private fun executor(): ExecutorService {
        var e = analysisExecutor
        if (e == null || e.isShutdown) {
            e = Executors.newSingleThreadExecutor()
            analysisExecutor = e
        }
        return e
    }

    /**
     * Binds Preview + exactly ONE capture use case (see class docs):
     *  - barcode mode  → Preview + ImageAnalysis (ML Kit reads frames)
     *  - visual/camera → Preview + ImageCapture  (still photos)
     * Idempotent: safe to call from attach, layout and prop changes.
     */
    private fun ensureBound() {
        if (binding.get() || bound.get() || deadCamera.get()) return
        if (!attached.get()) return
        if (width == 0 || height == 0) return // wait for layout
        if (!hasCameraPermission()) return    // wait for permission prop
        if (!previewView.isAttachedToWindow) return

        binding.set(true)
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            if (!attached.get()) {
                // View went away while the provider spun up.
                binding.set(false)
                return@addListener
            }
            try {
                val provider = future.get()
                cameraProvider = provider

                val owner = CameraHost()
                owner.resume()
                host = owner

                val rotation = try {
                    previewView.display?.rotation ?: Surface.ROTATION_0
                } catch (_: Exception) {
                    Surface.ROTATION_0
                }

                val newPreview = Preview.Builder()
                    .setTargetAspectRatio(AspectRatio.RATIO_4_3)
                    .setTargetRotation(rotation)
                    .build()

                val useCases = mutableListOf<UseCase>(newPreview)

                if (propBarcodeEnabled) {
                    val newAnalysis = ImageAnalysis.Builder()
                        .setTargetAspectRatio(AspectRatio.RATIO_4_3)
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .setTargetRotation(rotation)
                        .build()
                    imageAnalysis = newAnalysis
                    imageCapture = null
                    useCases.add(newAnalysis)
                } else {
                    val newCapture = ImageCapture.Builder()
                        .setTargetAspectRatio(AspectRatio.RATIO_4_3)
                        .setTargetRotation(rotation)
                        .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                        .setJpegQuality(88)
                        .build()
                    imageCapture = newCapture
                    imageAnalysis = null
                    useCases.add(newCapture)
                }

                preview = newPreview

                provider.unbindAll()
                camera = provider.bindToLifecycle(
                    owner,
                    CameraSelector.DEFAULT_BACK_CAMERA,
                    *useCases.toTypedArray()
                )

                newPreview.setSurfaceProvider(previewView.surfaceProvider)

                // Restore torch state across (re)binds.
                if (propTorch) {
                    camera?.cameraControl?.enableTorch(true)
                }

                bound.set(true)
                binding.set(false)
                if (propBarcodeEnabled) applyAnalyzer()
                dispatchReady()
            } catch (error: Exception) {
                binding.set(false)
                bound.set(false)
                host?.destroy()
                host = null
                dispatchError("فشل تشغيل الكاميرا: ${error.message ?: "خطأ غير معروف"}")
            }
        }, ContextCompat.getMainExecutor(context))
    }

    /** Starts the ML Kit analyzer on the bound ImageAnalysis. */
    private fun applyAnalyzer() {
        val analysis = imageAnalysis ?: return
        if (!bound.get()) return
        val scanner = obtainScanner()
        if (scanner == null) {
            dispatchError("تعذر تهيئة ماسح الباركود")
            return
        }
        analysis.setAnalyzer(executor()) { image ->
            val mediaImage = try {
                image.image
            } catch (_: Exception) {
                null
            }
            // ── Pending visual capture? Grab THIS frame as JPEG ──
            // (runs before ML Kit so the JS scan pass resolves fast;
            // barcode analysis simply skips this single frame.)
            if (wantSnapshot.get()) {
                handleSnapshotFrame(image)
                return@setAnalyzer
            }
            if (mediaImage == null || analyzing.get()) {
                image.close()
                return@setAnalyzer
            }
            analyzing.set(true)
            try {
                val input = InputImage.fromMediaImage(
                    mediaImage, image.imageInfo.rotationDegrees
                )
                scanner.process(input)
                    .addOnSuccessListener { barcodes ->
                        val raw = barcodes.firstOrNull()?.rawValue
                        if (!raw.isNullOrEmpty()) {
                            maybeEmitBarcode(raw)
                        }
                    }
                    .addOnCompleteListener {
                        analyzing.set(false)
                        image.close()
                    }
            } catch (_: Exception) {
                analyzing.set(false)
                image.close()
            }
        }
    }

    /** ONE scanner client for the whole view lifetime (camera-kit's fatal bug). */
    private fun obtainScanner(): BarcodeScanner? {
        if (barcodeScanner != null) return barcodeScanner
        return try {
            barcodeScanner = BarcodeScanning.getClient()
            barcodeScanner
        } catch (_: Exception) {
            null
        }
    }

    private fun maybeEmitBarcode(code: String) {
        val now = SystemClock.elapsedRealtime()
        if (code == lastCode && now - lastCodeAt < 1200) return
        lastCode = code
        lastCodeAt = now
        val surfaceId = UIManagerHelper.getSurfaceId(reactContext)
        val dispatcher = UIManagerHelper.getEventDispatcherForReactTag(reactContext, id)
        if (surfaceId != null && dispatcher != null) {
            dispatcher.dispatchEvent(CameraReadCodeEvent(surfaceId, id, code))
        }
    }

    // ── Capture (called via SelaCameraModule) ───────────────────

    /**
     * Takes one photo to a cache file and resolves with its absolute path.
     * Single-flight + 6s watchdog: a dead camera REJECTS instead of
     * hanging the JS pipeline forever (the v3 freeze).
     *
     * Two paths:
     *  1. ImageCapture bound (visual / enrollment mode) → takePicture.
     *  2. Only ImageAnalysis bound (barcode / both mode) → frame-grab:
     *     the analyzer's next frame is saved as JPEG (see v5.1 notes).
     */
    fun capture(promise: Promise) {
        mainHandler.post {
            if (!bound.get()) {
                promise.reject("E_CAMERA_NOT_READY", "الكاميرا غير جاهزة — أعد المحاولة", null)
                return@post
            }
            if (imageCapture == null) {
                startFrameGrab(promise)
                return@post
            }
            if (!captureInFlight.compareAndSet(false, true)) {
                promise.reject("E_CAPTURE_BUSY", "التقاط آخر قيد التنفيذ", null)
                return@post
            }

            val outFile = File(
                context.cacheDir,
                "sela_capture_${System.currentTimeMillis()}.jpg"
            )
            var settled = false

            // Watchdog: reject after 6s even if CameraX stays silent.
            val watchdog = Runnable {
                if (settled) return@Runnable
                settled = true
                captureInFlight.set(false)
                deadCamera.set(true)
                dispatchError("تجمد الالتقاط — سيُعاد تشغيل الكاميرا")
                promise.reject("E_CAPTURE_TIMEOUT", "انتهت مهلة الالتقاط", null)
            }
            mainHandler.postDelayed(watchdog, 6000)

            val outputOptions = ImageCapture.OutputFileOptions.Builder(outFile).build()
            imageCapture?.takePicture(
                outputOptions,
                ContextCompat.getMainExecutor(context),
                object : ImageCapture.OnImageSavedCallback {
                    override fun onError(exception: ImageCaptureException) {
                        if (settled) return
                        settled = true
                        mainHandler.removeCallbacks(watchdog)
                        captureInFlight.set(false)
                        promise.reject(
                            "E_CAPTURE_FAILED",
                            "فشل الالتقاط: ${exception.message ?: "خطأ غير معروف"}",
                            null
                        )
                    }

                    override fun onImageSaved(results: ImageCapture.OutputFileResults) {
                        if (settled) return
                        settled = true
                        mainHandler.removeCallbacks(watchdog)
                        captureInFlight.set(false)
                        promise.resolve(outFile.absolutePath)
                    }
                }
            )
        }
    }

    // ── Frame-grab capture (barcode / "both" mode, v5.1) ───────

    /** Arms the analyzer to save its next frame as JPEG. */
    private fun startFrameGrab(promise: Promise) {
        if (imageAnalysis == null) {
            promise.reject("E_CAMERA_NOT_READY", "الكاميرا غير جاهزة — أعد المحاولة", null)
            return
        }
        // Prepare everything BEFORE arming wantSnapshot — the volatile
        // CAS below publishes these writes to the analysis thread.
        val outFile = File(
            context.cacheDir,
            "sela_snap_${System.currentTimeMillis()}.jpg"
        )
        snapshotFile = outFile
        snapshotPromise = promise
        snapshotSettled.set(false)
        if (!wantSnapshot.compareAndSet(false, true)) {
            snapshotSettled.set(true)
            snapshotPromise = null
            snapshotFile = null
            promise.reject("E_CAPTURE_BUSY", "التقاط آخر قيد التنفيذ", null)
            return
        }

        // Same watchdog contract as takePicture: a camera that stops
        // producing frames rejects (JS remounts → fresh bind).
        val watchdog = Runnable {
            if (snapshotSettled.compareAndSet(false, true)) {
                wantSnapshot.set(false)
                val pending = snapshotPromise
                snapshotPromise = null
                snapshotFile = null
                deadCamera.set(true)
                dispatchError("تجمد الالتقاط — سيُعاد تشغيل الكاميرا")
                pending?.reject("E_CAPTURE_TIMEOUT", "انتهت مهلة الالتقاط", null)
            }
        }
        snapshotWatchdog = watchdog
        mainHandler.postDelayed(watchdog, 6000)
    }

    /**
     * Analyzer callback: converts the incoming ImageProxy to a JPEG
     * file and resolves the pending capture promise. Runs on the
     * single analysis thread — a 640×480 conversion is a few ms.
     */
    private fun handleSnapshotFrame(image: ImageProxy) {
        val file = snapshotFile
        val ok = try {
            file != null && imageProxyToJpeg(image, file)
        } catch (_: Exception) {
            false
        } finally {
            image.close()
        }
        if (ok && file != null) {
            finishSnapshot(file.absolutePath, null)
        } else {
            finishSnapshot(null, "تعذر تحويل الإطار إلى صورة")
            file?.delete()
        }
    }

    private fun finishSnapshot(path: String?, error: String?) {
        if (!snapshotSettled.compareAndSet(false, true)) return
        wantSnapshot.set(false)
        val pending = snapshotPromise
        snapshotPromise = null
        snapshotFile = null
        snapshotWatchdog?.let { mainHandler.removeCallbacks(it) }
        snapshotWatchdog = null
        if (pending != null) {
            if (path != null) {
                pending.resolve(path)
            } else {
                pending.reject("E_SNAPSHOT_FAILED", error ?: "فشل الالتقاط", null)
            }
        }
    }

    /** ImageProxy (YUV_420_888) → NV21 → JPEG file, no rotation (see v5.1 notes). */
    private fun imageProxyToJpeg(image: ImageProxy, outFile: File): Boolean {
        val nv21 = yuv420ToNv21(image)
        val yuv = YuvImage(nv21, ImageFormat.NV21, image.width, image.height, null)
        FileOutputStream(outFile).use { out ->
            yuv.compressToJpeg(
                Rect(0, 0, image.width, image.height), 88, out
            )
        }
        return outFile.exists() && outFile.length() > 0
    }

    /** Classic YUV_420_888 → NV21 with row/pixel-stride padding handling. */
    private fun yuv420ToNv21(image: ImageProxy): ByteArray {
        val width = image.width
        val height = image.height
        val ySize = width * height
        val nv21 = ByteArray(ySize + 2 * (ySize / 4))

        // Y plane — copy row by row to skip rowStride padding.
        val yPlane = image.planes[0]
        val yBuffer = yPlane.buffer.duplicate()
        for (row in 0 until height) {
            yBuffer.position(row * yPlane.rowStride)
            yBuffer.get(nv21, row * width, width)
        }

        // Interleave V then U (NV21) from the chroma planes.
        val uPlane = image.planes[1]
        val vPlane = image.planes[2]
        val uBuffer = uPlane.buffer.duplicate()
        val vBuffer = vPlane.buffer.duplicate()
        var offset = ySize
        for (row in 0 until height / 2) {
            for (col in 0 until width / 2) {
                nv21[offset++] = vBuffer.get(row * vPlane.rowStride + col * vPlane.pixelStride)
                nv21[offset++] = uBuffer.get(row * uPlane.rowStride + col * uPlane.pixelStride)
            }
        }
        return nv21
    }

    /** Full teardown + fresh bind (used by the JS retry button). */
    fun rebind(promise: Promise) {
        mainHandler.post {
            rebindNow()
            promise.resolve(true)
        }
    }

    private fun rebindNow() {
        releaseCamera()
        deadCamera.set(false)
        lastCode = null
        lastCodeAt = 0L
        ensureBound()
    }

    private fun releaseCamera() {
        // Never leave a pending frame-grab promise hanging on teardown.
        finishSnapshot(null, "أُغلق ماسح الكاميرا")
        try {
            imageAnalysis?.clearAnalyzer()
            cameraProvider?.unbindAll()
        } catch (_: Exception) {
            // Unbind during teardown is best-effort.
        }
        host?.destroy()
        host = null
        camera = null
        preview = null
        imageCapture = null
        imageAnalysis = null
        bound.set(false)
        binding.set(false)
        try {
            barcodeScanner?.close()
        } catch (_: Exception) {
        }
        barcodeScanner = null
    }

    // ── Events ──────────────────────────────────────────────────

    private fun dispatchReady() {
        val surfaceId = UIManagerHelper.getSurfaceId(reactContext)
        val dispatcher = UIManagerHelper.getEventDispatcherForReactTag(reactContext, id)
        if (surfaceId != null && dispatcher != null) {
            dispatcher.dispatchEvent(CameraReadyEvent(surfaceId, id))
        }
    }

    private fun dispatchError(message: String) {
        val surfaceId = UIManagerHelper.getSurfaceId(reactContext)
        val dispatcher = UIManagerHelper.getEventDispatcherForReactTag(reactContext, id)
        if (surfaceId != null && dispatcher != null) {
            dispatcher.dispatchEvent(CameraErrorEvent(surfaceId, id, message))
        }
    }

    override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
        super.onWindowFocusChanged(hasWindowFocus)
        // After returning from permission dialogs etc., retry binding.
        if (hasWindowFocus && !bound.get() && !deadCamera.get()) {
            mainHandler.post { ensureBound() }
        }
    }
}
