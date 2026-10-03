package com.sela.native_modules.camera

import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp

/**
 * SelaCameraViewManager
 * ─────────────────────────────────────────────────────────────────
 * Exposes SelaCameraView to JS as <SelaCameraView />.
 *
 * v7: PROPS ONLY. All camera state (ready / error / barcode) now
 * travels over the SelaCameraModule event channel
 * (RCTDeviceEventEmitter) — the old custom view events could be
 * silently dropped by the Fabric interop layer inside Modals, which
 * is why the camera "never worked" while actually being live. See
 * SelaCameraModule for the full story.
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
}
