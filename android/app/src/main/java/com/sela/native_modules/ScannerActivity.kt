package com.sela.native_modules

import android.annotation.SuppressLint
import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
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

/**
 * ScannerActivity — محرك المسح المنفصل (v9).
 * ─────────────────────────────────────────────────────────────────
 *  WHY A NATIVE ACTIVITY (the real fix for the "blind camera"):
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
 *                   Single-shot lock, or a v8.1 CONTINUOUS session
 *                   ("continuous" extra) that streams every deduped
 *                   read to JS and never auto-closes.
 *   • MODE_PHOTO   : CameraX Preview + ImageCapture with a shutter.
 *                   Returns a full-res photo path for the offline
 *                   TFLite embedding pipeline (no frame processors
 *                   anywhere in the app).
 *
 *  v9 (round-13) — THE GREAT SIMPLIFICATION:
 *  v8.2–v8.3 tried a continuous VISUAL session (auto-capture loop,
 *  photo streaming, recognition feedback) and the merchant's device
 *  hard-crashed on every scanner open — while v8.1.0, the exact same
 *  native activity WITHOUT that machinery, had worked perfectly. The
 *  v9 engine therefore returns BYTE-FOR-BYTE to the proven v8.1.0
 *  structure and keeps only two proven additions:
 *    • the RUNTIME PERMISSION ask (round-11 #1 — the system dialog
 *      appeared and granted correctly on the device), and
 *    • the catch-Throwable crash shields (round-12) around every
 *      entry point.
 *  Everything else added after v8.1.0 — visualSink, the auto-capture
 *  handler, ping-pong scratch files, the in-window recognition
 *  banner, the 1280×960 resolution selector — is REMOVED. The visual
 *  flow is once again ONE deliberate photo per window (the JS side
 *  re-opens it for the next product), which is the exact code path
 *  the merchant's device ran without a single crash in v8.1.0.
 *
 *  JS contract (SelaScannerModule):
 *   • opens with  intent extra "mode" = "barcode" | "photo",
 *     optional extra "continuous" = true (barcode engine only).
 *   • returns     "code" (barcode) or "path" (photo) or "error";
 *     a CONTINUOUS session returns {cancelled:true} when closed —
 *     each read is already delivered live via the
 *     "selaScanBarcode" JS event.
 *   • cancel      = user pressed إغلاق / back
 */
class ScannerActivity : Activity() {

