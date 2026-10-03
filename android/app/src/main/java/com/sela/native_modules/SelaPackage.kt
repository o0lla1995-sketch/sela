package com.sela.native_modules

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * SelaPackage
 * ─────────────────────────────────────────────────────────────────
 * Registers this app's hand-written native modules:
 *  - ThermalPrinter : Bluetooth SPP + ESC/POS thermal printing
 *  - PlatformUtils  : beep tone, report export, file helpers,
 *                     device id / monotonic uptime / ABI
 *  - ImageDecoder   : photo → raw RGB for the vision pipeline
 *  - SelaNotifications : local stock-alert notifications
 *  - ImagePicker    : system image picker for the store logo
 *  - SelaScanner    : v8 native full-screen scanner engines
 *                     (ScannerActivity — barcode ML Kit + photo
 *                     capture) + headless camera diagnostics.
 *
 * NOTE v8: the old SelaCameraView in-RN camera component is GONE —
 * the preview now lives in its own native Activity window, which is
 * what finally killed the black-screen class of bugs for good.
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
    SelaScannerModule(reactContext)
  )

  override fun createViewManagers(
    reactContext: ReactApplicationContext
  ): List<ViewManager<*, *>> = emptyList()
}
