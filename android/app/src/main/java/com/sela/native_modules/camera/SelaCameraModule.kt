package com.sela.native_modules.camera

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * SelaCameraModule
 * ─────────────────────────────────────────────────────────────────
 * JS entry point for the native camera view:
 *   SelaCamera.capture(viewTag)  -> Promise<photoPath>
 *   SelaCamera.rebind(viewTag)   -> Promise<boolean>
 *
 * The preview itself is the SelaCameraView native component; this
 * module locates the live view by its React tag and forwards calls.
 */
class SelaCameraModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "SelaCamera"

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
}
