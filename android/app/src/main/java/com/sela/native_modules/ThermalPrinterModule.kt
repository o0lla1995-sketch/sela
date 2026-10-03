package com.sela.native_modules

import android.annotation.SuppressLint
import android.app.Activity
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothSocket
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.util.Base64
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.IOException
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * ThermalPrinterModule
 * ─────────────────────────────────────────────────────────────────
 * Native Bluetooth Classic (SPP) bridge for ESC/POS thermal receipt
 * printers (58mm / 80mm). This module replaces the abandoned
 * `react-native-bluetooth-escpos-printer` package and talks directly
 * to the Android Bluetooth stack:
 *
 *  - Discovery (paired + nearby devices) with event streaming
 *  - Automatic pairing (bond) + SPP socket connection
 *  - Structured ESC/POS job execution with Arabic support through
 *    selectable code pages (Windows-1256 / IBM864 / ASCII)
 *
 * All methods are Promise based; every failure path rejects with a
 * descriptive message so the JS layer can show a friendly Arabic
 * dialog instead of crashing.
 */
class ThermalPrinterModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext), ActivityEventListener {

  companion object {
    const val NAME = "ThermalPrinter"

    /** Standard SPP UUID for serial Bluetooth devices. */
    private val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")

    /** Max bytes written per chunk to keep cheap printer buffers happy. */
    private const val CHUNK_SIZE = 1024

    private const val REQUEST_ENABLE_BT = 4711

    /**
     * Map of ESC/POS code page number -> Android charset name.
     * 0  = CP437  (plain ASCII/Latin fallback)
     * 45 = CP864  (OEM Arabic — some Xprinter/Gprinter models)
     * 47 = CP1256 (Windows Arabic — most common on cheap printers)
     */
    private val CODEPAGE_CHARSETS: Map<Int, String> = mapOf(
      0 to "US-ASCII",
      45 to "IBM864",
      47 to "windows-1256"
    )
  }

  private val executor = Executors.newSingleThreadExecutor()

  private var socket: BluetoothSocket? = null
  private var outputStream: OutputStream? = null
  @Volatile
  private var connectedAddress: String? = null
  @Volatile
  private var pendingEnablePromise: Promise? = null

  private var discoveryReceiver: BroadcastReceiver? = null

  override fun getName(): String = NAME

  // ────────────────────────────────────────────────────────────────
  // Bluetooth enable (system dialog)
  // ────────────────────────────────────────────────────────────────

  @ReactMethod
  fun isBluetoothEnabled(promise: Promise) {
    try {
      val adapter = getAdapter()
      if (adapter == null) {
        promise.reject("NO_ADAPTER", "هذا الجهاز لا يدعم البلوتوث")
        return
      }
      promise.resolve(adapter.isEnabled)
    } catch (security: SecurityException) {
      promise.reject("PERMISSION", "إذن البلوتوث غير ممنوح: ${security.message}")
    } catch (t: Throwable) {
      promise.reject("BLUETOOTH_ERROR", "فشل قراءة حالة البلوتوث: ${t.message}")
    }
  }

