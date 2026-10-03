package com.sela.native_modules

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.annotation.OptIn
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.core.view.WindowInsetsCompat
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * ScannerActivity — محرك المسح المنفصل (v8).
 * ─────────────────────────────────────────────────────────────────
 * WHY A NATIVE ACTIVITY (the real fix for the "blind camera"):
 *
 *  Six generations of camera code shared ONE fatal trait: the camera
 *  preview lived INSIDE the React Native view tree (a custom View
 *  mounted in screens/Modals). The device's own self-test proved the
 *  camera hardware, permission, CameraX provider and bind all work —
 *  yet the preview stayed BLACK and the torch dead. That combination
 *  means the CAPTURE SESSION was fine but the VIEW COMPOSITING layer
 *  (Fabric interop + Modal host + TextureView surface) never showed
 *  the frames on this device's ROM. No amount of JS-side hardening
 *  can repair a composition layer we do not control.
 *
 *  THE PROFESSIONAL SOLUTION (what Loyverse / Square / Zebra-style
 *  scanner apps do): the scanner runs in its OWN native full-screen
 *  window, completely outside React Native. The camera preview is
 *  the Activity's root view — laid out by Android itself, exactly
 *  like the device's camera app. A black screen is structurally
 *  impossible, the window ALWAYS fills the screen with correct
 *  dimensions, and the torch is a real native toggle.
 *
 *  TWO INDEPENDENT ENGINES (per merchant request — each works alone):
 *   • MODE_BARCODE : CameraX Preview + ML Kit frame analysis.
 *                   Vibrates, flashes green and returns the code.
 *   • MODE_PHOTO   : CameraX Preview + ImageCapture with a shutter.
 *                   Returns a full-res photo path for the offline
 *                   TFLite embedding pipeline (no frame processors
 *                   anywhere in the app).
 *
 *  JS contract (SelaScannerModule):
 *   • opens with  intent extra "mode" = "barcode" | "photo"
 *   • returns     "code" (barcode) or "path" (photo) or "error"
 *   • cancel      = user pressed إغلاق / back
 */
class ScannerActivity : Activity() {

    companion object {
        const val EXTRA_MODE = "mode"
        const val EXTRA_CODE = "code"
        const val EXTRA_PATH = "path"
        const val EXTRA_ERROR = "error"
        const val MODE_BARCODE = "barcode"
        const val MODE_PHOTO = "photo"

        /** Same formats the old engine accepted — all offline. */
        private val BARCODE_FORMATS = BarcodeScannerOptions.Builder()
            .setBarcodeFormats(
                Barcode.FORMAT_EAN_13,
                Barcode.FORMAT_EAN_8,
                Barcode.FORMAT_UPC_A,
                Barcode.FORMAT_UPC_E,
                Barcode.FORMAT_CODE_128,
                Barcode.FORMAT_CODE_39,
                Barcode.FORMAT_ITF,
                Barcode.FORMAT_CODABAR,
                Barcode.FORMAT_QR_CODE,
                Barcode.FORMAT_DATA_MATRIX,
            )
            .build()
    }

    private val isBarcodeMode: Boolean by lazy {
        intent?.getStringExtra(EXTRA_MODE) != MODE_PHOTO
    }

    // ── Camera ────────────────────────────────────────────────
    private var cameraProvider: ProcessCameraProvider? = null
    private var camera: Camera? = null
    private var torchOn = false
    private val analysisExecutor = Executors.newSingleThreadExecutor()
    private val scannerClient by lazy { BarcodeScanning.getClient(BARCODE_FORMATS) }
    private val settled = AtomicBoolean(false)

    // ── UI ────────────────────────────────────────────────────
    private lateinit var root: FrameLayout
    private lateinit var previewView: PreviewView
    private lateinit var torchButton: TextView
    private lateinit var flashOverlay: View
    private lateinit var statusChip: TextView

