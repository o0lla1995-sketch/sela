package com.sela.native_modules

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager
import com.sela.native_modules.camera.SelaCameraModule
import com.sela.native_modules.camera.SelaCameraViewManager

/**
 * SelaPackage
 * ─────────────────────────────────────────────────────────────────
 * Registers this app's hand-written native modules:
 *  - ThermalPrinter : Bluetooth SPP + ESC/POS thermal printing
 *  - PlatformUtils  : beep tone, report export, file helpers,
 *                     device id / monotonic uptime / ABI
 *  - ImageDecoder   : photo → raw RGB for the vision pipeline
 *  - SelaNotifications : local stock-alert notifications
 *  - SelaCamera     : CameraX preview + capture + offline barcode
 *                     (SelaCameraView native component)
 */
class SelaPackage : ReactPackage {

  override fun createNativeModules(
    reactContext: ReactApplicationContext
  ): List<NativeModule> = listOf(
    ThermalPrinterModule(reactContext),
    PlatformUtilsModule(reactContext),
    ImageDecoderModule(reactContext),
    NotificationsModule(reactContext),
    ImagePickerModule(reactContext),
    SelaCameraModule(reactContext)
  )

  override fun createViewManagers(
    reactContext: ReactApplicationContext
  ): List<ViewManager<*, *>> = listOf(SelaCameraViewManager())
}
