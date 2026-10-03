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
 *  - PlatformUtils  : beep tone, report export, file helpers
 *  - ImageDecoder   : photo → raw RGB for the vision pipeline
 *  - SelaNotifications : local stock-alert notifications
 */
class SelaPackage : ReactPackage {

  override fun createNativeModules(
    reactContext: ReactApplicationContext
  ): List<NativeModule> = listOf(
    ThermalPrinterModule(reactContext),
    PlatformUtilsModule(reactContext),
    ImageDecoderModule(reactContext),
    NotificationsModule(reactContext)
  )

  override fun createViewManagers(
    reactContext: ReactApplicationContext
  ): List<ViewManager<*, *>> = emptyList()
}