    companion object {
        const val EXTRA_MODE = "mode"
        const val EXTRA_CODE = "code"
        const val EXTRA_PATH = "path"
        const val EXTRA_ERROR = "error"
        const val EXTRA_CONTINUOUS = "continuous"
        const val EXTRA_MULTI = "multi"
        const val MODE_BARCODE = "barcode"
        const val MODE_PHOTO = "photo"

        /** v9.2 (round-15 #5): the COMBINED window — both engines in
         *  ONE activity with an in-camera switcher; the merchant
         *  flips باركود ⇄ بصري without ever closing the camera. */
        const val MODE_BOTH = "both"

        /** v8.1: sink the module registers so a continuous barcode
         *  session can stream each read to JS ("selaScanBarcode"). */
        @JvmStatic var continuousSink: ((code: String) -> Unit)? = null

        /** v9.1 (round-14 #2): sink for the CONTINUOUS multi-shot
         *  VISUAL session — every deliberate shutter press saves a
         *  photo and streams its path to JS ("selaScanPhoto") while
         *  the window STAYS OPEN, exactly like the barcode engine.
         *  This is NOT the v8.2 auto-capture loop that crashed the
         *  device: every capture is a deliberate manual press, one
         *  at a time — the identical ImageCapture load of the
         *  proven v8.1.0 single-shot flow. */
        @JvmStatic var photoSink: ((path: String) -> Unit)? = null

        /** v9.1: the live window, so the module can route JS scan
         *  feedback (product name / غير مسجل) to the in-window
         *  banner + CONFIRMED counter. Weak — never leaks. */
        @JvmStatic private var liveInstance: java.lang.ref.WeakReference<ScannerActivity>? =
            null

        /** v9.1 (round-14 #1): JS confirms each streamed read —
         *  registered products count, unknown barcodes do NOT.
         *  Routed to the live window's banner + counter chip. */
        @JvmStatic fun notifyResult(ok: Boolean, message: String) {
            val activity = liveInstance?.get() ?: return
            activity.runOnUiThread {
                runCatching { activity.showScanResult(ok, message) }
            }
        }

        /** v8.3: how many scanner windows are ALIVE right now. The
         *  module uses this to detect a stale pendingPromise left by
         *  a session the system killed (process death on permission
         *  grant) — without this check the scanner jams forever
         *  with E_BUSY until an app restart. */
        @JvmStatic val liveInstances = java.util.concurrent.atomic.AtomicInteger(0)

        /** True when at least one scanner window is alive. */
        @JvmStatic fun isLive(): Boolean = liveInstances.get() > 0

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
            // v8.3: shielded — a ROM-specific LifecycleRegistry complaint
            // must never kill the window.
            runCatching { registry.currentState = Lifecycle.State.RESUMED }
        }
        fun pause() {
            runCatching { registry.currentState = Lifecycle.State.CREATED }
        }
        fun destroy() {
            runCatching { registry.currentState = Lifecycle.State.DESTROYED }
        }
    }

    private val modeValue: String by lazy {
        intent?.getStringExtra(EXTRA_MODE) ?: MODE_BARCODE
    }

    /** v9.2 (round-15 #5): the COMBINED window — both engines in one
     *  activity with the in-camera switcher. */
    private val isBothMode: Boolean by lazy { modeValue == MODE_BOTH }

    /** The ACTIVE engine. Fixed by the launch mode in barcode/photo
     *  windows; in the combined window the merchant flips it live
     *  with the switcher (starts on BARCODE). */
    private var engineIsBarcode: Boolean = true

    private val isBarcodeMode: Boolean
        get() = engineIsBarcode

    /** v8.1 continuous multi-scan (BARCODE); in the combined window
     *  the barcode engine ALWAYS runs continuous (the switcher just
     *  rebinds the use case — the session never auto-closes). */
    private val isContinuous: Boolean by lazy {
        (modeValue == MODE_BARCODE &&
            intent?.getBooleanExtra(EXTRA_CONTINUOUS, false) == true) ||
            isBothMode
    }

    /** v9.1 (round-14 #2) multi-shot VISUAL session; in the combined
     *  window the photo engine ALWAYS runs multi-shot. */
    private val isMultiPhoto: Boolean by lazy {
        (modeValue == MODE_PHOTO &&
            intent?.getBooleanExtra(EXTRA_MULTI, false) == true) ||
            isBothMode
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

    /** v9.1: CONFIRMED count — only reads JS confirmed as a
     *  REGISTERED product (added / queued weight). This is what the
     *  counter chip displays; raw reads no longer inflate it. */
    private val confirmedCount = AtomicInteger(0)

    /** v9.1: guards a second shutter press while a capture is still
     *  saving (multi mode keeps the shutter armed). */
    private val captureBusy = AtomicBoolean(false)

    /** The lifecycle the camera binds to — driven by this activity. */
    private val cameraHost = Host()

    // ── UI ────────────────────────────────────────────────────
    private lateinit var root: FrameLayout
    private lateinit var previewView: PreviewView
    private lateinit var torchButton: TextView
    private lateinit var flashOverlay: View
    private lateinit var statusChip: TextView
    /** v9.1: in-window feedback banner — "✓ أُضيف: ...". */
    private var resultBanner: TextView? = null
    private val bannerHide = Runnable {
        resultBanner?.visibility = View.GONE
    }
    /** v9.2 (round-15 #5): engine chrome + the in-camera switcher.
     *  Both chromes exist in the combined window; visibility follows
     *  the active engine. */
    private var scanLine: View? = null
    private var barcodeHint: TextView? = null
    private var shutter: View? = null
    private var photoHint: TextView? = null
    private var switchBarcodeSeg: TextView? = null
    private var switchPhotoSeg: TextView? = null

    // ═══════════════════════════════════════════════════════════
    // Lifecycle
    // ═══════════════════════════════════════════════════════════

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        liveInstances.incrementAndGet()
        liveInstance = java.lang.ref.WeakReference(this)

        // v8.3 CRASH SHIELD (round-12 #1):
        //  1. The UI is built and attached BEFORE anything else can
        //     happen — the window is NEVER view-less, not even while
        //     the permission dialog shows on top of it.
        //  2. Everything is wrapped in catch-Throwable: an OEM camera
        //     stack throwing an Error (not an Exception) used to kill
        //     the whole app; now every failure becomes a readable
        //     error handed back to JS with the exception class name.
        try {
            // v9.2: the ACTIVE engine follows the launch mode (the
            // combined window starts on BARCODE and flips live).
            engineIsBarcode = modeValue != MODE_PHOTO
            buildUi()
            setContentView(root)
        } catch (error: Throwable) {
            finishWithError(
                "فشل تهيئة نافذة الماسح: " +
                    error.javaClass.simpleName +
                    (error.message?.let { " — $it" } ?: "")
            )
            return
        }

        // v8.2 (round-11 #1): ASK for the camera the first time — the
        // app used to die instantly with "فعّله من إعدادات النظام"
        // because nothing ever requested the permission at runtime.
        // v9: kept (the dialog appeared and granted correctly on the
        // merchant's device). JS (scanFlow.ensureCameraPermission)
        // almost always grants it before this window even starts —
        // this is the safety net.
        val hasPermission = runCatching {
            ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED
        }.getOrDefault(false)
        if (!hasPermission) {
            runCatching {
                ActivityCompat.requestPermissions(
                    this, arrayOf(Manifest.permission.CAMERA), REQUEST_CAMERA
                )
            }.onFailure {
                finishWithError("تعذر طلب إذن الكاميرا — فعّله من إعدادات النظام")
            }
            return
        }
        onReady()
    }

    /** Everything that happens once the camera permission is in hand. */
    private fun onReady() {
        if (isFinishing || isDestroyed) {
            return
        }
        try {
            bindCamera()
        } catch (error: Throwable) {
            // v8.3: bindCamera itself only schedules work, but a ROM
            // could still throw synchronously — never crash for it.
            finishWithError(
                "تعذر بدء الكاميرا: " +
                    error.javaClass.simpleName +
                    (error.message?.let { " — $it" } ?: "")
            )
            return
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
            runCatching {
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
            }.onFailure {
                finishWithError("لم يُمنح إذن الكاميرا — فعّله من إعدادات النظام")
            }
        } else {
            // Permanently denied — only the system settings page can fix it.
            runCatching {
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
            }.onFailure {
                finishWithError("لم يُمنح إذن الكاميرا — فعّله من إعدادات النظام")
            }
        }
    }

    override fun onStart() {
        super.onStart()
        // v8.3: shielded — a lifecycle hiccup must never kill the app.
        runCatching { cameraHost.resume() }
    }

    override fun onStop() {
        super.onStop()
        // v8.3: shielded.
        runCatching { cameraHost.pause() }
    }

    override fun onDestroy() {
        super.onDestroy()
        liveInstances.decrementAndGet()
        if (settled.compareAndSet(false, true)) {
            // Guarantee the JS promise never hangs if the system kills us.
            finishWithError("أُغلق الماسح قبل إكمال العملية")
        }
        // v8.1: a continuous session is over — drop the stream sink so
        // a stale activity can never leak reads into a new session.
        if (isContinuous) {
            ScannerActivity.continuousSink = null
        }
        // v9.1: same for the multi-shot visual session + the live
        // instance used for JS result feedback.
        if (isMultiPhoto) {
            ScannerActivity.photoSink = null
        }
        if (liveInstance?.get() === this) {
            liveInstance = null
        }
        runCatching { cameraHost.destroy() }
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
        // v8.3: shielded — insets quirks on OEM ROMs must never crash.
        topBar.setOnApplyWindowInsetsListener { v, insets ->
            runCatching {
                val bars = WindowInsetsCompat.toWindowInsetsCompat(insets)
                    .getInsets(WindowInsetsCompat.Type.systemBars())
                v.setPadding(v.paddingLeft, bars.top + dp(8), v.paddingRight, v.paddingBottom)
            }
            insets
        }

        val closeButton = chip("إغلاق", chipBg, stroke).apply {
            setOnClickListener { finishCancelled() }
        }
        statusChip = chip(statusChipText(), chipBg, stroke)
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

        // 3.5) v9.1: in-window RESULT banner — JS confirms every
        //     streamed read ("✓ اسم المنتج" / "غير مسجل") so the
        //     merchant sees the outcome WITHOUT leaving the camera.
        resultBanner = TextView(this).apply {
            visibility = View.GONE
            textSize = 14f
            setPadding(dp(16), dp(9), dp(16), dp(9))
            background = GradientDrawable().apply {
                cornerRadius = dp(14).toFloat()
                setColor(Color.parseColor("#E6121216"))
                setStroke(dp(1), Color.parseColor("#33FFFFFF"))
            }
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.TOP or Gravity.CENTER_HORIZONTAL
            )
        }
        resultBanner?.setOnApplyWindowInsetsListener { v, insets ->
            runCatching {
                val bars = WindowInsetsCompat.toWindowInsetsCompat(insets)
                    .getInsets(WindowInsetsCompat.Type.systemBars())
                (v.layoutParams as FrameLayout.LayoutParams).topMargin =
                    bars.top + dp(58)
                v.requestLayout()
            }
            insets
        }
        root.addView(resultBanner)

        // 4) Mode-specific chrome. In the COMBINED window (v9.2)
        //    BOTH chromes exist and visibility follows the active
        //    engine; in single-engine windows only that engine's
        //    chrome is built (byte-for-byte the proven v9.1 path).
        if (modeValue != MODE_PHOTO) {
            // Red laser line with a subtle animated sweep.
            scanLine = View(this).apply {
                setBackgroundColor(Color.parseColor("#FF3B30"))
                layoutParams = FrameLayout.LayoutParams(
                    dp(230), dp(2), Gravity.CENTER
                )
            }
            root.addView(scanLine)
            animateScanLine(scanLine!!)

            barcodeHint = hintView(
                if (isContinuous) {
                    if (isBothMode) {
                        "امسح ملصق الباركود — كل قراءة تُضاف للسلة · بدّل للبصري بالمفتاح بالأسفل"
                    } else {
                        "امسح عدة منتجات — كل قراءة تُضاف للسلة فوراً · إغلاق للإنهاء"
                    }
                } else {
                    "وجّه الكاميرا نحو ملصق الباركود — يُقفل تلقائياً عند القراءة"
                }
            )
            root.addView(barcodeHint)
        }
        if (modeValue != MODE_BARCODE) {
            // Shutter: big white ring + inner disc, bottom-center.
            // v9: single deliberate shot per window (the v8.1 flow the
            // merchant's device ran crash-free).
            shutter = FrameLayout(this).apply {
                layoutParams = FrameLayout.LayoutParams(
                    dp(74), dp(74), Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
                )
            }
            shutter!!.addView(View(this).apply {
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
            shutter!!.addView(View(this).apply {
                background = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(Color.WHITE)
                }
                layoutParams = FrameLayout.LayoutParams(
                    dp(56), dp(56), Gravity.CENTER
                )
            })
            shutter!!.setOnClickListener { capturePhoto() }
            root.addView(shutter)

            photoHint = hintView(
                if (isMultiPhoto) {
                    if (isBothMode) {
                        "صوّر المنتج واحداً تلو الآخر — كل تعرّف يُضاف للسلة · بدّل للباركود بالمفتاح بالأسفل"
                    } else {
                        "صوّر المنتجات واحداً تلو الآخر — كل صورة تُميّز وتُضاف للسلة · إغلاق للإنهاء"
                    }
                } else {
                    "عبّئ الإطار بالمنتج ثم اضغط زر التصوير"
                }
            )
            root.addView(photoHint)
        }

        // 5) v9.2 (round-15 #5): the in-camera ENGINE SWITCHER — a
        //    big two-segment pill (باركود | بصري) that flips the
        //    active engine with one tap, camera never closing. The
        //    merchant's exact ask: easy switching while both engines
        //    are selected and the camera is running.
        if (isBothMode) {
            val switcher = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER
                background = GradientDrawable().apply {
                    cornerRadius = dp(24).toFloat()
                    setColor(Color.parseColor("#CC1C1C22"))
                    setStroke(dp(1), Color.parseColor("#33FFFFFF"))
                }
                setPadding(dp(6), dp(6), dp(6), dp(6))
                layoutParams = FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
                )
            }
            switchBarcodeSeg = engineSegment("باركود").apply {
                setOnClickListener { switchEngine(toBarcode = true) }
            }
            switchPhotoSeg = engineSegment("بصري").apply {
                setOnClickListener { switchEngine(toBarcode = false) }
            }
            switcher.addView(switchBarcodeSeg)
            switcher.addView(switchPhotoSeg)
            switcher.setOnApplyWindowInsetsListener { v, insets ->
                runCatching {
                    val bars = WindowInsetsCompat.toWindowInsetsCompat(insets)
                        .getInsets(WindowInsetsCompat.Type.systemBars())
                    (v.layoutParams as FrameLayout.LayoutParams).bottomMargin =
                        bars.bottom + dp(170)
                    v.requestLayout()
                }
                insets
            }
            root.addView(switcher)
            updateEngineChrome()
            updateSwitcherUi()
        }
    }

    /** v9.2: one switcher segment (باركود / بصري). */
    private fun engineSegment(label: String): TextView =
        TextView(this).apply {
            text = label
            textSize = 15f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            setPadding(dp(22), dp(10), dp(22), dp(10))
        }

    /** v9.2: the status-chip text for the current window state. */
    private fun statusChipText(): String = when {
        isBothMode ->
            (if (engineIsBarcode) "باركود" else "بصري") +
                " · ${confirmedCount.get()}"
        isContinuous -> "مسح متعدد · ${confirmedCount.get()}"
        isMultiPhoto -> "بصري متعدد · ${confirmedCount.get()}"
        engineIsBarcode -> "ماسح الباركود"
        else -> "المسح البصري"
    }

    private fun updateStatusChip() {
        statusChip.text = statusChipText()
    }

    /** v9.2: flip the chrome visibility to the active engine. */
    private fun updateEngineChrome() {
        val barcodeActive = engineIsBarcode
        scanLine?.visibility = if (barcodeActive) View.VISIBLE else View.GONE
        barcodeHint?.visibility = if (barcodeActive) View.VISIBLE else View.GONE
        shutter?.visibility = if (barcodeActive) View.GONE else View.VISIBLE
        photoHint?.visibility = if (barcodeActive) View.GONE else View.VISIBLE
    }

    /** v9.2: highlight the active switcher segment (app accent). */
    private fun updateSwitcherUi() {
        val segments = listOfNotNull(switchBarcodeSeg, switchPhotoSeg)
        if (segments.isEmpty()) {
            return
        }
        val accent = Color.parseColor("#F97316")
        val activeBg = GradientDrawable().apply {
            cornerRadius = dp(19).toFloat()
            setColor(accent)
        }
        for (segment in segments) {
            val active =
                (segment === switchBarcodeSeg) == engineIsBarcode
            segment.background = if (active) activeBg else null
            segment.setTextColor(if (active) Color.WHITE else Color.parseColor("#C8C8CE"))
        }
    }

    /**
     * v9.2 (round-15 #5): flip the active engine INSIDE the combined
     * window — a normal user-paced CameraX rebind (unbind → bind the
     * other engine's use case), exactly one switch per tap, never an
     * auto-loop. The camera window stays open the whole time; this
     * is the easy live switching the merchant asked for.
     */
    private fun switchEngine(toBarcode: Boolean) {
        if (toBarcode == engineIsBarcode || settled.get() || isFinishing) {
            return
        }
        engineIsBarcode = toBarcode
        vibrate(25)
        updateEngineChrome()
        updateSwitcherUi()
        updateStatusChip()
        // Drop any stale capture handle — the photo engine builds a
        // fresh one when the merchant switches back.
        imageCapture = null
        try {
            startCamera()
        } catch (error: Throwable) {
            // v8.3-style shield: never crash for a rebind failure.
            finishWithError(
                "تعذر تبديل المحرك: " + error.javaClass.simpleName +
                    (error.message?.let { " — $it" } ?: "")
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
                setColor(Color.parseColor("#B31C1C22"))
            }
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
            )
        }.also { hint ->
            hint.setOnApplyWindowInsetsListener { v, insets ->
                // v8.3: shielded.
                runCatching {
                    val bars = WindowInsetsCompat.toWindowInsetsCompat(insets)
                        .getInsets(WindowInsetsCompat.Type.systemBars())
                    (v.layoutParams as FrameLayout.LayoutParams).bottomMargin =
                        bars.bottom + dp(86)
                    v.requestLayout()
                }
                insets
            }
        }

    private fun animateScanLine(line: View) {
        line.post {
            runCatching {
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
                                    .withEndAction {
                                        if (!isFinishing) animateScanLine(line)
                                    }
                                    .start()
                            }
                            .start()
                    }
                    .start()
            }
        }
    }

    // ═══════════════════════════════════════════════════════════
    // Camera
    // ═══════════════════════════════════════════════════════════

    private fun bindCamera() {
        val future = runCatching { ProcessCameraProvider.getInstance(this) }
            .getOrNull()
        if (future == null) {
            finishWithError("تعذر تهيئة مزود الكاميرا على هذا الجهاز")
            return
        }
        future.addListener(
            {
                // v8.3: catch Throwable — an OEM camera stack can throw
                // Error subtypes that `catch (Exception)` let through,
                // killing the whole app (round-12 #1).
                try {
                    cameraProvider = future.get()
                    startCamera()
                } catch (error: Throwable) {
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
                // v9: the EXACT v8.1.0 photo builder — no resolution
                // selector, no special mode. This is the configuration
                // the merchant's device captured photos with, crash
                // free, before the v8.2 machinery.
                val capture = ImageCapture.Builder()
                    .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                    .build()
                    .also { imageCapture = it }
                provider.unbindAll()
                provider.bindToLifecycle(cameraHost, selector, preview, capture)
            }
            applyTorch()
        } catch (firstError: Throwable) {
            // v8.3: catch Throwable (was Exception) — OEM camera stacks
            // can throw Error subtypes; those killed the whole app.
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
                            val capture = ImageCapture.Builder().build()
                                .also { imageCapture = it }
                            provider.bindToLifecycle(cameraHost, selector, preview, capture)
                        }
                        applyTorch()
                    } catch (secondError: Throwable) {
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
                    // v8.3: shielded — an exception inside a Play
                    // Services task listener is PROCESS DEATH.
                    runCatching {
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
                }
                .addOnCompleteListener {
                    runCatching { proxy.close() }
                }
        } catch (_: Throwable) {
            // v8.3: Throwable — some HALs throw OOM-adjacent errors on
            // frame wrap; close and move on.
            runCatching { proxy.close() }
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
            // v9.1 (round-14 #1): the chip shows the CONFIRMED count
            // only — JS confirms registered adds via notifyResult.
            // v9.2: unified through statusChipText() (combined window
            // shows the ACTIVE engine + confirmed count).
            updateStatusChip()
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

    /** v9: the EXACT v8.1.0 single-shot capture — one deliberate
     *  photo, one timestamped file, the window closes and returns
     *  the path to JS (which re-opens it for the next product).
     *  v9.1 MULTI mode (round-14 #2): the same deliberate capture,
     *  but the window STAYS OPEN — the path is streamed to JS via
     *  photoSink and the shutter re-arms. Camera-pipeline load is
     *  identical to single-shot (one capture per press — never the
     *  v8.2 auto-loop that saturated budget HALs). */
    private fun capturePhoto() {
        val capture = imageCapture
        if (capture == null || settled.get()) {
            return
        }
        if (isMultiPhoto && !captureBusy.compareAndSet(false, true)) {
            return // A capture is still saving — ignore the extra press.
        }
        vibrate(25)
        val dir = File(filesDir, "scans").apply { mkdirs() }
        val file = File(dir, "scan_${System.currentTimeMillis()}.jpg")
        val outputOptions = ImageCapture.OutputFileOptions.Builder(file).build()
        capture.takePicture(
            outputOptions,
            ContextCompat.getMainExecutor(this),
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(output: ImageCapture.OutputFileResults) {
                    // v8.3: shielded — a capture callback exception on
                    // an OEM HAL is process death otherwise.
                    runCatching {
                        if (isMultiPhoto) {
                            captureBusy.set(false)
                            if (settled.get()) {
                                return@runCatching
                            }
                            // Multi-shot: stream + keep the window open.
                            flash(Color.parseColor("#66FFFFFF"), 140)
                            vibrate(20)
                            continuousReads.incrementAndGet()
                            updateStatusChip()
                            showScanResult(false, "جارٍ التعرّف…")
                            runCatching {
                                ScannerActivity.photoSink?.invoke(file.absolutePath)
                            }
                        } else if (settled.compareAndSet(false, true)) {
                            flash(Color.parseColor("#66FFFFFF"), 140)
                            setResultAndFinish(path = file.absolutePath)
                        }
                    }
                }

                override fun onError(error: ImageCaptureException) {
                    runCatching {
                        captureBusy.set(false)
                        if (isMultiPhoto) {
                            // v9.2 (round-15 #5): in a multi-shot or
                            // combined window ONE failed capture (e.g.
                            // the merchant flipped the engine mid-save)
                            // must NEVER end the session — say it in the
                            // banner and keep the window open.
                            showScanResult(
                                false,
                                "فشل التقاط الصورة — أعد المحاولة"
                            )
                        } else if (settled.compareAndSet(false, true)) {
                            finishWithError(
                                "فشل التقاط الصورة: ${error.javaClass.simpleName}" +
                                    (error.message?.let { " — $it" } ?: "")
                            )
                        }
                    }
                }
            }
        )
    }

    // ── v9.1: in-window scan feedback ──────────────────────

    /** Shows the JS-confirmed outcome of a streamed read:
     *  ok=true  → green "✓ message" + CONFIRMED counter +1
     *             (only registered products reach here),
     *  ok=false → red informational message (لم يتم التعرف /
     *             جارٍ التعرّف… / فشل الالتقاط…).
     *  Round-14 #1: the counter chip counts CONFIRMED adds only.
     *  v9.2: unified chip text (combined window shows the ACTIVE
     *  engine name + confirmed count). */
    private fun showScanResult(ok: Boolean, message: String) {
        val banner = resultBanner ?: return
        if (ok) {
            confirmedCount.incrementAndGet()
        }
        updateStatusChip()
        banner.text = if (ok) "✓ $message" else message
        banner.setTextColor(
            if (ok) Color.parseColor("#4ADE80") else Color.parseColor("#F87171")
        )
        banner.visibility = View.VISIBLE
        banner.removeCallbacks(bannerHide)
        banner.postDelayed(bannerHide, 1900)
    }

    // ── Torch ─────────────────────────────────────────────────

    private fun toggleTorch() {
        torchOn = !torchOn
        applyTorch()
    }

    private fun applyTorch() {
        // v8.3: rewritten clean + fully shielded — any flash-unit
        // probe failure escaped as a crash on some ROMs.
        runCatching {
            val unit = camera ?: return
            val available = unit.cameraInfo.hasFlashUnit()
            runCatching { unit.cameraControl.enableTorch(torchOn && available) }
            val active = torchOn && available
            torchButton.background = GradientDrawable().apply {
                cornerRadius = dp(18).toFloat()
                if (active) {
                    setColor(Color.parseColor("#F97316"))
                } else {
                    setColor(Color.parseColor("#CC1C1C22"))
                    setStroke(dp(1), Color.parseColor("#33FFFFFF"))
                }
            }
            torchButton.setTextColor(
                if (active) {
                    Color.WHITE
                } else {
                    Color.parseColor("#E7E7EA")
                }
            )
            if (!available) {
                torchButton.text = "لا فلاش"
            }
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
        // v8.3: shielded.
        runCatching {
            flashOverlay.setBackgroundColor(color)
            flashOverlay.visibility = View.VISIBLE
            flashOverlay.alpha = 1f
            flashOverlay.animate()
                .alpha(0f)
                .setDuration(durationMs)
                .withEndAction { flashOverlay.visibility = View.GONE }
                .start()
        }
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
