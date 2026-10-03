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
        val activity: Activity? = currentActivity
        if (activity == null) {
            promise.reject("E_NO_ACTIVITY", "لا توجد نافذة نشطة لفتح الماسح", null)
            return
        }
        if (pendingPromise != null) {
            promise.reject("E_BUSY", "الماسح مفتوح بالفعل", null)
            return
        }

        pendingPromise = promise
        try {
            val intent = Intent(activity, ScannerActivity::class.java)
                .putExtra(
                    ScannerActivity.EXTRA_MODE,
                    if (mode == ScannerActivity.MODE_PHOTO) {
                        ScannerActivity.MODE_PHOTO
                    } else {
                        ScannerActivity.MODE_BARCODE
                    }
                )
            activity.startActivityForResult(intent, REQUEST_SCAN)
        } catch (error: Exception) {
            pendingPromise = null
            promise.reject(
                "E_OPEN",
                "تعذر فتح الماسح: ${error.javaClass.simpleName}" +
                    (error.message?.let { " — $it" } ?: ""),
                null
            )
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
