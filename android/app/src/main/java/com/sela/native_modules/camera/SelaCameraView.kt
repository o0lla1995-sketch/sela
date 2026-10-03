package com.sela.native_modules.camera

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.SparseArray
import android.view.Surface
import android.view.View
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
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.WritableMap
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
 * SelaCameraView — v7.
 * ─────────────────────────────────────────────────────────────────
 * What changed in v7 (and why — see SelaCameraModule for the full
 * story of the five failed generations):
 *
 *  • ALL state travels through the MODULE event channel
 *    (RCTDeviceEventEmitter). The old custom view events
 *    (topCameraReady/topCameraError/topReadCode dispatched via
 *    UIManagerHelper) could be silently dropped by the Fabric
 *    interop layer inside a <Modal> — the camera was live while JS
 *    showed "تعذر تشغيل الكاميرا". Gone.
 *
 *  • stateSnapshot() — JS polls getStatus(viewTag) every second as
 *    a SECOND source of truth. bound + previewStreamState == LIVE
 *    means the camera truly works, regardless of any lost event.
 *
 *  • Single-instance coordinator — the module force-releases the
 *    previous camera view before a new one binds. No two concurrent
 *    back-camera sessions ever again (budget HALs kill both).
 *
 *  • onMeasure hardening — if the Fabric interop layout pass hands
 *    us an AT_MOST/UNSPECIFIED spec (the "camera renders small /
 *    at the bottom of the modal" bug), we expand to the FULL size
 *    the parent offered instead of collapsing to wrap-content.
 *
 *  • Preview stream state — "ready" now means CameraX says frames
 *    are actually flowing (StreamState.LIVE), not just "bind call
 *    returned".
 *
 * Kept from v5/v6 (proven in the field): TextureView COMPATIBLE
 * preview, max TWO use cases per bind, bind failure ladder (retry
 * 600ms → preview-only fallback → real error with the exception
 * class), ONE ML Kit client per view, native barcode dedupe,
 * single-flight capture with 6s watchdogs, frame-grab capture in
 * barcode mode without a rebind.
 */
class SelaCameraView(
    private val reactContext: ThemedReactContext,
) : FrameLayout(reactContext) {

    companion object {
        /** Live view registry keyed by Android view id. */
        private val instances = SparseArray<SelaCameraView>()

        fun find(tag: Int): SelaCameraView? = synchronized(instances) { instances.get(tag) }
    }

    /**
     * Minimal lifecycle the camera binds to — tied to the VIEW, not
     * the activity: unbinding always happens when this view goes
     * away (modals, tabs, navigation transitions).
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

    /** True once CameraX reports frames actually flowing. */
    private val previewLive = AtomicBoolean(false)

    /** The last real bind/capture failure — surfaced to JS polls. */
    @Volatile private var lastBindError: String = ""

    /** Set while the module coordinator force-replaces this view. */
    private val replaced = AtomicBoolean(false)

    /** True while the diagnostics self-test owns this instance. */
    private val diagnosticsMode = AtomicBoolean(false)

    // Barcode dedupe
    private var lastCode: String? = null
    private var lastCodeAt = 0L

    // ── Frame-grab snapshot state (barcode-mode capture) ──
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
        // The preview stream state is the ground truth for "live"
        // (camera-view 1.3.4 exposes it as LiveData; observeForever
        // MUST run on the main thread — view construction can happen
        // on a React manager thread).
        mainHandler.post {
            try {
                previewView.previewStreamState.observeForever { state ->
                    previewLive.set(state == PreviewView.StreamState.LIVE)
                }
            } catch (_: Exception) {
                // Non-fatal — bound-flag polling still covers us.
            }
        }
    }

    // ── Layout hardening ────────────────────────────────────────
    //
    // Under the Fabric interop layer the measurement spec handed to
    // a custom view can arrive as AT_MOST instead of EXACTLY (seen
    // inside Modals) — a plain FrameLayout then collapses toward
    // wrap-content and the camera renders as a shrunken strip at the
    // bottom of the modal. We force the LARGEST size the parent was
    // willing to give us, exactly.

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val widthMode = View.MeasureSpec.getMode(widthMeasureSpec)
        val widthSize = View.MeasureSpec.getSize(widthMeasureSpec)
        val heightMode = View.MeasureSpec.getMode(heightMeasureSpec)
        val heightSize = View.MeasureSpec.getSize(heightMeasureSpec)

        val width = when (widthMode) {
            View.MeasureSpec.UNSPECIFIED ->
                suggestedMinimumWidth.coerceAtLeast(if (widthSize > 0) widthSize else 0)
            else -> widthSize.coerceAtLeast(suggestedMinimumWidth)
        }
        val height = when (heightMode) {
            View.MeasureSpec.UNSPECIFIED ->
                suggestedMinimumHeight.coerceAtLeast(if (heightSize > 0) heightSize else 0)
            else -> heightSize.coerceAtLeast(suggestedMinimumHeight)
        }

        setMeasuredDimension(
            if (width > 0) width else suggestedMinimumWidth.coerceAtLeast(1),
            if (height > 0) height else suggestedMinimumHeight.coerceAtLeast(1),
        )
        measureChildren(
            View.MeasureSpec.makeMeasureSpec(measuredWidth, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(measuredHeight, View.MeasureSpec.EXACTLY),
        )
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        // A resize (first real layout, modal settling) is a fresh
        // chance to bind if we were waiting for dimensions.
        if (w > 0 && h > 0 && !bound.get() && !binding.get() && attached.get()) {
            mainHandler.post { ensureBound() }
        }
    }

    // ── React props (called from the UI manager thread) ─────────

    fun setBarcodeEnabledProp(enabled: Boolean) {
        if (propBarcodeEnabled == enabled) return
        propBarcodeEnabled = enabled
        mainHandler.post {
            if (bound.get()) {
                // The use-case set changes with the mode → rebind.
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
        // Register with the single-instance coordinator: this claims
        // the camera (force-releasing any previous holder first).
        module()?.claimCamera(id)
        mainHandler.post { ensureBound() }
    }

    override fun onDetachedFromWindow() {
        attached.set(false)
        synchronized(instances) { instances.remove(id) }
        module()?.releaseClaim(id)
        mainHandler.post { releaseCamera() }
        super.onDetachedFromWindow()
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        super.onLayout(changed, l, t, r, b)
        if (!bound.get() && !binding.get() && attached.get()) {
            mainHandler.post { ensureBound() }
        }
    }

    private fun module(): SelaCameraModule? = SelaCameraModule.current()

    private fun hasCameraPermission(): Boolean {
        if (propPermissionGranted) return true
        return ContextCompat.checkSelfPermission(
            context, Manifest.permission.CAMERA
        ) == PackageManager.PERMISSION_GRANTED
    }

    private fun executor(): ExecutorService {
        val existing = analysisExecutor
        if (existing != null && !existing.isShutdown) {
            return existing
        }
        val created = Executors.newSingleThreadExecutor()
        analysisExecutor = created
        return created
    }

    // ── State snapshot (the JS polling contract) ────────────────

    fun stateSnapshot(): WritableMap = Arguments.createMap().apply {
        putBoolean("exists", true)
        putBoolean("bound", bound.get())
        putBoolean("previewLive", previewLive.get() && bound.get())
        putString(
            "state",
            when {
                diagnosticsMode.get() -> "diagnostics"
                bound.get() -> "ready"
                binding.get() -> "starting"
                replaced.get() -> "replaced"
                deadCamera.get() -> "error"
                !attached.get() -> "detached"
                else -> "starting"
            },
        )
        putString("lastError", lastBindError)
        putInt("width", width)
        putInt("height", height)
        putBoolean("barcodeEnabled", propBarcodeEnabled)
        putBoolean("torch", propTorch)
    }

    fun lastBindError(): String? = lastBindError.ifEmpty { null }

    // ── Binding ─────────────────────────────────────────────────

    private fun ensureBound() {
        if (binding.get() || bound.get() || deadCamera.get()) return
        if (replaced.get() || diagnosticsMode.get()) return
        if (!attached.get()) return
        if (width == 0 || height == 0) return // wait for layout
        if (!hasCameraPermission()) return    // wait for permission
        if (!previewView.isAttachedToWindow) return

        binding.set(true)
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            if (!attached.get() || replaced.get()) {
                binding.set(false)
                return@addListener
            }
            try {
                val provider = future.get()
                cameraProvider = provider
                bindInternal(provider)
            } catch (error: Exception) {
                handleBindFailure(error)
            }
        }, ContextCompat.getMainExecutor(context))
    }

    /** Single bind attempt; throws on failure. */
    private fun bindInternal(provider: ProcessCameraProvider) {
        // Release ONLY this view's previous use cases (a global
        // unbindAll could kill another live SelaCameraView).
        val previous = listOfNotNull(preview, imageCapture, imageAnalysis)
        if (previous.isNotEmpty()) {
            try {
                provider.unbind(*previous.toTypedArray())
            } catch (_: Exception) {
                // Already unbound — fine.
            }
        }

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

        previewLive.set(false)
        bound.set(true)
        binding.set(false)
        lastBindError = ""
        if (propBarcodeEnabled) applyAnalyzer()
        dispatchReady()
    }

    /**
     * Failure ladder: retry once → preview-only fallback → real
     * error (with the exception class, so the Diagnostics screen
     * finally shows WHY the camera failed on a given device).
     */
    private fun handleBindFailure(error: Exception) {
        val reason = "${error.javaClass.simpleName}: ${error.message ?: "خطأ غير معروف"}"
        lastBindError = reason
        if (!attached.get() || replaced.get()) {
            binding.set(false)
            return
        }

        mainHandler.postDelayed({
            if (!attached.get() || deadCamera.get() || replaced.get()) {
                binding.set(false)
                return@postDelayed
            }
            val provider = cameraProvider
            if (provider == null) {
                binding.set(false)
                dispatchError("فشل تشغيل الكاميرا: $reason")
                return@postDelayed
            }
            // Retry #1 — same use-case set.
            try {
                bindInternal(provider)
                return@postDelayed
            } catch (_: Exception) {
                // fall through to the preview-only fallback
            }
            if (!attached.get() || deadCamera.get() || replaced.get()) {
                binding.set(false)
                return@postDelayed
            }
            // Fallback — preview alone (the weakest combination any
            // HAL supports). Captures will report not-ready but the
            // merchant at least gets a live viewfinder + retry.
            try {
                imageCapture = null
                imageAnalysis = null
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
                preview = newPreview
                camera = provider.bindToLifecycle(
                    owner,
                    CameraSelector.DEFAULT_BACK_CAMERA,
                    newPreview
                )
                newPreview.setSurfaceProvider(previewView.surfaceProvider)
                previewLive.set(false)
                bound.set(true)
                binding.set(false)
                dispatchReady()
            } catch (fatal: Exception) {
                binding.set(false)
                bound.set(false)
                host?.destroy()
                host = null
                val fatalReason =
                    "${fatal.javaClass.simpleName}: ${fatal.message ?: "خطأ غير معروف"}"
                lastBindError = fatalReason
                dispatchError("فشل تشغيل الكاميرا: $fatalReason (بعد محاولتين)")
            }
        }, 600)
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
            // Pending visual capture? Grab THIS frame as JPEG (runs
            // before ML Kit so the JS scan pass resolves fast).
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

    /** ONE scanner client for the whole view lifetime. */
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
        module()?.emitBarcode(id, code)
    }

    // ── Capture (called via SelaCameraModule) ───────────────────

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
                lastBindError = "تجمد الالتقاط"
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

    // ── Frame-grab capture (barcode / "both" mode) ──────────────

    private fun startFrameGrab(promise: Promise) {
        if (imageAnalysis == null) {
            promise.reject("E_CAMERA_NOT_READY", "الكاميرا غير جاهزة — أعد المحاولة", null)
            return
        }
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

        val watchdog = Runnable {
            if (snapshotSettled.compareAndSet(false, true)) {
                wantSnapshot.set(false)
                val pending = snapshotPromise
                snapshotPromise = null
                snapshotFile = null
                deadCamera.set(true)
                lastBindError = "تجمد الالتقاط"
                dispatchError("تجمد الالتقاط — سيُعاد تشغيل الكاميرا")
                pending?.reject("E_CAPTURE_TIMEOUT", "انتهت مهلة الالتقاط", null)
            }
        }
        snapshotWatchdog = watchdog
        mainHandler.postDelayed(watchdog, 6000)
    }

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

    /** ImageProxy (YUV_420_888) → NV21 → JPEG file, no rotation. */
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

    /** Classic YUV_420_888 → NV21 with stride padding handling. */
    private fun yuv420ToNv21(image: ImageProxy): ByteArray {
        val width = image.width
        val height = image.height
        val ySize = width * height
        val nv21 = ByteArray(ySize + 2 * (ySize / 4))

        val yPlane = image.planes[0]
        val yBuffer = yPlane.buffer.duplicate()
        for (row in 0 until height) {
            yBuffer.position(row * yPlane.rowStride)
            yBuffer.get(nv21, row * width, width)
        }

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

    // ── Rebind / teardown ───────────────────────────────────────

    /** Full teardown + fresh bind (the JS retry button). */
    fun rebind(promise: Promise) {
        mainHandler.post {
            rebindNow()
            promise.resolve(true)
        }
    }

    private fun rebindNow() {
        releaseCamera()
        deadCamera.set(false)
        replaced.set(false)
        lastCode = null
        lastCodeAt = 0L
        ensureBound()
    }

    /**
     * The coordinator calls this when a NEWER camera view claims the
     * camera (POS modal opened over the product form, etc.).
     * Synchronous, on the main thread — the new view must not see
     * MAXIMUM_NUMBER_OF_CAMERAS_IN_USE from our stale session.
     */
    fun forceReleaseForReplacement() {
        replaced.set(true)
        deadCamera.set(true)
        releaseCamera()
    }

    private fun releaseCamera() {
        // Never leave a pending frame-grab promise hanging on teardown.
        finishSnapshot(null, "أُغلق ماسح الكاميرا")
        try {
            val own = listOfNotNull(preview, imageCapture, imageAnalysis)
            if (own.isNotEmpty()) {
                cameraProvider?.unbind(*own.toTypedArray())
            }
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
        previewLive.set(false)
        try {
            barcodeScanner?.close()
        } catch (_: Exception) {
        }
        barcodeScanner = null
    }

    // ── Diagnostics self-test (headless, no UI) ─────────────────

    /**
     * Binds a preview-only session on this DETACHED instance — the
     * real CameraX path with zero UI involvement. Returns true when
     * the bind succeeds and the preview surface got a provider.
     */
    fun diagnosticBind(provider: ProcessCameraProvider): Boolean {
        if (!diagnosticsMode.compareAndSet(false, true)) return false
        return try {
            val owner = CameraHost()
            owner.resume()
            host = owner
            val newPreview = Preview.Builder()
                .setTargetAspectRatio(AspectRatio.RATIO_4_3)
                .setTargetRotation(Surface.ROTATION_0)
                .build()
            preview = newPreview
            camera = provider.bindToLifecycle(
                owner,
                CameraSelector.DEFAULT_BACK_CAMERA,
                newPreview
            )
            // A detached PreviewView still accepts a surface provider.
            newPreview.setSurfaceProvider(previewView.surfaceProvider)
            true
        } catch (error: Exception) {
            lastBindError =
                "${error.javaClass.simpleName}: ${error.message ?: "خطأ غير معروف"}"
            false
        }
    }

    /** Releases a diagnostics instance completely. */
    fun releaseForDiagnostics() {
        if (!diagnosticsMode.get()) return
        releaseCamera()
        diagnosticsMode.set(false)
    }

    // ── Events (module channel — see class docs) ────────────────

    private fun dispatchReady() {
        module()?.emitReady(id)
    }

    private fun dispatchError(message: String) {
        module()?.emitError(id, message)
    }

    override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
        super.onWindowFocusChanged(hasWindowFocus)
        // After returning from permission dialogs etc., retry binding.
        if (hasWindowFocus && !bound.get() && !deadCamera.get() && !replaced.get()) {
            mainHandler.post { ensureBound() }
        }
    }
}