  @ReactMethod
  fun requestEnableBluetooth(promise: Promise) {
    try {
      val adapter = getAdapter()
      if (adapter == null) {
        promise.reject("NO_ADAPTER", "هذا الجهاز لا يدعم البلوتوث")
        return
      }
      if (adapter.isEnabled) {
        promise.resolve(true)
        return
      }
      val activity: Activity? = currentActivity
      if (activity == null) {
        promise.reject("NO_ACTIVITY", "لا يمكن فتح إعدادات البلوتوث الآن")
        return
      }
      pendingEnablePromise = promise
      activity.startActivityForResult(
        Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE),
        REQUEST_ENABLE_BT
      )
    } catch (security: SecurityException) {
      promise.reject("PERMISSION", "إذن البلوتوث غير ممنوح: ${security.message}")
    } catch (t: Throwable) {
      pendingEnablePromise = null
      promise.reject("BLUETOOTH_ERROR", "فشل طلب تفعيل البلوتوث: ${t.message}")
    }
  }

  override fun onActivityResult(activity: Activity?, requestCode: Int, resultCode: Int, data: Intent?) {
    if (requestCode == REQUEST_ENABLE_BT) {
      val promise = pendingEnablePromise
      pendingEnablePromise = null
      if (promise != null) {
        try {
          promise.resolve(resultCode == Activity.RESULT_OK)
        } catch (t: Throwable) {
          // Promise already settled — safe to ignore.
        }
      }
    }
  }

  override fun onNewIntent(intent: Intent?) {
    // No-op: required by ActivityEventListener interface.
  }

  // ────────────────────────────────────────────────────────────────
  // Device lists & discovery
  // ────────────────────────────────────────────────────────────────

  @ReactMethod
  fun getBondedDevices(promise: Promise) {
    try {
      val adapter = getAdapter() ?: run {
        promise.reject("NO_ADAPTER", "هذا الجهاز لا يدعم البلوتوث")
        return
      }
      if (!adapter.isEnabled) {
        promise.reject("BLUETOOTH_OFF", "البلوتوث غير مفعّل — فعّله أولاً")
        return
      }
      val bonded = adapter.bondedDevices ?: emptySet()
      val result = Arguments.createArray()
      for (device in bonded) {
        val map = Arguments.createMap()
        map.putString("name", device.name ?: "جهاز بدون اسم")
        map.putString("address", device.address)
        map.putInt("bondState", device.bondState)
        result.pushMap(map)
      }
      promise.resolve(result)
    } catch (security: SecurityException) {
      promise.reject(
        "PERMISSION",
        "إذن BLUETOOTH_CONNECT مطلوب لعرض الأجهزة المقترنة (أندرويد 12+)"
      )
    } catch (t: Throwable) {
      promise.reject("BLUETOOTH_ERROR", "فشل جلب الأجهزة المقترنة: ${t.message}")
    }
  }

  @SuppressLint("MissingPermission")
  @ReactMethod
  fun startDiscovery(promise: Promise) {
    try {
      val adapter = getAdapter() ?: run {
        promise.reject("NO_ADAPTER", "هذا الجهاز لا يدعم البلوتوث")
        return
      }
      if (!adapter.isEnabled) {
        promise.reject("BLUETOOTH_OFF", "البلوتوث غير مفعّل — فعّله أولاً")
        return
      }
      stopDiscoveryQuietly(adapter)

      val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
          when (intent?.action) {
            BluetoothDevice.ACTION_FOUND -> {
              try {
                @Suppress("DEPRECATION")
                val device: BluetoothDevice? =
                  if (Build.VERSION.SDK_INT >= 33) {
                    intent.getParcelableExtra(
                      BluetoothDevice.EXTRA_DEVICE,
                      BluetoothDevice::class.java
                    )
                  } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
                  }
                if (device != null) {
                  val map = Arguments.createMap()
                  map.putString("name", device.name ?: "جهاز بدون اسم")
                  map.putString("address", device.address)
                  map.putInt("bondState", device.bondState)
                  emitEvent("onDeviceFound", map)
                }
              } catch (security: SecurityException) {
                emitErrorEvent("إذن البلوتوث غير كافٍ لعرض الأجهزة القريبة")
              }
            }
            BluetoothAdapter.ACTION_DISCOVERY_FINISHED -> {
              emitEvent("onDiscoveryFinished", null)
            }
          }
        }
      }
      val filter = IntentFilter().apply {
        addAction(BluetoothDevice.ACTION_FOUND)
        addAction(BluetoothAdapter.ACTION_DISCOVERY_FINISHED)
      }
      reactContext.registerReceiver(receiver, filter)
      discoveryReceiver = receiver

      val started = adapter.startDiscovery()
      promise.resolve(started)
    } catch (security: SecurityException) {
      promise.reject(
        "PERMISSION",
        "إذن البحث عن الأجهزة (BLUETOOTH_SCAN) غير ممنوح"
      )
    } catch (t: Throwable) {
      promise.reject("BLUETOOTH_ERROR", "فشل بدء البحث: ${t.message}")
    }
  }

  @ReactMethod
  fun stopDiscovery(promise: Promise) {
    try {
      val adapter = getAdapter()
      if (adapter != null) {
        stopDiscoveryQuietly(adapter)
      }
      unregisterDiscoveryReceiver()
      promise.resolve(true)
    } catch (t: Throwable) {
      promise.reject("BLUETOOTH_ERROR", "فشل إيقاف البحث: ${t.message}")
    }
  }

  private fun stopDiscoveryQuietly(adapter: BluetoothAdapter) {
    try {
      if (adapter.isDiscovering) {
        adapter.cancelDiscovery()
      }
    } catch (security: SecurityException) {
      // Permission missing — discovery is not running for us anyway.
    }
  }

  private fun unregisterDiscoveryReceiver() {
    val receiver = discoveryReceiver
    if (receiver != null) {
      try {
        reactContext.unregisterReceiver(receiver)
      } catch (ignored: IllegalArgumentException) {
        // Receiver was never registered — nothing to do.
      }
      discoveryReceiver = null
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Connection lifecycle
  // ────────────────────────────────────────────────────────────────

  @ReactMethod
  fun connect(address: String, promise: Promise) {
    executor.execute {
      try {
        val adapter = getAdapter()
        if (adapter == null) {
          promise.reject("NO_ADAPTER", "هذا الجهاز لا يدعم البلوتوث")
          return@execute
        }
        if (!adapter.isEnabled) {
          promise.reject("BLUETOOTH_OFF", "البلوتوث غير مفعّل — فعّله أولاً")
          return@execute
        }
        val device: BluetoothDevice = try {
          adapter.getRemoteDevice(address)
        } catch (t: Throwable) {
          promise.reject("BAD_ADDRESS", "عنوان البلوتوث غير صالح: $address")
          return@execute
        }

        // Bond first if the printer was never paired.
        if (device.bondState != BluetoothDevice.BOND_BONDED) {
          val bonded = waitForBond(device)
          if (!bonded) {
            promise.reject(
              "BOND_FAILED",
              "فشل اقتران الطابعة — اقبل طلب الاقتران الظاهر على الشاشة"
            )
            return@execute
          }
        }

        // Discovery slows down connections — cancel it.
        stopDiscoveryQuietly(adapter)

        closeSocketQuietly()

        val newSocket = device.createRfcommSocketToServiceRecord(SPP_UUID)
        newSocket.connect()
        socket = newSocket
        outputStream = newSocket.outputStream
        connectedAddress = address

        val payload = Arguments.createMap()
        payload.putBoolean("connected", true)
        payload.putString("address", address)
        emitEvent("onConnectionChanged", payload)
        promise.resolve(true)
      } catch (security: SecurityException) {
        connectedAddress = null
        closeSocketQuietly()
        promise.reject(
          "PERMISSION",
          "إذن BLUETOOTH_CONNECT مطلوب للاتصال بالطابعة (أندرويد 12+)"
        )
      } catch (io: IOException) {
        connectedAddress = null
        closeSocketQuietly()
        emitDisconnected(address)
        promise.reject(
          "CONNECT_FAILED",
          "تعذّر الاتصال بالطابعة — تأكد أنها مفتوحة وغير متصلة بجهاز آخر"
        )
      } catch (t: Throwable) {
        connectedAddress = null
        closeSocketQuietly()
        promise.reject("CONNECT_FAILED", "خطأ غير متوقع أثناء الاتصال: ${t.message}")
      }
    }
  }

  /**
   * Starts a bond request and blocks (on the executor thread) until the
   * bond state settles. Returns true when the device ends up bonded.
   */
  private fun waitForBond(device: BluetoothDevice): Boolean {
    try {
      val latch = java.util.concurrent.CountDownLatch(1)
      val result = arrayOf(false)

      val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
          if (intent?.action == BluetoothDevice.ACTION_BOND_STATE_CHANGED) {
            val state = intent.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, -1)
            val prev = intent.getIntExtra(BluetoothDevice.EXTRA_PREVIOUS_BOND_STATE, -1)
            if (state == BluetoothDevice.BOND_BONDED) {
              result[0] = true
              latch.countDown()
            } else if (state == BluetoothDevice.BOND_NONE && prev != BluetoothDevice.BOND_NONE) {
              result[0] = false
              latch.countDown()
            }
          }
        }
      }
      val filter = IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED)
      reactContext.registerReceiver(receiver, filter)
      try {
        device.createBond()
      } catch (security: SecurityException) {
        try {
          reactContext.unregisterReceiver(receiver)
        } catch (ignored: IllegalArgumentException) {
          // Already unregistered.
        }
        return false
      }
      // The printer pairing dialog may take a while — 60s ceiling.
      latch.await(60, TimeUnit.SECONDS)
      try {
        reactContext.unregisterReceiver(receiver)
      } catch (ignored: IllegalArgumentException) {
        // Already unregistered.
      }
      return result[0] || device.bondState == BluetoothDevice.BOND_BONDED
    } catch (t: Throwable) {
      return try {
        device.bondState == BluetoothDevice.BOND_BONDED
      } catch (security: SecurityException) {
        false
      }
    }
  }

  @ReactMethod
  fun disconnect(promise: Promise) {
    executor.execute {
      val wasConnected = connectedAddress != null
      closeSocketQuietly()
      connectedAddress = null
      if (wasConnected) {
        emitDisconnected(null)
      }
      promise.resolve(true)
    }
  }

  @ReactMethod
  fun isConnected(promise: Promise) {
    promise.resolve(connectedAddress != null && socket?.isConnected == true)
  }

  @ReactMethod
  fun getConnectedAddress(promise: Promise) {
    promise.resolve(connectedAddress)
  }

  private fun closeSocketQuietly() {
    try {
      outputStream?.flush()
    } catch (ignored: Exception) {
      // Stream already dead — nothing to flush.
    }
    try {
      outputStream?.close()
    } catch (ignored: Exception) {
      // Stream already closed.
    }
    try {
      socket?.close()
    } catch (ignored: Exception) {
      // Socket already closed.
    }
    outputStream = null
    socket = null
  }

  private fun emitDisconnected(address: String?) {
    val payload = Arguments.createMap()
    payload.putBoolean("connected", false)
    if (address != null) payload.putString("address", address)
    emitEvent("onConnectionChanged", payload)
  }

  // ────────────────────────────────────────────────────────────────
  // ESC/POS printing
  // ────────────────────────────────────────────────────────────────

  /**
   * Executes a structured ESC/POS job. Each entry in `commands` is a map:
   *   { op: "init" }
   *   { op: "codepage", page: 47 }
   *   { op: "align", align: 0|1|2 }              // left | center | right
   *   { op: "bold", on: true|false }
   *   { op: "size", width: 0|1, height: 0|1 }
   *   { op: "text", value: "..." }
   *   { op: "feed", lines: 3 }
   *   { op: "cut" }
   *   { op: "rawBase64", value: "..." }      // escape hatch for raw bytes
   */
  @ReactMethod
  fun printJob(commands: ReadableArray, promise: Promise) {
    executor.execute {
      try {
        val stream = outputStream
        if (stream == null || connectedAddress == null) {
          promise.reject("NOT_CONNECTED", "لا توجد طابعة متصلة")
          return@execute
        }

        var charsetName = "US-ASCII"
        var buffer = java.io.ByteArrayOutputStream()

        for (i in 0 until commands.size()) {
          val command: ReadableMap? = commands.getMap(i)
          if (command == null) continue
          when (command.getString("op")) {
            "init" -> {
              buffer.write(byteArrayOf(0x1B, 0x40))
            }
            "codepage" -> {
              val page = if (command.hasKey("page")) command.getInt("page") else 47
              val charset = CODEPAGE_CHARSETS[page]
              if (charset == null) {
                promise.reject("BAD_CODEPAGE", "صفحة الترميز غير مدعومة: $page")
                return@execute
              }
              charsetName = try {
                java.nio.charset.Charset.forName(charset).name()
              } catch (t: Throwable) {
                promise.reject(
                  "BAD_CODEPAGE",
                  "ترميز $charset غير مدعوم في هذا الجهاز"
                )
                return@execute
              }
              // ESC t <n>
              buffer.write(byteArrayOf(0x1B, 0x74, page.toByte()))
            }
            "align" -> {
              val value = if (command.hasKey("align")) command.getInt("align") else 0
              buffer.write(byteArrayOf(0x1B, 0x61, value.coerceIn(0, 2).toByte()))
            }
            "bold" -> {
              val on = command.hasKey("on") && command.getBoolean("on")
              buffer.write(byteArrayOf(0x1B, 0x45, if (on) 1 else 0))
            }
            "size" -> {
              val w = if (command.hasKey("width")) command.getInt("width") else 0
              val h = if (command.hasKey("height")) command.getInt("height") else 0
              val n = ((h and 0x0F) shl 4) or (w and 0x0F)
              // GS ! n
              buffer.write(byteArrayOf(0x1D, 0x21, n.toByte()))
            }
            "text" -> {
              val text = if (command.hasKey("value")) command.getString("value") ?: "" else ""
              val bytes = text.toByteArray(java.nio.charset.Charset.forName(charsetName))
              buffer.write(bytes)
            }
            "feed" -> {
              val lines = if (command.hasKey("lines")) command.getInt("lines").coerceIn(0, 255) else 1
              // ESC d n
              buffer.write(byteArrayOf(0x1B, 0x64, lines.toByte()))
            }
            "cut" -> {
              // GS V 66 0 — partial cut with feed (widely supported)
              buffer.write(byteArrayOf(0x1D, 0x56, 0x42, 0x00))
            }
            "rawBase64" -> {
              val b64 = if (command.hasKey("value")) command.getString("value") ?: "" else ""
              if (b64.isNotEmpty()) {
                buffer.write(Base64.decode(b64, Base64.NO_WRAP))
              }
            }
            "image" -> {
              // Raster image (store logo) — GS v 0 with Floyd-Steinberg
              // dithering to 1-bit. Widths: 58mm = 384 dots, 80mm = 576.
              val path = if (command.hasKey("path")) command.getString("path") ?: "" else ""
              val maxWidth = if (command.hasKey("maxWidth")) command.getInt("maxWidth") else 384
              val center = !command.hasKey("center") || command.getBoolean("center")
              if (path.isNotEmpty()) {
                val raster = buildRaster(path, maxWidth.coerceIn(64, 576))
                if (raster != null) {
                  if (center && raster.second < maxWidth) {
                    // ESC $ relative print position (byte-aligned), then GS v 0.
                    val byteOffset = ((maxWidth - raster.second) / 2 / 8) * 8
                    buffer.write(byteArrayOf(0x1B, 0x24, (byteOffset and 0xFF).toByte(), ((byteOffset shr 8) and 0xFF).toByte()))
                  }
                  buffer.write(raster.first)
                  // Reset relative position for the text that follows.
                  buffer.write(byteArrayOf(0x1B, 0x24, 0x00, 0x00))
                }
              }
            }
            "image" -> {
              // Raster image (store logo) — GS v 0 with Floyd-Steinberg
              // dithering to 1-bit. Widths: 58mm → 384 dots, 80mm → 576.
              val path = if (command.hasKey("path")) command.getString("path") ?: "" else ""
              val maxWidth = if (command.hasKey("maxWidth")) command.getInt("maxWidth") else 384
              val center = !command.hasKey("center") || command.getBoolean("center")
              if (path.isNotEmpty()) {
                val raster = buildRaster(path, maxWidth.coerceIn(64, 576))
                if (raster != null) {
                  if (center && raster.second < maxWidth) {
                    // ESC $ relative print position (whole-byte aligned), then GS v 0.
                    val byteOffset = ((maxWidth - raster.second) / 2 / 8) * 8
                    buffer.write(byteArrayOf(0x1B, 0x24, (byteOffset and 0xFF).toByte(), ((byteOffset shr 8) and 0xFF).toByte()))
                  }
                  buffer.write(raster.first)
                  // Reset relative position for the text that follows.
                  buffer.write(byteArrayOf(0x1B, 0x24, 0x00, 0x00))
                }
              }
            }
            "image" -> {
              // Raster image (store logo) — GS v 0 with Floyd-Steinberg
              // dithering to 1-bit. Widths: 58mm → 384 dots, 80mm → 576.
              val path = if (command.hasKey("path")) command.getString("path") ?: "" else ""
              val maxWidth = if (command.hasKey("maxWidth")) command.getInt("maxWidth") else 384
              val center = !command.hasKey("center") || command.getBoolean("center")
              if (path.isNotEmpty()) {
                val raster = buildRaster(path, maxWidth.coerceIn(64, 576))
                if (raster != null) {
                  if (center && raster.second < maxWidth) {
                    // Feed + ESC $ set relative position, then GS v 0.
                    val offsetDots = (maxWidth - raster.second) / 2
                    val byteOffset = offsetDots / 8 * 8 // whole-byte alignment
                    buffer.write(byteArrayOf(0x1B, 0x24, (byteOffset and 0xFF).toByte(), ((byteOffset shr 8) and 0xFF).toByte()))
                  }
                  buffer.write(raster.first)
                  // Reset alignment for the text that follows.
                  buffer.write(byteArrayOf(0x1B, 0x24, 0x00, 0x00))
                }
              }
            }
            else -> {
              // Unknown op — skip defensively instead of crashing.
            }
          }
          // Flush progressively so long receipts never overflow buffers.
          if (buffer.size() >= CHUNK_SIZE) {
            stream.write(buffer.toByteArray())
            stream.flush()
            buffer = java.io.ByteArrayOutputStream()
          }
        }
        val rest = buffer.toByteArray()
        if (rest.isNotEmpty()) {
          stream.write(rest)
        }
        stream.flush()
        promise.resolve(true)
      } catch (io: IOException) {
        val address = connectedAddress
        connectedAddress = null
        closeSocketQuietly()
        if (address != null) emitDisconnected(address)
        promise.reject(
          "PRINT_FAILED",
          "انقطع الاتصال أثناء الطباعة — أعد الاتصال بالطابعة وحاول مجدداً"
        )
      } catch (t: Throwable) {
        promise.reject("PRINT_FAILED", "فشل أمر الطباعة: ${t.message}")
      }
    }
  }

  // ────────────────────────────────────────────────────────────────
  // ESC/POS raster image (GS v 0) with Floyd-Steinberg dithering
  // ────────────────────────────────────────────────────────────────

  /**
   * Decodes the image at [path], scales it so width <= [maxWidth] dots,
   * dithers to 1-bit and returns (escposBytes, widthDots).
   * Returns null on any decode failure — printing text continues.
   */
  private fun buildRaster(path: String, maxWidth: Int): Pair<ByteArray, Int>? {
    var bitmap: android.graphics.Bitmap? = null
    var scaled: android.graphics.Bitmap? = null
    try {
      val file = java.io.File(path)
      if (!file.exists() || file.length() == 0L) return null
      val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
      android.graphics.BitmapFactory.decodeFile(path, bounds)
      if (bounds.outWidth <= 0) return null
      var sample = 1
      while (bounds.outWidth / (sample * 2) >= maxWidth) sample *= 2
      bitmap = android.graphics.BitmapFactory.decodeFile(
        path,
        android.graphics.BitmapFactory.Options().apply { inSampleSize = sample }
      ) ?: return null

      val scale = minOf(1f, maxWidth.toFloat() / bitmap.width)
      val w = max(1, (bitmap.width * scale).toInt())
      val h = max(1, (bitmap.height * scale).toInt())
      scaled = android.graphics.Bitmap.createScaledBitmap(bitmap, w, h, true)

      // Luminance buffer with Floyd-Steinberg error diffusion.
      val pixels = IntArray(w * h)
      scaled.getPixels(pixels, 0, w, 0, 0, w, h)
      val lum = FloatArray(w * h)
      for (i in pixels.indices) {
        val p = pixels[i]
        val r = (p shr 16) and 0xFF
        val g = (p shr 8) and 0xFF
        val b = p and 0xFF
        lum[i] = 0.299f * r + 0.587f * g + 0.114f * b
      }
      val bits = ByteArray(w * h)
      val threshold = 160f
      for (y in 0 until h) {
        for (x in 0 until w) {
          val i = y * w + x
          val old = lum[i].coerceIn(0f, 255f)
          val ink = old < threshold // dark pixel = print dot
          bits[i] = if (ink) 1 else 0
          val err = if (ink) old else old - 255f
          val f = err / 16f
          if (x + 1 < w) lum[i + 1] += f * 7
          if (y + 1 < h) {
            if (x > 0) lum[i + w - 1] += f * 3
            lum[i + w] += f * 5
            if (x + 1 < w) lum[i + w + 1] += f
          }
        }
      }

      // Pack into GS v 0 (m=0, normal density).
      val bytesPerRow = (w + 7) / 8
      val out = java.io.ByteArrayOutputStream(8 + bytesPerRow * h)
      out.write(byteArrayOf(
        0x1D, 0x76, 0x30, 0x00,
        (bytesPerRow and 0xFF).toByte(),
        ((bytesPerRow shr 8) and 0xFF).toByte(),
        (h and 0xFF).toByte(),
        ((h shr 8) and 0xFF).toByte()
      ))
      val row = ByteArray(bytesPerRow)
      for (y in 0 until h) {
        java.util.Arrays.fill(row, 0)
        for (x in 0 until w) {
          if (bits[y * w + x].toInt() == 1) {
            row[x / 8] = (row[x / 8].toInt() or (0x80 shr (x % 8))).toByte()
          }
        }
        out.write(row)
      }
      return Pair(out.toByteArray(), w)
    } catch (oom: OutOfMemoryError) {
      return null
    } catch (t: Throwable) {
      return null
    } finally {
      val distinct = listOfNotNull(bitmap, scaled).distinct()
      distinct.forEach { if (!it.isRecycled) it.recycle() }
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Utilities
  // ────────────────────────────────────────────────────────────────

  private fun getAdapter(): android.bluetooth.BluetoothAdapter? {
    val manager =
      reactContext.getSystemService(Context.BLUETOOTH_SERVICE) as? android.bluetooth.BluetoothManager
    return manager?.adapter
  }

  private fun emitEvent(name: String, params: WritableMap?) {
    try {
      reactContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(name, params)
    } catch (t: Throwable) {
      // The JS side may be tearing down — never crash on event emission.
    }
  }

  private fun emitErrorEvent(message: String) {
    val map = Arguments.createMap()
    map.putString("message", message)
    emitEvent("onPrinterError", map)
  }

  override fun invalidate() {
    super.invalidate()
    unregisterDiscoveryReceiver()
    pendingEnablePromise = null
    try {
      executor.shutdownNow()
    } catch (ignored: Exception) {
      // Executor already shut down.
    }
    closeSocketQuietly()
    connectedAddress = null
  }
}
