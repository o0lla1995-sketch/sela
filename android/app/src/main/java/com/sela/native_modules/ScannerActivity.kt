package com.sela.native_modules

import android.annotation.SuppressLint
import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.util.Size
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
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.roundToInt

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
 *  v8.2 (round-11):
 *   • RUNTIME PERMISSION — the activity now ASKS for the camera on
 *     first launch instead of dying with "إذن الكاميرا غير ممنوح"
 *     (round-11 #1). Permanent denial offers the system settings
 *     page directly.
 *   • CONTINUOUS VISUAL SESSION — photo mode + "continuous" extra:
 *     the activity auto-captures on a calm cadence (no shutter press
 *     needed), streams every photo to JS ("selaScanVisual" event)
 *     and STAYS OPEN; JS reports each recognition outcome back and
 *     the window itself celebrates with a banner + vibrate + green
 *     flash (round-11 #2: the merchant waves product after product
 *     and each one jumps into the cart by itself).
 *
 *  JS contract (SelaScannerModule):
 *   • opens with  intent extra "mode" = "barcode" | "photo",
 *     optional extra "continuous" = true (both engines).
 *   • returns     "code" (barcode) or "path" (photo) or "error";
 *     a CONTINUOUS session returns {cancelled:true} when closed —
 *     each read is already delivered live via the
 *     "selaScanBarcode" / "selaScanVisual" JS events.
 *   • cancel      = user pressed إغلاق / back
 */
class ScannerActivity : Activity() {

    companion object {
        const val EXTRA_MODE = "mode"
        const val EXTRA_CODE = "code"
        const val EXTRA_PATH = "path"
        const val EXTRA_ERROR = "error"
        const val EXTRA_CONTINUOUS = "continuous"
        const val MODE_BARCODE = "barcode"
        const val MODE_PHOTO = "photo"

        /** v8.1: sink the module registers so a continuous barcode
         *  session can stream each read to JS ("selaScanBarcode"). */
        @JvmStatic var continuousSink: ((code: String) -> Unit)? = null

        /** v8.2: sink for the continuous VISUAL session — every auto
         *  or manual photo path streams to JS ("selaScanVisual"). */
        @JvmStatic var visualSink: ((path: String, auto: Boolean) -> Unit)? = null

        /** v8.2: JS reports each recognition outcome so the scanner
         *  window itself can celebrate / hint in real time.
         *  kind: "added" | "dup" | "miss". */
        @JvmStatic var visualFeedback: ((kind: String, name: String, score: Double) -> Unit)? = null

        /** v8.2: auto-capture cadence for the continuous visual
         *  session — shot → settle → next. ~2s + capture latency
         *  gives the merchant time to swap products between shots
         *  while never feeling slow at the counter. */
        private const val VISUAL_AUTO_INTERVAL_MS = 2000L

        /** Camera permission request code (round-11 #1). */
        private const val REQUEST_CAMERA = 71020

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

    /**
     * CameraX binds to a LifecycleOwner — a plain Activity is not
     * one, so the activity owns a minimal registry tied to its own
     * start/stop (same proven pattern as the v5–v7 native view).
     */
    private class Host : LifecycleOwner {
        private val registry = LifecycleRegistry(this)
        override val lifecycle: Lifecycle get() = registry
        fun resume() {
            registry.currentState = Lifecycle.State.RESUMED
        }
        fun pause() {
            registry.currentState = Lifecycle.State.CREATED
        }
        fun destroy() {
            runCatching { registry.currentState = Lifecycle.State.DESTROYED }
        }
    }

    private val isBarcodeMode: Boolean by lazy {
        intent?.getStringExtra(EXTRA_MODE) != MODE_PHOTO
    }

    /** v8.1 continuous multi-scan (barcode): never auto-close; every
     *  deduped read streams to JS. v8.2: the VISUAL engine gains the
     *  same session style — auto-captures stream photo paths and the
     *  session keeps running until the merchant closes it. */
    private val isContinuous: Boolean by lazy {
        intent?.getBooleanExtra(EXTRA_CONTINUOUS, false) == true
    }

    // ── Camera ────────────────────────────────────────────────
    private var cameraProvider: ProcessCameraProvider? = null
    private var camera: Camera? = null
    private var torchOn = false
    private val analysisExecutor = Executors.newSingleThreadExecutor()
    private val scannerClient by lazy { BarcodeScanning.getClient(BARCODE_FORMATS) }
    private val settled = AtomicBoolean(false)

    /** v8.1: continuous-session read counter + per-code dedupe. */
    private val continuousReads = AtomicInteger(0)
    private var lastCode: String? = null
    private var lastCodeAt = 0L

    /** v8.2: continuous VISUAL session state — auto-capture loop,
     *  ping-pong photo files and the recognized-products counter. */
    private val mainHandler = android.os.Handler(mainLooper)
    private val autoShotRunnable = Runnable { startAutoCapture() }
    private var captureInFlight = false
    private var pingPongFlip = false
    private var sessionPhotoA: File? = null
    private var sessionPhotoB: File? = null
    private val visualAdds = AtomicInteger(0)

    /** The lifecycle the camera binds to — driven by this activity. */
    private val cameraHost = Host()

    // ── UI ────────────────────────────────────────────────────
    private lateinit var root: FrameLayout
    private lateinit var previewView: PreviewView
    private lateinit var torchButton: TextView
    private lateinit var flashOverlay: View
    private lateinit var statusChip: TextView
    /** v8.2: the live "أُضيف للسلة: …" recognition banner. */
    private var recognizerBanner: TextView? = null

    // ═══════════════════════════════════════════════════════════
    // Lifecycle
    // ═══════════════════════════════════════════════════════════

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // v8.2 (round-11 #1): ASK for the camera the first time — the
        // app used to die instantly with "فعّله من إعدادات النظام"
        // because nothing ever requested the permission at runtime.
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
            != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(
                this, arrayOf(Manifest.permission.CAMERA), REQUEST_CAMERA
            )
            return
        }
        onReady()
    }

    /** Everything that happens once the camera permission is in hand. */
    private fun onReady() {
        buildUi()
        setContentView(root)
        bindCamera()
        if (isContinuous && !isBarcodeMode) {
            // JS streams recognition outcomes back — show them live.
            ScannerActivity.visualFeedback = { kind, name, score ->
                runOnUiThread { showRecognizerBanner(kind, name, score) }
            }
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_CAMERA) {
            return
        }
        if (grantResults.isNotEmpty() &&
            grantResults[0] == PackageManager.PERMISSION_GRANTED
        ) {
            onReady()
            return
        }
        if (shouldShowRequestPermissionRationale(Manifest.permission.CAMERA)) {
            // Soft denial — explain once, then ask again.
            AlertDialog.Builder(this)
                .setTitle("إذن الكاميرا")
                .setMessage(
                    "سيلا يحتاج الكاميرا لمسح المنتجات — المسح البصري والباركود يعملان بها فقط."
                )
                .setPositiveButton("السماح") { _, _ ->
                    ActivityCompat.requestPermissions(
                        this, arrayOf(Manifest.permission.CAMERA), REQUEST_CAMERA
                    )
                }
                .setNegativeButton("إغلاق") { _, _ ->
                    finishWithError("لم يُمنح إذن الكاميرا — فعّله من إعدادات النظام")
                }
                .show()
        } else {
            // Permanently denied — only the system settings page can fix it.
            AlertDialog.Builder(this)
                .setTitle("إذن الكاميرا مرفوض")
                .setMessage(
                    "فُعِّل إذن الكاميرا من إعدادات النظام:\nالتطبيقات ← سيلا ← الأذونات ← الكاميرا."
                )
                .setPositiveButton("فتح الإعدادات") { _, _ ->
                    runCatching {
                        startActivity(
                            Intent(
                                android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                                Uri.fromParts("package", packageName, null)
                            )
                        )
                    }
                    finishWithError("لم يُمنح إذن الكاميرا — فعّله من الإعدادات ثم أعد المسح")
                }
                .setNegativeButton("إغلاق") { _, _ ->
                    finishWithError("لم يُمنح إذن الكاميرا — فعّله من إعدادات النظام")
                }
                .show()
        }
    }

    override fun onStart() {
        super.onStart()
        cameraHost.resume()
        // v8.2: resume the visual auto-capture loop after the window
        // comes back to the front (e.g. after the permission dialog).
        if (isContinuous && !isBarcodeMode && cameraProvider != null) {
            scheduleNextAutoCapture(800)
        }
    }

    override fun onStop() {
        super.onStop()
        cameraHost.pause()
        // The camera is unbound while stopped — pause the auto loop.
        mainHandler.removeCallbacks(autoShotRunnable)
    }

    override fun onDestroy() {
        super.onDestroy()
        mainHandler.removeCallbacks(autoShotRunnable)
        if (settled.compareAndSet(false, true)) {
            // Guarantee the JS promise never hangs if the system kills us.
            finishWithError("أُغلق الماسح قبل إكمال العملية")
        }
        if (isContinuous) {
            if (isBarcodeMode) {
                // The barcode session is over — drop the stream sink so
                // a stale activity can never leak reads into a new session.
                ScannerActivity.continuousSink = null
            } else {
                ScannerActivity.visualSink = null
                ScannerActivity.visualFeedback = null
                // Ping-pong scratch files belong to this session only.
                runCatching { sessionPhotoA?.delete() }
                runCatching { sessionPhotoB?.delete() }
            }
        }
        cameraHost.destroy()
        runCatching { scannerClient.close() }
        runCatching { analysisExecutor.shutdown() }
    }

    // ═══════════════════════════════════════════════════════════
    // UI — 100% programmatic, RTL Arabic, no resource files
    // ═══════════════════════════════════════════════════════════

    private fun dp(value: Int): Int =
        TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics
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
            when {
                isContinuous && isBarcodeMode -> "مسح متعدد · 0"
                isContinuous -> "مسح بصري متواصل · 0"
                isBarcodeMode -> "ماسح الباركود"
                else -> "المسح البصري"
            },
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

            root.addView(
                hintView(
                    if (isContinuous) {
                        "امسح عدة منتجات — كل قراءة تُضاف للسلة فوراً · إغلاق للإنهاء"
                    } else {
                        "وجّه الكاميرا نحو ملصق الباركود — يُقفل تلقائياً عند القراءة"
                    }
                )
            )
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
            shutter.setOnClickListener { manualShot() }
            root.addView(shutter)

            // v8.2: the live recognition banner — JS reports every
            // outcome and the scanner window itself celebrates:
            // green "أُضيف للسلة: …" on a confident add, a neutral
            // "مضاف بالفعل" on a suppressed duplicate, an amber hint
            // when nothing matched.
            recognizerBanner = TextView(this).apply {
                visibility = View.GONE
                setTextColor(Color.WHITE)
                textSize = 15f
                typeface = Typeface.DEFAULT_BOLD
                gravity = Gravity.CENTER
                setPadding(dp(18), dp(11), dp(18), dp(11))
                background = GradientDrawable().apply {
                    cornerRadius = dp(14).toFloat()
                    setColor(Color.parseColor("#E622C55E"))
                }
                layoutParams = FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
                )
            }.also { banner ->
                banner.setOnApplyWindowInsetsListener { v, insets ->
                    val bars = WindowInsetsCompat.toWindowInsetsCompat(insets)
                        .getInsets(WindowInsetsCompat.Type.systemBars())
                    (v.layoutParams as FrameLayout.LayoutParams).bottomMargin =
                        bars.bottom + dp(168)
                    v.requestLayout()
                    insets
                }
            }
            root.addView(recognizerBanner)

            root.addView(
                hintView(
                    if (isContinuous) {
                        "وجّه الكاميرا نحو المنتج — يُضاف للسلة تلقائياً عند التعرف عليه"
                    } else {
                        "عبّئ الإطار بالمنتج ثم اضغط زر التصوير"
                    }
                )
            )
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
                provider.bindToLifecycle(cameraHost, selector, preview, analysis)
            } else {
                val capture = buildPhotoCapture()
                provider.unbindAll()
                provider.bindToLifecycle(cameraHost, selector, preview, capture)
            }
            applyTorch()
            // v8.2: the visual auto-capture loop starts once the camera
            // is genuinely live (first successful bind).
            if (isContinuous && !isBarcodeMode) {
                scheduleNextAutoCapture(1400)
            }
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
                                cameraHost, selector, preview, analysis
                            )
                        } else {
                            val capture = buildPhotoCapture()
                            provider.bindToLifecycle(cameraHost, selector, preview, capture)
                        }
                        applyTorch()
                        if (isContinuous && !isBarcodeMode) {
                            scheduleNextAutoCapture(1400)
                        }
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
                    if (value != null) {
                        if (isContinuous) {
                            onBarcodeContinuous(value)
                        } else if (settled.compareAndSet(false, true)) {
                            runOnUiThread { onBarcodeRead(value) }
                        }
                    }
                }
                .addOnCompleteListener { proxy.close() }
        } catch (_: Exception) {
            proxy.close()
        }
    }

    /** v8.1 continuous session: dedupe the same label for 1.6s, then
     *  stream every NEW code to JS and keep scanning — the merchant
     *  scans item after item without ever leaving the camera. */
    private fun onBarcodeContinuous(code: String) {
        val now = android.os.SystemClock.elapsedRealtime()
        synchronized(this) {
            if (code == lastCode && now - lastCodeAt < 1600L) {
                return
            }
            lastCode = code
            lastCodeAt = now
        }
        val reads = continuousReads.incrementAndGet()
        runOnUiThread {
            if (settled.get()) {
                return@runOnUiThread
            }
            vibrate(40)
            flash(Color.parseColor("#3322C55E"), 200)
            statusChip.text = "مسح متعدد · $reads"
        }
        // Stream to JS on the analysis thread (the emitter is
        // thread-safe); errors here must never kill the session.
        runCatching {
            ScannerActivity.continuousSink?.invoke(code)
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

    /**
     * v8.2: one builder for both photo flows. The continuous session
     * caps the stream at ~1MP — the embedder only needs a 224px
     * center crop, so auto-capture cycles stay fast and light on
     * budget HALs (single-shot enrollment keeps full quality).
     */
    private fun buildPhotoCapture(): ImageCapture {
        val builder = ImageCapture.Builder()
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
        if (isContinuous) {
            runCatching {
                builder.setResolutionSelector(
                    ResolutionSelector.Builder()
                        .setResolutionStrategy(
                            ResolutionStrategy(
                                Size(1280, 960),
                                ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER
                            )
                        )
                        .build()
                )
            }
        }
        return builder.build().also { imageCapture = it }
    }

    /**
     * v8.2 photo scratch files: the continuous session OVERWRITES two
     * ping-pong files instead of piling up hundreds of JPEGs — the
     * 2s cadence means JS has long finished with one file before the
     * next shot touches the other. Single-shot enrollment keeps the
     * classic timestamped file (its path survives the activity).
     */
    private fun nextPhotoFile(): File {
        val dir = File(filesDir, "scans").apply { mkdirs() }
        if (!isContinuous) {
            return File(dir, "scan_${System.currentTimeMillis()}.jpg")
        }
        pingPongFlip = !pingPongFlip
        return if (pingPongFlip) {
            sessionPhotoA ?: File(dir, "session_a.jpg").also { sessionPhotoA = it }
        } else {
            sessionPhotoB ?: File(dir, "session_b.jpg").also { sessionPhotoB = it }
        }
    }

    /** Manual shutter press — a deliberate action: capture NOW and
     *  restart the auto cycle from this moment. */
    private fun manualShot() {
        if (isContinuous && !isBarcodeMode) {
            mainHandler.removeCallbacks(autoShotRunnable)
            capturePhoto(auto = false)
        } else {
            capturePhoto(auto = false)
        }
    }

    /** v8.2 auto-capture cadence: shot → settle → next. The pause
     *  after each shot gives the merchant time to swap products. */
    private fun scheduleNextAutoCapture(delayMs: Long) {
        if (settled.get() || !isContinuous || isBarcodeMode) {
            return
        }
        mainHandler.removeCallbacks(autoShotRunnable)
        mainHandler.postDelayed(autoShotRunnable, delayMs)
    }

    private fun startAutoCapture() {
        if (settled.get() || !isContinuous || isBarcodeMode) {
            return
        }
        if (captureInFlight) {
            scheduleNextAutoCapture(900)
            return
        }
        capturePhoto(auto = true)
    }

    private fun capturePhoto(auto: Boolean) {
        val capture = imageCapture
        if (capture == null || settled.get()) {
            return
        }
        if (isContinuous) {
            if (captureInFlight) {
                return
            }
            captureInFlight = true
            vibrate(20)
        } else {
            vibrate(25)
        }
        val file = nextPhotoFile()
        val outputOptions = ImageCapture.OutputFileOptions.Builder(file).build()
        capture.takePicture(
            outputOptions,
            ContextCompat.getMainExecutor(this),
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(output: ImageCapture.OutputFileResults) {
                    if (isContinuous) {
                        captureInFlight = false
                        if (settled.get()) {
                            return
                        }
                        flash(Color.parseColor("#26FFFFFF"), 110)
                        // Stream to JS (the emitter is thread-safe) and
                        // keep the session RUNNING — the merchant waves
                        // product after product without leaving the camera.
                        runCatching {
                            ScannerActivity.visualSink?.invoke(file.absolutePath, auto)
                        }
                        scheduleNextAutoCapture(VISUAL_AUTO_INTERVAL_MS)
                    } else if (settled.compareAndSet(false, true)) {
                        flash(Color.parseColor("#66FFFFFF"), 140)
                        setResultAndFinish(path = file.absolutePath)
                    }
                }

                override fun onError(error: ImageCaptureException) {
                    if (isContinuous) {
                        captureInFlight = false
                        if (settled.get()) {
                            return
                        }
                        // Back off briefly and try again — one failed
                        // shot must never end the session.
                        scheduleNextAutoCapture(1500)
                    } else if (settled.compareAndSet(false, true)) {
                        finishWithError(
                            "فشل التقاط الصورة: ${error.javaClass.simpleName}" +
                                (error.message?.let { " — $it" } ?: "")
                        )
                    }
                }
            }
        )
    }

    /**
     * v8.2: JS reports each recognition outcome (added / dup / miss)
     * and the scanner window reacts in real time — banner, vibration,
     * green flash and the session counter. This is what makes the
     * continuous visual session feel alive at the counter.
     */
    private fun showRecognizerBanner(kind: String, name: String, score: Double) {
        val banner = recognizerBanner ?: return
        val background = banner.background as? GradientDrawable
        when (kind) {
            "added" -> {
                val pct = (score * 100).roundToInt()
                banner.text = if (name.isNotBlank()) {
                    "أُضيف للسلة: $name · $pct%"
                } else {
                    "أُضيف للسلة"
                }
                background?.setColor(Color.parseColor("#E622C55E"))
                banner.setTextColor(Color.WHITE)
                visualAdds.incrementAndGet()
                statusChip.text = "مسح بصري متواصل · ${visualAdds.get()}"
                vibrate(40)
                flash(Color.parseColor("#3322C55E"), 220)
            }
            "dup" -> {
                banner.text = "$name — مضاف بالفعل في السلة"
                background?.setColor(Color.parseColor("#D91C1C22"))
                banner.setTextColor(Color.parseColor("#E7E7EA"))
                vibrate(15)
            }
            else -> {
                banner.text = "لم يتم التعرف — قرّب الكاميرا أو حسّن الإضاءة"
                background?.setColor(Color.parseColor("#E68A5A00"))
                banner.setTextColor(Color.WHITE)
            }
        }
        banner.animate().cancel()
        banner.visibility = View.VISIBLE
        banner.alpha = 1f
        banner.animate()
            .alpha(0f)
            .setStartDelay(1500)
            .setDuration(400)
            .withEndAction { banner.visibility = View.GONE }
            .start()
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
