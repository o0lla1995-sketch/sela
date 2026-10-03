package com.sela.native_modules.camera

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.SparseArray
import android.widget.FrameLayout
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.AspectRatio
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.ThemedReactContext
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.common.InputImage
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * SelaCameraView
 * ─────────────────────────────────────────────────────────────────
 * Hand-written CameraX preview (v4 camera stack).
 *
 * Why this exists (root-cause of the black-screen + full-app freeze):
 * react-native-camera-kit 14.2.0 shipped two fatal bugs on our devices:
 *
 *  1. QRCodeAnalyzer created a NEW ML Kit BarcodeScanning client on
 *     EVERY analyzed frame (~15-30/s) and never closed them — the
 *     runtime flooded within seconds: preview went black, barcode
 *     events stopped ("لا يقرأ") and the app froze until killed.
 *  2. capture() ran concurrently with the still-running barcode
 *     analyzer, and its promise never resolved when the camera died —
 *     our `await` hung forever and the scanner stayed dead.
 *
 * Design rules enforced here:
 *  - ONE ML Kit scanner client for the view's whole lifetime.
 *  - Preview + ImageCapture + ImageAnalysis are ALL 4:3 and bound
 *    together exactly ONCE — no rebinding when torch/barcode toggles.
 *  - The analyzer is paused during a photo capture (clears the
 *    stream-concurrency stall that blacked out cheap camera HALs).
 *  - capture() is single-flight with a 6s watchdog — a dead camera
 *    rejects the promise so JS can recover by remounting the view.
 *  - Barcode reads are deduped natively (same code within 1200ms).
 */
class SelaCameraView(
    private val reactContext: ThemedReactContext,
) : FrameLayout(reactContext) {

    companion object {
        /** Live view registry keyed by RN view tag (module looks up here). */
        private val instances = SparseArray<SelaCameraView>()

        fun find(tag: Int): SelaCameraView? = synchronized(instances) { instances.get(tag) }
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private val analysisExecutor: ExecutorService = Executors.newSingleThreadExecutor()

    private val previewView = PreviewView(context).apply {
        implementationMode = PreviewView.ImplementationMode.PERFORMANCE
        scaleType = PreviewView.ScaleType.FILL_CENTER
    }

    // Camera state
    private var cameraProvider: ProcessCameraProvider? = null
    private var camera: androidx.camera.core.Camera? = null
    private var preview: Preview? = null
    private var imageCapture: ImageCapture? = null
    private var imageAnalysis: ImageAnalysis? = null
    private var barcodeScanner: BarcodeScanner? = null

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
        mainHandler.post { applyAnalyzer() }
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

    /**
     * Binds Preview + ImageCapture + ImageAnalysis (all 4:3) exactly once.
     * Idempotent: safe to call from attach, layout and prop changes.
     */
    private fun ensureBound() {
        if (binding.get() || bound.get() || deadCamera.get()) return
        if (!attached.get()) return
        if (width == 0 || height == 0) return // wait for layout
        if (!hasCameraPermission()) return     // wait for permission prop

        val activity = reactContext.currentActivity as? AppCompatActivity
        if (activity == null) {
            mainHandler.postDelayed({ ensureBound() }, 400)
            return
        }

        binding.set(true)
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            try {
                val provider = future.get()
                cameraProvider = provider

                val rotation = previewView.display?.rotation ?: 0

                val newPreview = Preview.Builder()
                    .setTargetAspectRatio(AspectRatio.RATIO_4_3)
                    .setTargetRotation(rotation)
                    .build()

                val newCapture = ImageCapture.Builder()
                    .setTargetAspectRatio(AspectRatio.RATIO_4_3)
                    .setTargetRotation(rotation)
                    .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                    .setJpegQuality(88)
                    .build()

                val newAnalysis = ImageAnalysis.Builder()
                    .setTargetAspectRatio(AspectRatio.RATIO_4_3)
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()

                // Attach analyzer AFTER binding (uses the final instances).
                imageCapture = newCapture
                imageAnalysis = newAnalysis
                preview = newPreview

                provider.unbindAll()
                camera = provider.bindToLifecycle(
                    activity,
                    CameraSelector.DEFAULT_BACK_CAMERA,
                    newPreview,
                    newCapture,
                    newAnalysis
                )

                newPreview.setSurfaceProvider(previewView.surfaceProvider)

                // Restore torch state across (re)binds.
                if (propTorch) {
                    camera?.cameraControl?.enableTorch(true)
                }

                bound.set(true)
                binding.set(false)
                applyAnalyzer()
                dispatchReady()
            } catch (error: Exception) {
                binding.set(false)
                bound.set(false)
                dispatchError("فشل تشغيل الكاميرا: ${error.message ?: "خطأ غير معروف"}")
            }
        }, ContextCompat.getMainExecutor(context))
    }

    /** Starts or stops the ML Kit analyzer WITHOUT rebinding the camera. */
    private fun applyAnalyzer() {
        val analysis = imageAnalysis ?: return
        if (!bound.get()) return
        if (propBarcodeEnabled) {
            val scanner = obtainScanner()
            if (scanner == null) {
                dispatchError("تعذر تهيئة ماسح الباركود")
                return
            }
            analysis.setAnalyzer(analysisExecutor) { image ->
                val mediaImage = try {
                    image.image
                } catch (_: Exception) {
                    null
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
                } catch (error: Exception) {
                    analyzing.set(false)
                    image.close()
                }
            }
        } else {
            analysis.clearAnalyzer()
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
     */
    fun capture(promise: Promise) {
        mainHandler.post {
            if (!bound.get() || imageCapture == null) {
                promise.reject("E_CAMERA_NOT_READY", "الكاميرا غير جاهزة — أعد المحاولة", null)
                return@post
            }
            if (!captureInFlight.compareAndSet(false, true)) {
                promise.reject("E_CAPTURE_BUSY", "التقاط آخر قيد التنفيذ", null)
                return@post
            }

            // Pause the analyzer during the still capture — avoids the
            // analysis+capture stream stall that blacked out previews.
            val wasAnalyzing = propBarcodeEnabled
            if (wasAnalyzing) imageAnalysis?.clearAnalyzer()

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
                if (wasAnalyzing) applyAnalyzer()
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
                        if (wasAnalyzing) applyAnalyzer()
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
                        if (wasAnalyzing) applyAnalyzer()
                        promise.resolve(outFile.absolutePath)
                    }
                }
            )
        }
    }

    /** Full teardown + fresh bind (used by the JS retry button). */
    fun rebind(promise: Promise) {
        mainHandler.post {
            releaseCamera()
            deadCamera.set(false)
            lastCode = null
            lastCodeAt = 0L
            ensureBound()
            promise.resolve(true)
        }
    }

    private fun releaseCamera() {
        try {
            imageAnalysis?.clearAnalyzer()
            cameraProvider?.unbindAll()
        } catch (_: Exception) {
            // Unbind during teardown is best-effort.
        }
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
