package com.sela.native_modules.camera

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.events.Event

/** Fired when the ML Kit analyzer reads a new (deduped) barcode. */
class CameraReadCodeEvent(
    surfaceId: Int,
    viewId: Int,
    private val codeStringValue: String,
) : Event<CameraReadCodeEvent>(surfaceId, viewId) {
    override fun getEventName(): String = EVENT_NAME

    override fun getEventData(): WritableMap =
        Arguments.createMap().apply {
            putString("codeStringValue", codeStringValue)
        }

    companion object {
        const val EVENT_NAME = "topReadCode"
    }
}

/** Fired when the camera fails to start or dies mid-session. */
class CameraErrorEvent(
    surfaceId: Int,
    viewId: Int,
    private val errorMessage: String,
) : Event<CameraErrorEvent>(surfaceId, viewId) {
    override fun getEventName(): String = EVENT_NAME

    override fun getEventData(): WritableMap =
        Arguments.createMap().apply {
            putString("errorMessage", errorMessage)
        }

    companion object {
        const val EVENT_NAME = "topError"
    }
}

/** Fired once the preview stream is live and ready to capture/scan. */
class CameraReadyEvent(
    surfaceId: Int,
    viewId: Int,
) : Event<CameraReadyEvent>(surfaceId, viewId) {
    override fun getEventName(): String = EVENT_NAME

    override fun getEventData(): WritableMap = Arguments.createMap()

    companion object {
        const val EVENT_NAME = "topCameraReady"
    }
}
