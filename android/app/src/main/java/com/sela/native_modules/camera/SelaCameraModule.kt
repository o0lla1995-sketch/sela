package com.sela.native_modules.camera

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * SelaCameraModule v7 — the camera COORDINATOR.
 * ─────────────────────────────────────────────────────────────────
 * Why this shape (after five failed camera generations):
 *
 *  Every previous stack delivered camera state through CUSTOM VIEW
 *  EVENTS (topCameraReady / topCameraError / topReadCode) dispatched
 *  via UIManagerHelper.getEventDispatcherForReactTag. This app runs
 *  with the New Architecture (Fabric) enabled, where custom
 *  SimpleViewManager events must cross the interop layer — and for
 *  views mounted inside a React Native <Modal> (its own Fabric
 *  content host) that dispatch can fail SILENTLY. Result: the native
 *  camera could be perfectly live while JS never received "ready",
 *  the JS watchdog fired, and the merchant saw
 *  "تعذر تشغيل الكاميرا" over a WORKING camera.
 *
 *  v7 removes that entire failure class:
 *
 *  1. ALL camera events now travel over RCTDeviceEventEmitter (the
 *     module-level global channel used by every battle-tested RN
 *     library). It works identically on Paper and Fabric, needs no
 *     surface id, no view-tag dispatch, no interop registration.
 *       selaCameraReady   { viewTag }
 *       selaCameraError   { viewTag, message }
 *       selaCameraBarcode { viewTag, code }
 *
 *  2. JS polls getStatus(viewTag) as a second source of truth — even
 *     if an event is lost, the true bound/preview state is visible,
 *     so the watchdog can NEVER lie again.
 *
 *  3. ONE live camera at a time, enforced natively: when a new view
 *  registers, the previous holder is synchronously force-released
 *  (budget HALs expose a single back camera — two concurrent binds
 *  kill both sessions with MAXIMUM_NUMBER_OF_CAMERAS_IN_USE).
 *
 *  4. runDiagnostics() binds headlessly (no UI) and reports exactly
 *     WHY the camera failed on a specific device — permission,
 *     provider, camera list, bind result — so the real cause on a
 *     problem phone is finally visible in-app.
 */
class SelaCameraModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val EVENT_READY = "selaCameraReady"
        const val EVENT_ERROR = "selaCameraError"
        const val EVENT_BARCODE = "selaCameraBarcode"

        /**
         * Bulletproof handle for the view → module link. The module
         * is constructed exactly once per ReactContext; the view
         * looks it up here (getNativeModule(Class) can behave
         * differently across interop configurations — this can't).
         */
        @Volatile private var instance: SelaCameraModule? = null

        /** The static handle the native view uses to reach this module. */
        fun current(): SelaCameraModule? = instance
    }

    init {
        instance = this
    }

    override fun getName(): String = "SelaCamera"

    // ── Coordinator state ───────────────────────────────────────

    /** The one view currently allowed to hold the camera. */
    @Volatile private var activeViewTag: Int? = null

    /**
     * A new view wants the camera → force-release the previous
     * holder FIRST. Called on the main thread from the view itself.
     */
    fun claimCamera(tag: Int) {
        val previousTag = activeViewTag
        if (previousTag != null && previousTag != tag) {
            SelaCameraView.find(previousTag)?.forceReleaseForReplacement()
        }
        activeViewTag = tag
    }

    fun releaseClaim(tag: Int) {
        if (activeViewTag == tag) {
            activeViewTag = null
        }
    }

    // ── Module events (the reliable channel) ────────────────────

    fun emitReady(viewTag: Int) =
        emitEvent(EVENT_READY) {
            putInt("viewTag", viewTag)
        }

    fun emitError(viewTag: Int, message: String) =
        emitEvent(EVENT_ERROR) {
            putInt("viewTag", viewTag)
            putString("message", message)
        }

    fun emitBarcode(viewTag: Int, code: String) =
        emitEvent(EVENT_BARCODE) {
            putInt("viewTag", viewTag)
            putString("code", code)
        }

    private fun emitEvent(name: String, fill: WritableMap.() -> Unit) {
        try {
            val jsModule = reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            val payload = Arguments.createMap().apply(fill)
            jsModule.emit(name, payload)
        } catch (_: Exception) {
            // The JS side may be tearing down — dropping is harmless.
        }
    }

    // ── JS API ──────────────────────────────────────────────────

    @ReactMethod
    fun capture(viewTag: Int, promise: Promise) {
        val view = SelaCameraView.find(viewTag)
        if (view == null) {
            promise.reject("E_NO_CAMERA_VIEW", "عرض الكاميرا غير متوفر", null)
            return
        }
        view.capture(promise)
    }

    @ReactMethod
    fun rebind(viewTag: Int, promise: Promise) {
        val view = SelaCameraView.find(viewTag)
        if (view == null) {
            promise.reject("E_NO_CAMERA_VIEW", "عرض الكاميرا غير متوفر", null)
            return
        }
        view.rebind(promise)
    }

    /**
     * The SECOND source of truth: JS polls this while the scanner is
     * open. If the native session is bound and the preview live, the
     * UI flips to ready even if the ready EVENT was lost — the
     * watchdog false-positive class of bugs dies here.
     */
    @ReactMethod
    fun getStatus(viewTag: Int, promise: Promise) {
        val view = SelaCameraView.find(viewTag)
        if (view == null) {
            val absent = Arguments.createMap().apply {
                putBoolean("exists", false)
                putBoolean("bound", false)
                putBoolean("previewLive", false)
                putString("state", "detached")
                putString("lastError", "")
                putInt("width", 0)
                putInt("height", 0)
            }
            promise.resolve(absent)
            return
        }
        promise.resolve(view.stateSnapshot())
    }

    /**
     * Headless camera self-test (Diagnostics screen): checks the
     * permission, the CameraX provider, the back-camera list and one
     * real preview bind — WITHOUT any UI. Returns every step's
     * outcome so the REAL device-specific failure is visible.
     *
     * CameraX requires all view/bind work on the MAIN thread — the
     * whole test is posted there and the promise resolves from it.
     */
    @ReactMethod
    fun runDiagnostics(promise: Promise) {
        val report = Arguments.createMap()
        val ctx = reactApplicationContext
        report.putBoolean(
            "permissionGranted",
            androidx.core.content.ContextCompat.checkSelfPermission(
                ctx, android.Manifest.permission.CAMERA
            ) == android.content.pm.PackageManager.PERMISSION_GRANTED
        )
        // Provider init (safe off-main; the future does the work).
        var provider: androidx.camera.lifecycle.ProcessCameraProvider? = null
        try {
            provider = androidx.camera.lifecycle.ProcessCameraProvider
                .getInstance(ctx)
                .get(6, java.util.concurrent.TimeUnit.SECONDS)
            report.putBoolean("providerOk", true)
            report.putInt("cameraCount", provider.availableCameraInfos.size)
            // The canonical way to count back cameras (works on
            // vendor ROMs with customized lens lists).
            val backCameras = androidx.camera.core.CameraSelector.DEFAULT_BACK_CAMERA
                .filter(provider.availableCameraInfos)
            report.putBoolean("hasBackCamera", backCameras.isNotEmpty())
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

        // The real bind test — on the main thread, on a detached view.
        android.os.Handler(android.os.Looper.getMainLooper()).post {
            var testView: SelaCameraView? = null
            try {
                testView = SelaCameraView(ctx)
                val bindOk = testView.diagnosticBind(provider)
                report.putBoolean("previewBindOk", bindOk)
                report.putString(
                    "bindError",
                    if (bindOk) "" else (testView.lastBindError() ?: "خطأ غير معروف")
                )
                report.putString("result", if (bindOk) "ok" else "bind-failed")
            } catch (error: Exception) {
                report.putBoolean("previewBindOk", false)
                report.putString("bindError", error.message ?: "خطأ غير معروف")
                report.putString("result", "bind-failed")
            } finally {
                testView?.releaseForDiagnostics()
            }
            promise.resolve(report)
        }
    }
}
