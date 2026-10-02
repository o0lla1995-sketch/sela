package com.smartvisionpos.native_modules

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * VisionPosPackage
 * ─────────────────────────────────────────────────────────────────
 * Registers this app's hand-written native modules:
 *  - ThermalPrinter : Bluetooth SPP + ESC/POS thermal printing
 *  - PlatformUtils  : beep tone, report export, file helpers
 */
class VisionPosPackage : ReactPackage {

  override fun createNativeModules(
    reactContext: ReactApplicationContext
  ): List<NativeModule> = listOf(
    ThermalPrinterModule(reactContext),
    PlatformUtilsModule(reactContext)
  )

  override fun createViewManagers(
    reactContext: ReactApplicationContext
  ): List<ViewManager<*, *>> = emptyList()
}