    // ═══════════════════════════════════════════════════════════
    // Lifecycle
    // ═══════════════════════════════════════════════════════════

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.CAMERA)
            != PackageManager.PERMISSION_GRANTED
        ) {
            finishWithError("إذن الكاميرا غير ممنوح — فعّله من إعدادات النظام")
            return
        }

        buildUi()
        setContentView(root)
        bindCamera()
    }

    override fun onDestroy() {
        super.onDestroy()
        if (settled.compareAndSet(false, true)) {
            // Guarantee the JS promise never hangs if the system kills us.
            finishWithError("أُغلق الماسح قبل إكمال العملية")
        }
        runCatching { scannerClient.close() }
        runCatching { analysisExecutor.shutdown() }
    }

    // ═══════════════════════════════════════════════════════════
    // UI — 100% programmatic, RTL Arabic, no resource files
    // ═══════════════════════════════════════════════════════════

    private fun dp(value: Float): Int =
        TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, value, resources.displayMetrics
        ).toInt()

    @SuppressLint("RtlHardcoded")
    private fun buildUi() {
        val bg = Color.parseColor("#0B0B10")
        val chipBg = Color.parseColor("#CC1C1C22")
        val stroke = Color.parseColor("#33FFFFFF")

        root = FrameLayout(this).apply {
            setBackgroundColor(bg)
            layoutDirection = View.LAYOUT_DIRECTION_RTL
        }

        // 1) Camera preview — the ROOT content: fills the window
        //    edge-to-edge, decided by Android's own layout pass.
        previewView = PreviewView(this).apply {
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
            scaleType = PreviewView.ScaleType.FILL_CENTER
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }
        root.addView(previewView)

        // 2) Success/failure flash overlay.
        flashOverlay = View(this).apply {
            visibility = View.GONE
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }
        root.addView(flashOverlay)

        // 3) Top bar: mode badge center, إغلاق + الفلاش at the sides.
        val topBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(14), 0, dp(14), 0)
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.TOP
            )
        }
        // Pad below the status bar on edge-to-edge Android 15+.
        topBar.setOnApplyWindowInsetsListener { v, insets ->
            val bars = WindowInsetsCompat.toWindowInsetsCompat(insets)
                .getInsets(WindowInsetsCompat.Type.systemBars())
            v.setPadding(v.paddingLeft, bars.top + dp(8), v.paddingRight, v.paddingBottom)
            insets
        }

        val closeButton = chip("إغلاق", chipBg, stroke).apply {
            setOnClickListener { finishCancelled() }
        }
        statusChip = chip(
            if (isBarcodeMode) "ماسح الباركود" else "المسح البصري",
            chipBg, stroke
        )
        torchButton = chip("الفلاش", chipBg, stroke).apply {
            setOnClickListener { toggleTorch() }
        }
        topBar.addView(closeButton)
        topBar.addView(
            View(this),
            LinearLayout.LayoutParams(0, 1, 1f)
        )
        topBar.addView(statusChip)
        topBar.addView(
            View(this),
            LinearLayout.LayoutParams(0, 1, 1f)
        )
        topBar.addView(torchButton)
        root.addView(topBar)

        // 4) Mode-specific chrome.
        if (isBarcodeMode) {
            // Red laser line with a subtle animated sweep.
            val line = View(this).apply {
                setBackgroundColor(Color.parseColor("#FF3B30"))
                layoutParams = FrameLayout.LayoutParams(
                    dp(230), dp(2), Gravity.CENTER
                )
            }
            root.addView(line)
            animateScanLine(line)

            root.addView(hintView("وجّه الكاميرا نحو ملصق الباركود — يُقفل تلقائياً عند القراءة"))
        } else {
            // Shutter: big white ring + inner disc, bottom-center.
            val shutter = FrameLayout(this).apply {
                layoutParams = FrameLayout.LayoutParams(
                    dp(74), dp(74), Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
                )
            }
            shutter.addView(View(this).apply {
                background = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setStroke(dp(4), Color.WHITE)
                    setColor(Color.parseColor("#66FFFFFF"))
                }
                layoutParams = FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
            })
            shutter.addView(View(this).apply {
                background = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(Color.WHITE)
                }
                layoutParams = FrameLayout.LayoutParams(
                    dp(56), dp(56), Gravity.CENTER
                )
            })
            shutter.setOnClickListener { capturePhoto() }
            root.addView(shutter)

            root.addView(hintView("عبّئ الإطار بالمنتج ثم اضغط زر التصوير"))
        }
    }

    private fun chip(text: String, bg: Int, stroke: Int): TextView =
        TextView(this).apply {
            this.text = text
            setTextColor(Color.parseColor("#E7E7EA"))
            textSize = 13f
            setPadding(dp(14), dp(7), dp(14), dp(7))
            background = GradientDrawable().apply {
                cornerRadius = dp(18).toFloat()
                setColor(bg)
                setStroke(dp(1), stroke)
            }
        }

    private fun hintView(text: String): TextView =
        TextView(this).apply {
            this.text = text
            setTextColor(Color.parseColor("#C8C8CE"))
            textSize = 13f
            gravity = Gravity.CENTER
            setPadding(dp(16), dp(10), dp(16), dp(10))
            background = GradientDrawable().apply {
                cornerRadius = dp(14).toFloat()
                setColor(chipBgCompat())
            }
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
            )
        }.also { hint ->
            hint.setOnApplyWindowInsetsListener { v, insets ->
                val bars = WindowInsetsCompat.toWindowInsetsCompat(insets)
                    .getInsets(WindowInsetsCompat.Type.systemBars())
                (v.layoutParams as FrameLayout.LayoutParams).bottomMargin =
                    bars.bottom + dp(86)
                v.requestLayout()
                insets
            }
        }

    private fun chipBgCompat(): Int = Color.parseColor("#B31C1C22")

    private fun animateScanLine(line: View) {
        line.post {
            val parent = line.parent as? View ?: return@post
            val span = parent.height * 0.62f
            val from = (parent.height / 2f - span / 2f).toInt()
            val to = (parent.height / 2f + span / 2f).toInt()
            line.animate()
                .translationY(from.toFloat())
                .setDuration(0)
                .withEndAction {
                    line.animate()
                        .translationY(to.toFloat())
                        .setDuration(1400)
                        .withEndAction {
                            line.animate()
                                .translationY(from.toFloat())
                                .setDuration(1400)
                                .withEndAction { if (!isFinishing) animateScanLine(line) }
                                .start()
                        }
                        .start()
                }
                .start()
        }
    }

    // ═══════════════════════════════════════════════════════════
    // Camera
    // ═══════════════════════════════════════════════════════════

    private fun bindCamera() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener(
            {
                try {
                    cameraProvider = future.get()
                    startCamera()
                } catch (error: Exception) {
                    finishWithError(
                        "تعذر تهيئة الكاميرا: ${error.javaClass.simpleName}" +
                            (error.message?.let { " — $it" } ?: "")
                    )
                }
            },
            ContextCompat.getMainExecutor(this)
        )
    }

    private fun startCamera() {
        val provider = cameraProvider ?: return
        val preview = Preview.Builder().build().also {
            it.setSurfaceProvider(previewView.surfaceProvider)
        }
        val selector = CameraSelector.DEFAULT_BACK_CAMERA

        try {
            // Exactly TWO use cases per bind (the budget-HAL sweet
            // spot proven across v5–v7): preview + ONE engine.
            camera = if (isBarcodeMode) {
                val analysis = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()
                    .also { it.setAnalyzer(analysisExecutor, ::analyzeFrame) }
                provider.unbindAll()
                provider.bindToLifecycle(this, selector, preview, analysis)
            } else {
                val capture = ImageCapture.Builder()
                    .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                    .build()
                    .also { imageCapture = it }
                provider.unbindAll()
                provider.bindToLifecycle(this, selector, preview, capture)
            }
            applyTorch()
        } catch (firstError: Exception) {
            // Bind ladder: retry once after 600ms, then surface the
            // real error class (never a silent black screen again).
            android.os.Handler(mainLooper).postDelayed(
                {
                    try {
                        provider.unbindAll()
                        camera = if (isBarcodeMode) {
                            val analysis = ImageAnalysis.Builder()
                                .setBackpressureStrategy(
                                    ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST
                                )
                                .build()
                                .also { it.setAnalyzer(analysisExecutor, ::analyzeFrame) }
                            provider.bindToLifecycle(
                                this, selector, preview, analysis
                            )
                        } else {
                            val capture = ImageCapture.Builder().build()
                                .also { imageCapture = it }
                            provider.bindToLifecycle(this, selector, preview, capture)
                        }
                        applyTorch()
                    } catch (secondError: Exception) {
                        finishWithError(
                            "فشل تشغيل الكاميرا: " +
                                secondError.javaClass.simpleName +
                                (secondError.message?.let { " — $it" } ?: "")
                        )
                    }
                },
                600
            )
        }
    }

    private var imageCapture: ImageCapture? = null

    // ── Barcode engine ────────────────────────────────────────

    @OptIn(ExperimentalGetImage::class)
    private fun analyzeFrame(proxy: androidx.camera.core.ImageProxy) {
        try {
            val media = proxy.image
            if (media == null || settled.get()) {
                proxy.close()
                return
            }
            val input = InputImage.fromMediaImage(
                media, proxy.imageInfo.rotationDegrees
            )
            scannerClient.process(input)
                .addOnSuccessListener { barcodes ->
                    val value = barcodes
                        .firstOrNull()?.rawValue
                        ?.takeIf { it.isNotBlank() }
                    if (value != null && settled.compareAndSet(false, true)) {
                        runOnUiThread { onBarcodeRead(value) }
                    }
                }
                .addOnCompleteListener { proxy.close() }
        } catch (_: Exception) {
            proxy.close()
        }
    }

    private fun onBarcodeRead(code: String) {
        vibrate(40)
        flash(Color.parseColor("#3322C55E"), 200)
        android.os.Handler(mainLooper).postDelayed(
            {
                if (settled.compareAndSet(true, true)) {
                    setResultAndFinish(code = code)
                }
            },
            220
        )
    }

    // ── Photo engine ──────────────────────────────────────────

    private fun capturePhoto() {
        val capture = imageCapture
        if (capture == null || settled.get()) {
            return
        }
        vibrate(25)
        val dir = File(filesDir, "scans").apply { mkdirs() }
        val file = File(dir, "scan_${System.currentTimeMillis()}.jpg")
        capture.takePicture(
            file,
            ContextCompat.getMainExecutor(this),
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(output: ImageCapture.OutputFileResults) {
                    if (settled.compareAndSet(false, true)) {
                        flash(Color.parseColor("#66FFFFFF"), 140)
                        setResultAndFinish(path = file.absolutePath)
                    }
                }

                override fun onError(error: ImageCaptureException) {
                    if (settled.compareAndSet(false, true)) {
                        finishWithError(
                            "فشل التقاط الصورة: ${error.javaClass.simpleName}" +
                                (error.message?.let { " — $it" } ?: "")
                        )
                    }
                }
            }
        )
    }

    // ── Torch ─────────────────────────────────────────────────

    private fun toggleTorch() {
        torchOn = !torchOn
        applyTorch()
    }

    private fun applyTorch() {
        val unit = camera ?: return
        val available = unit.cameraInfo.hasFlashUnit()
        runCatching { unit.cameraControl.enableTorch(torchOn && available) }
        torchButton.setTextColor(
            if (torchOn && available) {
                torchButton.background = GradientDrawable().apply {
                    cornerRadius = dp(18).toFloat()
                    setColor(Color.parseColor("#F97316"))
                }
                Color.WHITE
            } else {
                torchButton.background = GradientDrawable().apply {
                    cornerRadius = dp(18).toFloat()
                    setColor(Color.parseColor("#CC1C1C22"))
                    setStroke(dp(1), Color.parseColor("#33FFFFFF"))
                }
                Color.parseColor("#E7E7EA")
            }
        )
        if (!available) {
            torchButton.text = "لا فلاش"
        }
    }

    // ── Feedback helpers ──────────────────────────────────────

    private fun vibrate(ms: Long) {
        runCatching {
            val vibrator = if (Build.VERSION.SDK_INT >= 31) {
                val manager = getSystemService(Context.VIBRATOR_MANAGER_SERVICE)
                    as? android.os.VibratorManager
                manager?.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
            } ?: return
            if (Build.VERSION.SDK_INT >= 26) {
                vibrator.vibrate(
                    VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE)
                )
            } else {
                @Suppress("DEPRECATION")
                vibrator.vibrate(ms)
            }
        }
    }

    private fun flash(color: Int, durationMs: Long) {
        flashOverlay.setBackgroundColor(color)
        flashOverlay.visibility = View.VISIBLE
        flashOverlay.alpha = 1f
        flashOverlay.animate()
            .alpha(0f)
            .setDuration(durationMs)
            .withEndAction { flashOverlay.visibility = View.GONE }
            .start()
    }

    // ── Result delivery ───────────────────────────────────────

    private fun setResultAndFinish(code: String? = null, path: String? = null) {
        val data = android.content.Intent()
        code?.let { data.putExtra(EXTRA_CODE, it) }
        path?.let { data.putExtra(EXTRA_PATH, it) }
        setResult(RESULT_OK, data)
        finish()
    }

    private fun finishCancelled() {
        settled.set(true)
        setResult(RESULT_CANCELED)
        finish()
    }

    private fun finishWithError(message: String) {
        settled.set(true)
        setResult(
            RESULT_CANCELED,
            android.content.Intent().putExtra(EXTRA_ERROR, message)
        )
        finish()
    }
}
