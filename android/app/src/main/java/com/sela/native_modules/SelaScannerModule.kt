package com.sela.native_modules

import android.app.Activity
import android.content.Intent
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * SelaScannerModule — v8 scanner gateway.
 * ─────────────────────────────────────────────────────────────────
 *  THE ARCHITECTURE CHANGE (after six failed in-RN camera
 *  generations):
 *
 *  The camera preview no longer lives inside the React Native view
 *  tree AT ALL. `openScanner(mode)` launches the native full-screen
 *  ScannerActivity (its own window, Android-laid-out — a black
 *  screen is structurally impossible) and resolves a promise with
 *  the result:
 *
 *    { cancelled: true }              user closed
 *    { code: "629..." }               barcode engine succeeded
 *    { path: "/data/.../scan.jpg" }   photo engine succeeded
 *    reject(message)                  the activity reported an error
 *
 *  The two engines are FULLY INDEPENDENT (merchant request): the
 *  barcode engine (Preview + ML Kit analysis) and the photo engine
 *  (Preview + ImageCapture) never share a use case, a surface or a
 *  lifecycle — one failing can never take the other down.
 *
 *  runDiagnostics() keeps the same report shape the Diagnostics
 *  screen already renders (permission → provider → cameras →
 *  headless bind) and adds a real torch probe.
 */
class SelaScannerModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), 
    com.facebook.react.bridge.ActivityEventListener {

    companion object {
        private const val REQUEST_SCAN = 47831
        /** v8.1: event name for live barcode reads in a continuous session. */
        private const val BARCODE_READ_EVENT = "selaScanBarcode"
        /** v9.1: event name for live photo paths in a multi-shot
         *  VISUAL session (round-14 #2). */
        private const val PHOTO_TAKEN_EVENT = "selaScanPhoto"
    }

    private var pendingPromise: Promise? = null

    init {
        reactContext.addActivityEventListener(this)
    }

    override fun getName(): String = "SelaScanner"

    override fun onCatalystInstanceDestroy() {
        reactApplicationContext.removeActivityEventListener(this)
        super.onCatalystInstanceDestroy()
    }

    // ═══════════════════════════════════════════════════════════
    // openScanner
    // ═══════════════════════════════════════════════════════════

    @ReactMethod
    fun openScanner(mode: String, promise: Promise) {
        launchScanner(
            mode,
            continuous = false,
            multi = false,
            promise = promise
        )
    }

    /**
     * v8.1 continuous multi-scan session (barcode engine).
     * Every deduped read is streamed to JS as a "selaScanBarcode"
     * event; the promise resolves {cancelled:true} when the merchant
     * closes the scanner. Separate @ReactMethod so the positional
     * argument mapping of the existing openScanner calls is untouched.
     *
     * v9 (round-13): the VISUAL engine deliberately has NO continuous
     * variant anymore — the v8.2–v8.3 auto-capture machinery is what
     * hard-crashed the merchant's device on every scanner open. The
     * visual flow is once again ONE deliberate photo per window (the
     * v8.1.0 contract this device ran crash-free).
     */
    @ReactMethod
    fun openScannerContinuous(promise: Promise) {
        launchScanner(
            ScannerActivity.MODE_BARCODE,
            continuous = true,
            multi = false,
            promise = promise
        )
    }

    /**
     * v9.1 (round-14 #2): the CONTINUOUS multi-shot VISUAL session.
     * The native window stays open; every deliberate shutter press
     * saves a photo and streams its path to JS as a "selaScanPhoto"
     * event. The promise resolves {cancelled:true} when the merchant
     * closes the scanner — the exact shape of the barcode session.
     *
     * SAFETY (this device's history): every capture is a MANUAL
     * press of the same ImageCapture pipeline the crash-free
     * v8.1.0 single-shot used — there is NO auto-capture timer and
     * NO photo streaming loop (the two things that hard-crashed
     * v8.2/v8.3). Only the file PATH crosses the bridge.
     */
    @ReactMethod
    fun openScannerPhotoMulti(promise: Promise) {
        launchScanner(
            ScannerActivity.MODE_PHOTO,
            continuous = false,
            multi = true,
            promise = promise
        )
    }

    /**
     * v9.2 (round-15 #5): the COMBINED session — ONE native window
     * with BOTH engines and an in-camera switcher. The window starts
     * on the BARCODE engine; a big toggle inside the window flips to
     * the VISUAL engine (and back) with a normal user-paced CameraX
     * rebind — the camera never closes. Barcode reads stream as
     * "selaScanBarcode" events and shutter presses as "selaScanPhoto"
     * events; the promise resolves {cancelled:true} when the merchant
     * closes the scanner.
     */
    @ReactMethod
    fun openScannerBoth(promise: Promise) {
        launchScanner(
            ScannerActivity.MODE_BOTH,
            continuous = true,
            multi = true,
            promise = promise
        )
    }

    /**
     * v9.1 (round-14 #1): JS feedback channel for streamed reads.
     * ok=true → the read was a REGISTERED product (name shown in
     * the green banner + the CONFIRMED counter +1); ok=false → the
     * red informational banner (غير مسجل / لم يتم التعرف).
     */
    @ReactMethod
    fun notifyScanResult(ok: Boolean, message: String, promise: Promise) {
        runCatching { ScannerActivity.notifyResult(ok, message) }
        promise.resolve(true)
    }

    /**
     * v39 (الجولة 47): JS-requested IMMEDIATE scanner close. When a
     * streamed read recognizes a product that needs its own sale
     * window — a WEIGHT product (price is typed by weight from the
     * weight pad; the scanner itself cannot price it) or a VARIANT
     * product (color/size must be picked) — JS calls this the moment
     * recognition lands. The live window finishes exactly like a
     * merchant close (session promise settles cancelled → the
     * pending weight-pad/sale-sheet opens instantly on top).
     * No-op when no window is alive.
     */
    @ReactMethod
    fun closeScanner(promise: Promise) {
        runCatching { ScannerActivity.requestClose() }
        promise.resolve(ScannerActivity.isLive())
    }

    private fun launchScanner(mode: String, continuous: Boolean, multi: Boolean, promise: Promise) {
        val activity: Activity? = currentActivity
        if (activity == null) {
            promise.reject("E_NO_ACTIVITY", "لا توجد نافذة نشطة لفتح الماسح", null)
            return
        }
        if (pendingPromise != null) {
            // v8.3 (round-12 #1): a pendingPromise with NO live scanner
            // window is a fossil — the system killed the previous
            // session (process death on permission grant / low memory)
            // before its activity result ever arrived. Recovering it
            // here is what un-jams the scanner after that kill; without
            // this the merchant was stuck on "الماسح مفتوح بالفعل"
            // until a full app restart.
            if (ScannerActivity.isLive()) {
                promise.reject("E_BUSY", "الماسح مفتوح بالفعل", null)
                return
            }
            runCatching {
                pendingPromise?.resolve(
                    com.facebook.react.bridge.Arguments.createMap().apply {
                        putBoolean("cancelled", true)
                    }
                )
            }
            pendingPromise = null
        }

        pendingPromise = promise
        if (continuous) {
            // Stream sink — must exist before the activity can read.
            ScannerActivity.continuousSink = { code -> emitBarcodeRead(code) }
        }
        if (multi) {
            ScannerActivity.photoSink = { path -> emitPhotoTaken(path) }
        }
        try {
            val intent = Intent(activity, ScannerActivity::class.java)
                .putExtra(
                    ScannerActivity.EXTRA_MODE,
                    when (mode) {
                        ScannerActivity.MODE_PHOTO -> ScannerActivity.MODE_PHOTO
                        // v9.2 (round-15 #5): the combined window —
                        // in-camera engine switching while live.
                        ScannerActivity.MODE_BOTH -> ScannerActivity.MODE_BOTH
                        else -> ScannerActivity.MODE_BARCODE
                    }
                )
                .putExtra(ScannerActivity.EXTRA_CONTINUOUS, continuous)
                .putExtra(ScannerActivity.EXTRA_MULTI, multi)
            activity.startActivityForResult(intent, REQUEST_SCAN)
        } catch (error: Exception) {
            if (continuous) {
                ScannerActivity.continuousSink = null
            }
            if (multi) {
                ScannerActivity.photoSink = null
            }
            pendingPromise = null
            promise.reject(
                "E_OPEN",
                "تعذر فتح الماسح: ${error.javaClass.simpleName}" +
                    (error.message?.let { " — $it" } ?: ""),
                null
            )
        }
    }

    /** v8.1: live read stream → JS event. Safe from any thread. */
    private fun emitBarcodeRead(code: String) {
        runCatching {
            val params = Arguments.createMap().apply { putString("code", code) }
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(BARCODE_READ_EVENT, params)
        }
    }

    /** v9.1: live photo-path stream → JS event. Safe from any thread. */
    private fun emitPhotoTaken(path: String) {
        runCatching {
            val params = Arguments.createMap().apply { putString("path", path) }
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(PHOTO_TAKEN_EVENT, params)
        }
    }

    // ═══════════════════════════════════════════════════════════
    // ActivityEventListener
    // ═══════════════════════════════════════════════════════════

    override fun onActivityResult(
        activity: Activity?,
        requestCode: Int,
        resultCode: Int,
        data: Intent?
    ) {
        if (requestCode != REQUEST_SCAN) {
            return
        }
        val promise = pendingPromise ?: return
        pendingPromise = null
        // v8.1: the continuous session is over — drop the stream sink
        // immediately so no stale read can leak into the next session.
        ScannerActivity.continuousSink = null
        // v9.1: same for the multi-shot visual session.
        ScannerActivity.photoSink = null

        try {
            if (resultCode == Activity.RESULT_OK) {
                val code = data?.getStringExtra(ScannerActivity.EXTRA_CODE)
                val path = data?.getStringExtra(ScannerActivity.EXTRA_PATH)
                val result = Arguments.createMap()
                if (code != null) {
                    result.putString("code", code)
                }
                if (path != null) {
                    result.putString("path", path)
                }
                if (code == null && path == null) {
                    result.putBoolean("cancelled", true)
                }
                promise.resolve(result)
            } else {
                val error = data?.getStringExtra(ScannerActivity.EXTRA_ERROR)
                if (error != null) {
                    promise.reject("E_SCANNER", error, null)
                } else {
                    val cancelled = Arguments.createMap()
                    cancelled.putBoolean("cancelled", true)
                    promise.resolve(cancelled)
                }
            }
        } catch (error: Exception) {
            promise.reject(
                "E_RESULT",
                "فشل استلام نتيجة المسح: ${error.message ?: "خطأ غير معروف"}",
                null
            )
        }
    }

    override fun onNewIntent(intent: Intent?) {
        // No-op — required by the interface.
    }

    // ═══════════════════════════════════════════════════════════
    // runDiagnostics — headless self-test (same report shape as v7)
    // ═══════════════════════════════════════════════════════════

    @ReactMethod
    fun runDiagnostics(promise: Promise) {
        val report = Arguments.createMap()
        val ctx = reactApplicationContext

        // 1) Permission.
        val permissionGranted =
            androidx.core.content.ContextCompat.checkSelfPermission(
                ctx, android.Manifest.permission.CAMERA
            ) == android.content.pm.PackageManager.PERMISSION_GRANTED
        report.putBoolean("permissionGranted", permissionGranted)

        // 2) CameraX provider + camera inventory.
        var provider: androidx.camera.lifecycle.ProcessCameraProvider? = null
        try {
            provider = androidx.camera.lifecycle.ProcessCameraProvider
                .getInstance(ctx)
                .get(6, java.util.concurrent.TimeUnit.SECONDS)
            report.putBoolean("providerOk", true)
            report.putInt("cameraCount", provider.availableCameraInfos.size)
            val backCameras = androidx.camera.core.CameraSelector.DEFAULT_BACK_CAMERA
                .filter(provider.availableCameraInfos)
            report.putBoolean("hasBackCamera", backCameras.isNotEmpty())
            // Real torch probe on the primary back camera.
            report.putBoolean(
                "torchSupported",
                backCameras.firstOrNull()?.hasFlashUnit() ?: false
            )
        } catch (error: Exception) {
            provider = null
            report.putBoolean("providerOk", false)
            report.putString(
                "providerError",
                "${error.javaClass.simpleName}: ${error.message ?: "خطأ غير معروف"}"
            )
            report.putString("result", "provider-failed")
        }

        if (provider == null) {
            promise.resolve(report)
            return
        }
        if (!permissionGranted) {
            report.putBoolean("previewBindOk", false)
            report.putString("bindError", "إذن الكاميرا غير ممنوح")
            report.putString("result", "bind-failed")
            promise.resolve(report)
            return
        }

        // 3) Real headless bind (main thread — CameraX requirement).
        android.os.Handler(android.os.Looper.getMainLooper()).post {
            try {
                val host = object : androidx.lifecycle.LifecycleOwner {
                    private val registry = androidx.lifecycle.LifecycleRegistry(this)
                    init {
                        registry.currentState =
                            androidx.lifecycle.Lifecycle.State.RESUMED
                    }
                    override val lifecycle: androidx.lifecycle.Lifecycle
                        get() = registry
                }
                val previewView = androidx.camera.view.PreviewView(ctx).apply {
                    implementationMode =
                        androidx.camera.view.PreviewView.ImplementationMode.COMPATIBLE
                }
                val preview = androidx.camera.core.Preview.Builder().build().also {
                    it.setSurfaceProvider(previewView.surfaceProvider)
                }
                val analysis = androidx.camera.core.ImageAnalysis.Builder()
                    .setBackpressureStrategy(
                        androidx.camera.core.ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST
                    )
                    .build()
                val camera = provider.bindToLifecycle(
                    host,
                    androidx.camera.core.CameraSelector.DEFAULT_BACK_CAMERA,
                    preview,
                    analysis
                )
                report.putBoolean("previewBindOk", true)
                report.putBoolean("torchSupported", camera.cameraInfo.hasFlashUnit())
                report.putString("bindError", "")
                report.putString("result", "ok")
                provider.unbindAll()
            } catch (error: Exception) {
                report.putBoolean("previewBindOk", false)
                report.putString(
                    "bindError",
                    "${error.javaClass.simpleName}: ${error.message ?: "خطأ غير معروف"}"
                )
                report.putString("result", "bind-failed")
            }
            promise.resolve(report)
        }
    }
}
