package com.sela.native_modules.camera

import com.facebook.react.common.MapBuilder
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp

/**
 * SelaCameraViewManager
 * ─────────────────────────────────────────────────────────────────
 * Exposes SelaCameraView to JS as <SelaCameraView />.
 *
 * Props:
 *   barcodeEnabled   — run the offline ML Kit barcode analyzer
 *   torch            — flashlight (no camera rebind)
 *   permissionGranted— JS-side permission gate (belt & suspenders)
 *
 * Events (direct, top-* mapping):
 *   onReadCode    { codeStringValue }
 *   onCameraError { errorMessage }
 *   onCameraReady { }
 */
class SelaCameraViewManager : SimpleViewManager<SelaCameraView>() {

    override fun getName(): String = "SelaCameraView"

    override fun createViewInstance(reactContext: ThemedReactContext): SelaCameraView =
        SelaCameraView(reactContext)

    @ReactProp(name = "barcodeEnabled")
    fun setBarcodeEnabled(view: SelaCameraView, enabled: Boolean) {
        view.setBarcodeEnabledProp(enabled)
    }

    @ReactProp(name = "torch")
    fun setTorch(view: SelaCameraView, enabled: Boolean) {
        view.setTorchProp(enabled)
    }

    @ReactProp(name = "permissionGranted")
    fun setPermissionGranted(view: SelaCameraView, granted: Boolean) {
        view.setPermissionGrantedProp(granted)
    }

    override fun getExportedCustomDirectEventTypeConstants(): Map<String, Any> =
        mapOf(
            CameraReadCodeEvent.EVENT_NAME to
                mapOf("registrationName" to "onReadCode"),
            CameraErrorEvent.EVENT_NAME to
                mapOf("registrationName" to "onCameraError"),
            CameraReadyEvent.EVENT_NAME to
                mapOf("registrationName" to "onCameraReady"),
        )
}
