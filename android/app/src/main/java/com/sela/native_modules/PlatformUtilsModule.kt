package com.sela.native_modules

import android.app.Activity
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.media.ToneGenerator
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.widget.Toast
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.BufferedReader
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.SocketTimeoutException

/**
 * PlatformUtilsModule
 * ─────────────────────────────────────────────────────────────────
 * Small native utilities that would otherwise require extra npm
 * packages (react-native-fs / react-native-sound):
 *
 *  - beep(): scanner-style confirmation tone via ToneGenerator
 *  - exportFile(): writes reports (CSV / XLS) into the shared
 *    Downloads folder using MediaStore (API 29+) or legacy paths.
 *  - File helpers for product catalogue images stored in the app's
 *    private storage (copy / delete / exists / makeDir).
 */
class PlatformUtilsModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext), ActivityEventListener {

  companion object {
    const val NAME = "PlatformUtils"
    private const val EXPORT_DIR_NAME = "SmartVisionPOS"
    private const val PICK_FILE_REQUEST = 47123

    /** v28 (round-36 #4): the Arabic success page the loopback
     *  server answers the browser with after Google redirects back. */
    private val LOOPBACK_SUCCESS_HTML = """
      <!DOCTYPE html><html dir="rtl" lang="ar"><head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>سيلا — النسخ السحابي</title></head>
      <body style="font-family:sans-serif;background:#0E0E12;color:#FFFFFF;
        display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
      <div style="text-align:center;padding:24px">
      <div style="font-size:46px;line-height:1">&#10004;</div>
      <h2 style="margin:10px 0 6px">تم الربط بنجاح</h2>
      <p style="opacity:.7;margin:0">يمكنك إغلاق هذه الصفحة والعودة إلى تطبيق سيلا</p>
      </div></body></html>
    """.trimIndent()
  }

  override fun getName(): String = NAME

  init {
    reactContext.addActivityEventListener(this)
  }

  // ────────────────────────────────────────────────────────
  // SAF file picker (backup restore)
  // ────────────────────────────────────────────────────────

  private var pendingPickPromise: Promise? = null

  /**
   * Opens the system "Open file" picker (ACTION_OPEN_DOCUMENT), lets
   * the user choose a file matching [mimeTypes] and resolves with the
   * file's full UTF-8 content. Rejects when the user cancels.
   */
  @ReactMethod
  fun pickAndReadFile(mimeTypes: ReadableArray, promise: Promise) {
    val activity = currentActivity
    if (activity == null) {
      promise.reject("NO_ACTIVITY", "التطبيق غير نشط — حاول مرة أخرى")
      return
    }
    pendingPickPromise?.reject("PICK_BUSY", "هناك عملية اختيار ملف أخرى قيد التنفيذ")
    pendingPickPromise = promise
    try {
      val wanted = ArrayList<String>()
      for (i in 0 until mimeTypes.size()) {
        wanted.add(mimeTypes.getString(i) ?: "*/*")
      }
      if (wanted.isEmpty()) {
        wanted.add("*/*")
      }
      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = "*/*"
        putExtra(Intent.EXTRA_MIME_TYPES, wanted.toTypedArray())
        putExtra(Intent.EXTRA_LOCAL_ONLY, true)
      }
      activity.startActivityForResult(intent, PICK_FILE_REQUEST)
    } catch (t: Throwable) {
      pendingPickPromise = null
      promise.reject("PICK_FAILED", "تعذّر فتح منتقي الملفات: ${t.message}")
    }
  }

  override fun onActivityResult(
    activity: Activity?,
    requestCode: Int,
    resultCode: Int,
    data: Intent?
  ) {
    if (requestCode != PICK_FILE_REQUEST) {
      return
    }
    val promise = pendingPickPromise ?: return
    pendingPickPromise = null
    if (resultCode != Activity.RESULT_OK || data == null) {
      promise.reject("CANCELLED", "تم إلغاء اختيار الملف")
      return
    }
    val uri: Uri? = data.data
    if (uri == null) {
      promise.reject("NO_FILE", "لم يتم اختيار أي ملف")
      return
    }
    try {
      val content = reactContext.contentResolver.openInputStream(uri)
        ?.use { stream -> stream.readBytes().toString(Charsets.UTF_8) }
        ?: throw IllegalStateException("تعذّر قراءة الملف")
      if (content.isEmpty()) {
        promise.reject("EMPTY_FILE", "الملف المختار فارغ")
        return
      }
      promise.resolve(content)
    } catch (t: Throwable) {
      promise.reject("READ_FAILED", "فشل قراءة الملف: ${t.message}")
    }
  }

  override fun onNewIntent(intent: Intent?) {
    // Not used — required by ActivityEventListener.
  }

  // ────────────────────────────────────────────────────────────────
  // Device identity, anti-tamper timing & ABI
  // ────────────────────────────────────────────────────────────────

  /**
   * Stable per-device identifier for license binding (ANDROID_ID —
   * scoped to our app signature since Android 8, stable across
   * reinstalls).
   */
  @ReactMethod
  fun getDeviceId(promise: Promise) {
    try {
      val id = android.provider.Settings.Secure.getString(
        reactContext.contentResolver,
        android.provider.Settings.Secure.ANDROID_ID
      )
      if (id.isNullOrBlank()) {
        promise.resolve("unknown-${Build.FINGERPRINT.hashCode()}")
      } else {
        promise.resolve(id)
      }
    } catch (e: Exception) {
      promise.resolve("unknown-${Build.FINGERPRINT.hashCode()}")
    }
  }

  /**
   * Monotonic milliseconds since boot (SystemClock.elapsedRealtime).
   * NOT affected by the user changing the phone's clock — the anchor
   * of the subscription anti-tamper time checks.
   */
  @ReactMethod
  fun getUptimeMs(promise: Promise) {
    promise.resolve(android.os.SystemClock.elapsedRealtime().toDouble())
  }

  /** Primary ABI, e.g. "arm64-v8a" or "armeabi-v7a" (slow-device tuning). */
  @ReactMethod
  fun getAbi(promise: Promise) {
    promise.resolve(Build.SUPPORTED_ABIS?.firstOrNull() ?: "unknown")
  }

  // ────────────────────────────────────────────────────────────────
  // Sounds
  // ────────────────────────────────────────────────────────────────

  /**
   * Plays a short beep on the device speaker.
   * kind: 0 = standard beep, 1 = double beep, 2 = confirmation, 3 = error.
   */
  @ReactMethod
  fun beep(kind: Double, promise: Promise) {
    try {
      val tone = when (kind.toInt()) {
        1 -> ToneGenerator.TONE_PROP_BEEP2
        2 -> ToneGenerator.TONE_PROP_ACK
        3 -> ToneGenerator.TONE_SUP_ERROR
        else -> ToneGenerator.TONE_PROP_BEEP
      }
      // ToneGenerator must be created/used on a thread with a Looper
      // (the main thread always has one).
      val activity = currentActivity
      val handler = android.os.Handler(
        (activity ?: reactContext).mainLooper
      )
      handler.post {
        var generator: ToneGenerator? = null
        try {
          generator = ToneGenerator(AudioManager.STREAM_MUSIC, 100)
          generator.startTone(tone, 150)
          // Release after the tone finished playing.
          handler.postDelayed({
            try {
              generator?.release()
            } catch (ignored: Exception) {
              // Already released.
            }
          }, 250)
          // Resolve from the original thread context is fine — we are
          // synchronous here because beep() can never fail meaningfully.
        } catch (t: Throwable) {
          try {
            generator?.release()
          } catch (ignored: Exception) {
            // Ignore double-release.
          }
        }
      }
      promise.resolve(true)
    } catch (t: Throwable) {
      promise.reject("BEEP_FAILED", "تعذّر تشغيل النغمة: ${t.message}")
    }
  }

  // ────────────────────────────────────────────────────────────────
  // v28 (round-36 #4): Google Drive backup — connectivity +
  // OAuth loopback capture server
  // ────────────────────────────────────────────────────────────────

  /** True when the device has an active internet-capable network. */
  @ReactMethod
  fun isNetworkAvailable(promise: Promise) {
    try {
      val cm =
        reactContext.getSystemService(Context.CONNECTIVITY_SERVICE)
          as? ConnectivityManager
      val network = cm?.activeNetwork
      val caps = network?.let { cm.getNetworkCapabilities(it) }
      promise.resolve(
        caps != null &&
          caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
      )
    } catch (t: Throwable) {
      promise.resolve(false)
    }
  }

  /** The running loopback OAuth server (null = idle). */
  @Volatile private var loopbackServer: ServerSocket? = null
  @Volatile private var loopbackCancelled = false

  /**
   * v28 (round-36 #4): binds a ONE-SHOT HTTP server on the loopback
   * interface (127.0.0.1, OS-assigned port) and resolves
   * IMMEDIATELY with that port — JS needs it to build the Google
   * OAuth redirect_uri (Desktop-client loopback flow; Google ignores
   * the port when matching loopback redirects). When the browser
   * finally redirects back with ?code=…&state=… the server answers
   * a small Arabic success page, brings the app back to the front
   * and emits "selaDriveAuth" with {query} — or {error:
   * "timeout" | "cancelled"}. cancelLoopbackAuth() aborts the wait.
   */
  @ReactMethod
  fun startLoopbackAuth(timeoutMs: Double, promise: Promise) {
    if (loopbackServer != null) {
      promise.reject("AUTH_BUSY", "هناك عملية ربط جارية بالفعل — انتظر انتهاءها")
      return
    }
    try {
      val server = ServerSocket()
      server.reuseAddress = true
      // EXPLICIT IPv4 loopback — Google's loopback redirect matching
      // only accepts http://127.0.0.1 (an IPv6 ::1 bind would break it).
      server.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 1)
      // The single accept deadline doubles as the whole-flow timeout.
      server.soTimeout =
        timeoutMs.toLong().coerceIn(10_000L, 600_000L).toInt()
      loopbackServer = server
      loopbackCancelled = false
      Thread {
        var query: String? = null
        var error: String? = null
        try {
          server.accept().use { socket ->
            socket.soTimeout = 10_000
            val reader = BufferedReader(
              InputStreamReader(socket.getInputStream(), Charsets.UTF_8)
            )
            val requestLine =
              reader.readLine() ?: throw IllegalStateException("طلب فارغ")
            // "GET /callback?code=4%2F0A…&state=xyz HTTP/1.1"
            val path = requestLine.split(" ").getOrNull(1) ?: ""
            val qAt = path.indexOf('?')
            query = if (qAt >= 0) path.substring(qAt + 1) else ""
            // Drain the remaining request headers.
            while (true) {
              val line = reader.readLine() ?: break
              if (line.isEmpty()) break
            }
            val body = LOOPBACK_SUCCESS_HTML
            val head =
              "HTTP/1.1 200 OK\r\n" +
                "Content-Type: text/html; charset=utf-8\r\n" +
                "Content-Length: ${body.toByteArray(Charsets.UTF_8).size}\r\n" +
                "Connection: close\r\n\r\n"
            socket.getOutputStream().apply {
              write((head + body).toByteArray(Charsets.UTF_8))
              flush()
            }
          }
        } catch (e: SocketTimeoutException) {
          error = if (loopbackCancelled) "cancelled" else "timeout"
        } catch (t: Throwable) {
          error = if (loopbackCancelled) "cancelled" else (t.message ?: "error")
        } finally {
          try {
            server.close()
          } catch (ignored: Throwable) {
          }
          if (loopbackServer === server) {
            loopbackServer = null
          }
          // Best effort: pull the app back in front of the browser.
          try {
            val launch = reactContext.packageManager
              .getLaunchIntentForPackage(reactContext.packageName)
            if (launch != null) {
              launch.addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                  Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
              )
              reactContext.startActivity(launch)
            }
          } catch (ignored: Throwable) {
          }
          // Deliver the outcome to JS.
          try {
            val params = Arguments.createMap()
            if (query != null) {
              params.putString("query", query)
            }
            if (error != null) {
              params.putString("error", error)
            }
            reactContext
              .getJSModule(
                DeviceEventManagerModule.RCTDeviceEventEmitter::class.java
              )
              .emit("selaDriveAuth", params)
          } catch (ignored: Throwable) {
          }
        }
      }.apply {
        isDaemon = true
        start()
      }
      promise.resolve(server.localPort.toDouble())
    } catch (t: Throwable) {
      loopbackServer = null
      promise.reject("AUTH_START_FAILED", "تعذّر بدء خادم الربط: ${t.message}")
    }
  }

  /** Aborts a running loopback auth wait (user backed out). */
  @ReactMethod
  fun cancelLoopbackAuth(promise: Promise) {
    loopbackCancelled = true
    val server = loopbackServer
    loopbackServer = null
    try {
      server?.close()
    } catch (ignored: Throwable) {
    }
    promise.resolve(true)
  }

  // ────────────────────────────────────────────────────────────────
  // Report export (CSV / XLS) → Downloads folder
  // ────────────────────────────────────────────────────────────────

  @ReactMethod
  fun getApiLevel(promise: Promise) {
    promise.resolve(Build.VERSION.SDK_INT.toDouble())
  }

  /**
   * Writes text content (UTF-8) into Downloads/SmartVisionPOS/<fileName>.
   * Uses MediaStore on Android 10+ and direct file IO on older systems.
   * Resolves with a human readable path of the stored file.
   */
  @ReactMethod
  fun exportFile(fileName: String, mimeType: String, content: String, promise: Promise) {
    try {
      val bytes = content.toByteArray(Charsets.UTF_8)
      val displayName = sanitizeFileName(fileName)
      val resultPath: String

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        val resolver = reactContext.contentResolver
        val values = ContentValues().apply {
          put(MediaStore.MediaColumns.DISPLAY_NAME, displayName)
          put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
          put(
            MediaStore.MediaColumns.RELATIVE_PATH,
            Environment.DIRECTORY_DOWNLOADS + "/" + EXPORT_DIR_NAME
          )
        }
        val collection =
          MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val uri = resolver.insert(collection, values)
          ?: throw IllegalStateException("فشل إنشاء الملف في مجلد التنزيلات")
        resolver.openOutputStream(uri)?.use { stream ->
          stream.write(bytes)
          stream.flush()
        } ?: throw IllegalStateException("تعذّر فتح الملف للكتابة")
        resultPath = "Downloads/$EXPORT_DIR_NAME/$displayName"
      } else {
        @Suppress("DEPRECATION")
        val downloadsDir =
          Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        val targetDir = File(downloadsDir, EXPORT_DIR_NAME)
        if (!targetDir.exists() && !targetDir.mkdirs()) {
          throw IllegalStateException("تعذّر إنشاء مجلد التصدير")
        }
        val targetFile = File(targetDir, displayName)
        FileOutputStream(targetFile).use { stream ->
          stream.write(bytes)
          stream.flush()
        }
        resultPath = targetFile.absolutePath
      }

      // Friendly confirmation toast.
      val activity = currentActivity
      val handler = android.os.Handler((activity ?: reactContext).mainLooper)
      handler.post {
        try {
          Toast.makeText(
            reactContext,
            "تم حفظ الملف في: $resultPath",
            Toast.LENGTH_LONG
          ).show()
        } catch (ignored: Exception) {
          // Toast is cosmetic — never fail the export because of it.
        }
      }

      promise.resolve(resultPath)
    } catch (security: SecurityException) {
      promise.reject("PERMISSION", "إذن التخزين مطلوب لحفظ الملفات (أندرويد قديم)")
    } catch (t: Throwable) {
      promise.reject("EXPORT_FAILED", "فشل تصدير الملف: ${t.message}")
    }
  }

  private fun sanitizeFileName(name: String): String {
    val cleaned = name.replace(Regex("[\\\\/:*?\"<>|]"), "_").trim()
    return if (cleaned.isEmpty()) "report.csv" else cleaned
  }

  // ────────────────────────────────────────────────────────────────
  // File helpers (product catalogue images)
  // ────────────────────────────────────────────────────────────────

  @ReactMethod
  fun getFilesDir(promise: Promise) {
    try {
      promise.resolve(reactContext.filesDir.absolutePath)
    } catch (t: Throwable) {
      promise.reject("FILE_ERROR", "تعذّر قراءة مجلد التطبيق: ${t.message}")
    }
  }

  @ReactMethod
  fun makeDir(path: String, promise: Promise) {
    try {
      val dir = File(path)
      if (dir.exists() && dir.isDirectory) {
        promise.resolve(true)
        return
      }
      promise.resolve(dir.mkdirs() || dir.isDirectory)
    } catch (t: Throwable) {
      promise.reject("FILE_ERROR", "تعذّر إنشاء المجلد: ${t.message}")
    }
  }

  @ReactMethod
  fun fileExists(path: String, promise: Promise) {
    try {
      promise.resolve(File(path).exists())
    } catch (t: Throwable) {
      promise.reject("FILE_ERROR", "تعذّر فحص الملف: ${t.message}")
    }
  }

  @ReactMethod
  fun copyFile(sourcePath: String, destinationPath: String, promise: Promise) {
    try {
      val source = File(sourcePath)
      if (!source.exists()) {
        promise.reject("NOT_FOUND", "الملف المصدر غير موجود: $sourcePath")
        return
      }
      val destination = File(destinationPath)
      val parent = destination.parentFile
      if (parent != null && !parent.exists() && !parent.mkdirs()) {
        promise.reject("FILE_ERROR", "تعذّر إنشاء مجلد الوجهة")
        return
      }
      FileInputStream(source).use { input ->
        FileOutputStream(destination).use { output ->
          input.copyTo(output, DEFAULT_BUFFER_SIZE)
          output.flush()
        }
      }
      promise.resolve(destination.absolutePath)
    } catch (t: Throwable) {
      promise.reject("COPY_FAILED", "فشل نسخ الملف: ${t.message}")
    }
  }

  @ReactMethod
  fun deleteFile(path: String, promise: Promise) {
    try {
      val file = File(path)
      if (!file.exists()) {
        promise.resolve(true)
        return
      }
      promise.resolve(file.delete())
    } catch (t: Throwable) {
      promise.reject("FILE_ERROR", "تعذّر حذف الملف: ${t.message}")
    }
  }

  // ────────────────────────────────────────────────────────────────
  // v8.3 (round-12 #3): base64 file payload for the BACKUP pipeline.
  // Product images live as JPEG files in filesDir/thumbs — the v1
  // backup exported only their PATHS, so a restore on a new device
  // (or after a reinstall) brought back products with dead image
  // references ("products lost their pictures"). The backup now
  // embeds every image as base64 and the restore writes fresh files.
  // ────────────────────────────────────────────────────────────────

  /**
   * Reads an app-internal file and resolves its content as base64.
   * Guarded: only files inside this app's own filesDir can be read
   * (the paths come from the products table — never trust them as
   * arbitrary read tickets).
   */
  @ReactMethod
  fun readFileBase64(path: String, promise: Promise) {
    try {
      val file = File(path)
      val root = reactContext.filesDir.canonicalFile
      val canonical = file.canonicalFile
      if (!canonical.path.startsWith(root.path)) {
        promise.reject("OUT_OF_SCOPE", "الملف خارج مساحة التطبيق")
        return
      }
      if (!file.exists() || file.length() == 0L) {
        promise.reject("NOT_FOUND", "الملف غير موجود: $path")
        return
      }
      FileInputStream(file).use { input ->
        val bytes = input.readBytes()
        promise.resolve(android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
      }
    } catch (t: Throwable) {
      promise.reject("READ_FAILED", "تعذّر قراءة الملف: ${t.message}")
    }
  }

  /**
   * Writes base64 content into filesDir/<subDir>/<name> and resolves
   * the NEW absolute path (the caller stores it in the restored
   * product's image_uri). Name is sanitized; subDir fixed to the
   * known image folders so a restored backup can never write into an
   * arbitrary location.
   */
  @ReactMethod
  fun writeFileBase64(subDir: String, name: String, base64: String, promise: Promise) {
    try {
      val allowed = setOf("thumbs", "scans", "restore")
      val folder = if (allowed.contains(subDir)) subDir else "restore"
      val safeName = name.replace(Regex("[^A-Za-z0-9._-]"), "_")
        .take(80)
        .ifEmpty { "file_${System.currentTimeMillis()}" }
      val dir = File(reactContext.filesDir, folder).apply { mkdirs() }
      val target = File(dir, "r_${System.currentTimeMillis()}_$safeName")
      val bytes = android.util.Base64.decode(base64, android.util.Base64.NO_WRAP)
      FileOutputStream(target).use { output ->
        output.write(bytes)
        output.flush()
      }
      promise.resolve(target.absolutePath)
    } catch (t: Throwable) {
      promise.reject("WRITE_FAILED", "تعذّر حفظ الملف: ${t.message}")
    }
  }

  override fun invalidate() {
    super.invalidate()
    // Nothing to clean up — no threads or receivers held.
  }

  // ────────────────────────────────────────────────────────────────
  // v25 (round-32 #3): the A4 PDF statement (كشف المصروفات والسحوبات)
  // + share + system print. Android's native PdfDocument + the
  // embedded Tajawal font render RTL Arabic perfectly (Paint does
  // the shaping) — no third-party PDF dependency needed.
  // ────────────────────────────────────────────────────────────────

  /**
   * Renders an A4 statement PDF from a JSON payload (built in JS by
   * CashService.statementForPdf):
   *   {
   *     "storeName": "…", "title": "…", "periodLabel": "…",
   *     "generatedAt": "…",
   *     "summary": [ {"label":"مصروفات","value":"120.00 ₪"}, … ],
   *     "categories": [ {"name":"كهرباء","count":2,"total":"80.00 ₪"}, … ],
   *     "rows": [ {"ref":"EXP-…","kind":"مصروف","category":"…",
   *                "note":"…","amount":"-40.00 ₪","date":"…"} ],
   *     "footer": "…"
   *   }
   * Saved into Downloads/SmartVisionPOS via MediaStore (API 29+) or
   * legacy path; resolves with the readable location string.
   */
  @ReactMethod
  fun createStatementPdf(fileName: String, payloadJson: String, promise: Promise) {
    try {
      val pdf = android.graphics.pdf.PdfDocument()
      // A4 at 72dpi: 595 x 842 points.
      val pageWidth = 595
      val pageHeight = 842
      val margin = 40f

      // Parse the payload.
      val json = org.json.JSONObject(payloadJson)
      val storeName = json.optString("storeName", "sela")
      val title = json.optString("title", "كشف")
      val periodLabel = json.optString("periodLabel", "")
      val generatedAt = json.optString("generatedAt", "")
      val footer = json.optString("footer", "تم إنشاؤه بواسطة تطبيق sela")

      fun optArray(name: String): List<org.json.JSONObject> {
        val out = ArrayList<org.json.JSONObject>()
        val arr = json.optJSONArray(name) ?: return out
        for (i in 0 until arr.length()) {
          out.add(arr.getJSONObject(i))
        }
        return out
      }
      val summary = optArray("summary")
      val categories = optArray("categories")
      val rows = optArray("rows")

      // Fonts — the app bundles Tajawal for its Arabic identity.
      val regular = loadTajawal(reactContext, "Tajawal-Regular.ttf")
      val bold = loadTajawal(reactContext, "Tajawal-Bold.ttf")

      var page = pdf.startPage(
        android.graphics.pdf.PdfDocument.PageInfo.Builder(pageWidth, pageHeight, 1).create()
      )
      var canvas = page.canvas
      var pageNo = 1
      var y = 0f

      fun text(
        value: String,
        x: Float,
        cy: Float,
        paint: android.graphics.Paint,
        align: android.graphics.Paint.Align = android.graphics.Paint.Align.RIGHT
      ) {
        paint.textAlign = align
        canvas.drawText(value, x, cy, paint)
      }

      fun newPage() {
        pdf.finishPage(page)
        pageNo += 1
        page = pdf.startPage(
          android.graphics.pdf.PdfDocument.PageInfo.Builder(pageWidth, pageHeight, pageNo).create()
        )
        canvas = page.canvas
        y = margin + 18f
        // Page header on continuation pages.
        val headPaint = android.graphics.Paint().apply {
          typeface = bold
          textSize = 10f
          color = android.graphics.Color.GRAY
          isAntiAlias = true
        }
        text("$storeName — $title (تابع)", pageWidth - margin, y, headPaint)
        text("صفحة $pageNo", margin, y, headPaint, android.graphics.Paint.Align.LEFT)
        y += 26f
      }

      fun ensureSpace(needed: Float) {
        if (y + needed > pageHeight - margin - 24f) {
          newPage()
        }
      }

      // ── Title block ──
      val titlePaint = android.graphics.Paint().apply {
        typeface = bold
        textSize = 22f
        color = android.graphics.Color.BLACK
        isAntiAlias = true
      }
      val subPaint = android.graphics.Paint().apply {
        typeface = regular
        textSize = 12f
        color = android.graphics.Color.DKGRAY
        isAntiAlias = true
      }
      val cellPaint = android.graphics.Paint().apply {
        typeface = regular
        textSize = 11f
        color = android.graphics.Color.BLACK
        isAntiAlias = true
      }
      val cellBold = android.graphics.Paint().apply {
        typeface = bold
        textSize = 11f
        color = android.graphics.Color.BLACK
        isAntiAlias = true
      }
      val accentPaint = android.graphics.Paint().apply {
        typeface = bold
        textSize = 16f
        color = android.graphics.Color.rgb(0xF9, 0x73, 0x16)
        isAntiAlias = true
      }
      val linePaint = android.graphics.Paint().apply {
        strokeWidth = 1f
        color = android.graphics.Color.rgb(0xCC, 0xCC, 0xCC)
      }
      val headerBgPaint = android.graphics.Paint().apply {
        color = android.graphics.Color.rgb(0xF3, 0xF4, 0xF6)
      }

      y = margin + 24f
      text(storeName, pageWidth - margin, y, titlePaint)
      y += 30f
      text(title, pageWidth - margin, y, accentPaint)
      y += 22f
      text("الفترة: $periodLabel", pageWidth - margin, y, subPaint)
      text("أُنشئ في: $generatedAt", pageWidth - margin, y + 14f, subPaint)
      y += 44f
      canvas.drawLine(margin, y, pageWidth - margin, y, linePaint)
      y += 24f

      // ── Summary box (2 columns of label → value rows) ──
      if (summary.isNotEmpty()) {
        text("الإجماليات", pageWidth - margin, y, cellBold)
        y += 20f
        var col = 0
        val colW = (pageWidth - 2 * margin) / 2f
        for (item in summary) {
          val label = item.optString("label", "")
          val value = item.optString("value", "")
          val x = pageWidth - margin - col * colW
          text(label, x, y, cellPaint)
          text(value, x - colW + 90f, y, cellBold, android.graphics.Paint.Align.LEFT)
          col += 1
          if (col >= 2) {
            col = 0
            y += 20f
          }
        }
        if (col != 0) {
          y += 20f
        }
        y += 8f
        canvas.drawLine(margin, y, pageWidth - margin, y, linePaint)
        y += 24f
      }

      // ── Category breakdown ──
      if (categories.isNotEmpty()) {
        text("حسب الفئة", pageWidth - margin, y, cellBold)
        y += 20f
        for (cat in categories) {
          ensureSpace(18f)
          val name = cat.optString("name", "")
          val count = cat.optString("count", "0")
          val total = cat.optString("total", "")
          text(name, pageWidth - margin, y, cellPaint)
          text("$count عملية", pageWidth - margin - 240f, y, cellPaint, android.graphics.Paint.Align.LEFT)
          text(total, margin + 10f, y, cellBold, android.graphics.Paint.Align.LEFT)
          y += 18f
        }
        y += 8f
        canvas.drawLine(margin, y, pageWidth - margin, y, linePaint)
        y += 24f
      }

      // ── Movements table ──
      text("الحركات (${rows.size})", pageWidth - margin, y, cellBold)
      y += 20f
      // Column layout (RTL): التاريخ | المرجع | النوع | الفئة | الملاحظة | المبلغ
      val colDate = pageWidth - margin
      val colRef = colDate - 92f
      val colKind = colRef - 92f
      val colCat = colKind - 66f
      val colNote = colCat - 150f
      val colAmount = margin + 10f
      // Header row with a light background.
      canvas.drawRect(margin, y - 13f, pageWidth - margin, y + 6f, headerBgPaint)
      text("التاريخ", colDate, y, cellBold)
      text("المرجع", colRef, y, cellBold)
      text("النوع", colKind, y, cellBold)
      text("الفئة", colCat, y, cellBold)
      text("ملاحظة", colNote, y, cellBold)
      text("المبلغ (₪)", colAmount, y, cellBold, android.graphics.Paint.Align.LEFT)
      y += 24f
      for (row in rows) {
        ensureSpace(18f)
        val date = row.optString("date", "")
        val ref = row.optString("ref", "")
        val kind = row.optString("kind", "")
        val category = row.optString("category", "")
        val note = row.optString("note", "")
        val amount = row.optString("amount", "")
        text(date.take(16), colDate, y, cellPaint)
        text(ref, colRef, y, cellPaint)
        text(kind, colKind, y, cellPaint)
        text(category.take(14), colCat, y, cellPaint)
        text(note.take(24), colNote, y, cellPaint)
        text(amount, colAmount, y, cellBold, android.graphics.Paint.Align.LEFT)
        y += 18f
      }

      // ── Footer on the last page ──
      y += 14f
      ensureSpace(30f)
      canvas.drawLine(margin, y, pageWidth - margin, y, linePaint)
      y += 20f
      val footPaint = android.graphics.Paint().apply {
        typeface = regular
        textSize = 9f
        color = android.graphics.Color.GRAY
        isAntiAlias = true
      }
      text(footer, pageWidth - margin, y, footPaint)
      text("صفحة $pageNo", margin, y, footPaint, android.graphics.Paint.Align.LEFT)

      pdf.finishPage(page)

      // ── Save via MediaStore (or legacy path) ──
      val bytes = ByteArrayOutputStream().use { stream ->
        pdf.writeTo(stream)
        pdf.close()
        stream.toByteArray()
      }
      val displayName = sanitizeFileName(fileName)
      val resultPath: String
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        val resolver = reactContext.contentResolver
        val values = ContentValues().apply {
          put(MediaStore.MediaColumns.DISPLAY_NAME, displayName)
          put(MediaStore.MediaColumns.MIME_TYPE, "application/pdf")
          put(
            MediaStore.MediaColumns.RELATIVE_PATH,
            Environment.DIRECTORY_DOWNLOADS + "/" + EXPORT_DIR_NAME
          )
        }
        val collection =
          MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val uri = resolver.insert(collection, values)
          ?: throw IllegalStateException("فشل إنشاء ملف الكشف")
        resolver.openOutputStream(uri)?.use { stream ->
          stream.write(bytes)
          stream.flush()
        } ?: throw IllegalStateException("تعذّر فتح ملف الكشف للكتابة")
        resultPath = "Downloads/$EXPORT_DIR_NAME/$displayName"
      } else {
        @Suppress("DEPRECATION")
        val downloadsDir =
          Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        val targetDir = File(downloadsDir, EXPORT_DIR_NAME)
        if (!targetDir.exists() && !targetDir.mkdirs()) {
          throw IllegalStateException("تعذّر إنشاء مجلد التصدير")
        }
        val targetFile = File(targetDir, displayName)
        FileOutputStream(targetFile).use { stream ->
          stream.write(bytes)
          stream.flush()
        }
        resultPath = targetFile.absolutePath
      }

      val activity = currentActivity
      val handler = android.os.Handler((activity ?: reactContext).mainLooper)
      handler.post {
        try {
          Toast.makeText(
            reactContext,
            "تم حفظ كشف PDF في: $resultPath",
            Toast.LENGTH_LONG
          ).show()
        } catch (ignored: Exception) {
          // Cosmetic only.
        }
      }

      promise.resolve(resultPath)
    } catch (t: Throwable) {
      promise.reject("PDF_FAILED", "فشل إنشاء كشف PDF: ${t.message}")
    }
  }

  /** Opens the system share sheet for a saved file in the export
   *  folder (WhatsApp / email / any PDF printer app the merchant
   *  has). On Android 10+ the file lives in MediaStore — we look it
   *  up by display name in our export folder. */
  @ReactMethod
  fun shareExportedPdf(fileName: String, title: String, promise: Promise) {
    try {
      val activity = currentActivity
      if (activity == null) {
        promise.reject("NO_ACTIVITY", "التطبيق غير نشط — حاول مرة أخرى")
        return
      }
      val displayName = sanitizeFileName(fileName)
      val uri: Uri? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        val collection =
          MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        reactContext.contentResolver.query(
          collection,
          arrayOf(MediaStore.MediaColumns._ID),
          "${MediaStore.MediaColumns.DISPLAY_NAME} = ? AND ${MediaStore.MediaColumns.RELATIVE_PATH} = ?",
          arrayOf(displayName, Environment.DIRECTORY_DOWNLOADS + "/" + EXPORT_DIR_NAME + "/"),
          null
        )?.use { cursor ->
          if (cursor.moveToFirst()) {
            android.content.ContentUris.withAppendedId(collection, cursor.getLong(0))
          } else {
            null
          }
        }
      } else {
        @Suppress("DEPRECATION")
        val legacy = File(
          Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
          "$EXPORT_DIR_NAME/$displayName"
        )
        if (legacy.exists()) {
          androidx.core.content.FileProvider.getUriForFile(
            reactContext,
            reactContext.packageName + ".fileprovider",
            legacy
          )
        } else {
          null
        }
      }
      if (uri == null) {
        promise.reject("NOT_FOUND", "لم يُعثر على الملف — أنشئ الكشف أولاً")
        return
      }
      val intent = Intent(Intent.ACTION_SEND).apply {
        type = "application/pdf"
        putExtra(Intent.EXTRA_STREAM, uri)
        putExtra(Intent.EXTRA_TITLE, title)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      activity.startActivity(
        Intent.createChooser(intent, title)
      )
      promise.resolve(true)
    } catch (t: Throwable) {
      promise.reject("SHARE_FAILED", "تعذّرت مشاركة الملف: ${t.message}")
    }
  }

  /** Prints a saved export-folder PDF through Android's system
   *  print framework (PrintManager) — works with every printer app
   *  the merchant has configured (cloud / USB / Wi-Fi). */
  @ReactMethod
  fun printExportedPdf(fileName: String, jobName: String, promise: Promise) {
    try {
      val activity = currentActivity
      if (activity == null) {
        promise.reject("NO_ACTIVITY", "التطبيق غير نشط — حاول مرة أخرى")
        return
      }
      val displayName = sanitizeFileName(fileName)
      val uri: Uri? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        val collection =
          MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        reactContext.contentResolver.query(
          collection,
          arrayOf(MediaStore.MediaColumns._ID),
          "${MediaStore.MediaColumns.DISPLAY_NAME} = ? AND ${MediaStore.MediaColumns.RELATIVE_PATH} = ?",
          arrayOf(displayName, Environment.DIRECTORY_DOWNLOADS + "/" + EXPORT_DIR_NAME + "/"),
          null
        )?.use { cursor ->
          if (cursor.moveToFirst()) {
            android.content.ContentUris.withAppendedId(collection, cursor.getLong(0))
          } else {
            null
          }
        }
      } else {
        null
      }
      val fileDescriptor = if (uri != null) {
        reactContext.contentResolver.openFileDescriptor(uri, "r")
      } else {
        @Suppress("DEPRECATION")
        val legacy = File(
          Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
          "$EXPORT_DIR_NAME/$displayName"
        )
        if (legacy.exists()) {
          android.os.ParcelFileDescriptor.open(
            legacy, android.os.ParcelFileDescriptor.MODE_READ_ONLY
          )
        } else {
          null
        }
      }
      if (fileDescriptor == null) {
        promise.reject("NOT_FOUND", "لم يُعثر على الملف — أنشئ الكشف أولاً")
        return
      }
      val fd = fileDescriptor
      val printAdapter = object : android.print.PrintDocumentAdapter() {
        override fun onLayout(
          oldAttributes: android.print.PrintAttributes?,
          newAttributes: android.print.PrintAttributes,
          cancellationSignal: android.os.CancellationSignal?,
          callback: LayoutResultCallback,
          extras: android.os.Bundle?
        ) {
          if (cancellationSignal?.isCanceled == true) {
            callback.onLayoutCancelled()
            return
          }
          val info = android.print.PrintDocumentInfo.Builder(displayName)
            .setContentType(android.print.PrintDocumentInfo.CONTENT_TYPE_DOCUMENT)
            .build()
          callback.onLayoutFinished(info, true)
        }

        override fun onWrite(
          pages: Array<out android.print.PageRange>?,
          destination: android.os.ParcelFileDescriptor,
          cancellationSignal: android.os.CancellationSignal?,
          callback: WriteResultCallback
        ) {
          try {
            java.io.FileInputStream(fd.fileDescriptor).use { input ->
              java.io.FileOutputStream(destination.fileDescriptor).use { output ->
                input.copyTo(output)
                output.flush()
              }
            }
            callback.onWriteFinished(arrayOf(android.print.PageRange.ALL_PAGES))
          } catch (t: Throwable) {
            callback.onWriteFailed(t.message)
          } finally {
            try {
              fd.close()
            } catch (ignored: Exception) {
            }
          }
        }
      }
      val printManager = activity.getSystemService(android.content.Context.PRINT_SERVICE)
        as android.print.PrintManager
      printManager.print(jobName, printAdapter, android.print.PrintAttributes.Builder().build())
      promise.resolve(true)
    } catch (t: Throwable) {
      promise.reject("PRINT_FAILED", "تعذّر فتح الطباعة: ${t.message}")
    }
  }

  /**
   * v40 (الجولة 48 #4): يرسم شكل الفاتورة الحرارية كصورة PNG ويحفظها
   * في مجلد التنزيلات — معاينة مطابقة لما ستطبعه الطابعة (نفس
   * البنية: الشعار، الترويسة، الأسطر، السطرين (تسمية/قيمة)،
   * الفواصل، الباركود) بخط Tajawal المدمج. العملية نفسها التي
   * يبنيها JS في receiptPreview.ts من إعدادات المتجر الحية.
   *
   * payloadJson:
   *  { "paper": "58" | "80",
   *    "rows": [
   *      {"t":"logo","path":"…"}                // اختياري
   *      {"t":"text","text":"…","align":"center|right|left","bold":true,"size":0|1|2}
   *      {"t":"two","label":"…","value":"…","bold":true}
   *      {"t":"sep"}
   *      {"t":"barcode","value":"INV-…"}
   *      {"t":"space","h":8}
   *    ] }
   */
  @ReactMethod
  fun exportReceiptImage(fileName: String, payloadJson: String, promise: Promise) {
    try {
      val json = org.json.JSONObject(payloadJson)
      val paper = json.optString("paper", "58")
      // 203dpi raster width ×2 لصورة حادة على الشاشة.
      val baseWidth = if (paper == "80") 576 else 384
      val scale = 2
      val widthPx = baseWidth * scale
      val margin = 14 * scale

      val rows = json.optJSONArray("rows") ?: org.json.JSONArray()

      val regular = loadTajawal(reactContext, "Tajawal-Regular.ttf")
      val boldFont = loadTajawal(reactContext, "Tajawal-Bold.ttf")

      fun paintFor(bold: Boolean, size: Int): android.graphics.Paint {
        return android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
          typeface = if (bold) boldFont else regular
          textSize = when (size) {
            2 -> 19f * scale
            1 -> 15.5f * scale
            else -> 12f * scale
          }
          color = android.graphics.Color.BLACK
        }
      }

      // ── المرور الأول: قياس ارتفاع كل سطر (والشعار) ──
      val lineGap = 5f * scale
      val measured = ArrayList<Pair<Int, Float>>(rows.length())
      var totalHeight = margin.toFloat()
      for (i in 0 until rows.length()) {
        val row = rows.getJSONObject(i)
        val type = row.optString("t", "text")
        when (type) {
          "logo" -> {
            val path = row.optString("path", "")
            var h = 0f
            if (path.isNotBlank()) {
              try {
                val opts = android.graphics.BitmapFactory.Options().apply {
                  inJustDecodeBounds = true
                }
                android.graphics.BitmapFactory.decodeFile(path, opts)
                if (opts.outWidth > 0 && opts.outHeight > 0) {
                  val drawW = (widthPx - margin * 2).toFloat()
                  h = drawW * opts.outHeight / opts.outWidth
                }
              } catch (ignored: Throwable) {
                h = 0f
              }
            }
            measured.add(Pair(i, h))
            totalHeight += h + lineGap
          }
          "text" -> {
            val size = row.optInt("size", 0)
            val p = paintFor(row.optBoolean("bold", false), size)
            val fm = p.fontMetrics
            val h = fm.descent - fm.ascent
            measured.add(Pair(i, h + lineGap))
            totalHeight += h + lineGap
          }
          "two" -> {
            val p = paintFor(row.optBoolean("bold", false), 0)
            val fm = p.fontMetrics
            val h = fm.descent - fm.ascent
            measured.add(Pair(i, h + lineGap))
            totalHeight += h + lineGap
          }
          "sep" -> {
            val h = 10f * scale
            measured.add(Pair(i, h))
            totalHeight += h
          }
          "barcode" -> {
            val h = 46f * scale
            measured.add(Pair(i, h + lineGap))
            totalHeight += h + lineGap
          }
          "space" -> {
            val h = row.optDouble("h", 8.0).toFloat() * scale
            measured.add(Pair(i, h))
            totalHeight += h
          }
          else -> {
            measured.add(Pair(i, 0f))
          }
        }
      }
      totalHeight += margin

      // ── الرسم على الورقة البيضاء ──
      val heightPx = Math.max(Math.round(totalHeight), widthPx / 3)
      val bitmap = android.graphics.Bitmap.createBitmap(
        widthPx, heightPx, android.graphics.Bitmap.Config.ARGB_8888
      )
      val canvas = android.graphics.Canvas(bitmap)
      canvas.drawColor(android.graphics.Color.WHITE)

      val blackPaint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
        color = android.graphics.Color.BLACK
        strokeWidth = 2f * scale
      }
      var y = margin.toFloat()

      for ((index, h) in measured) {
        val row = rows.getJSONObject(index)
        val type = row.optString("t", "text")
        when (type) {
          "logo" -> {
            if (h > 0f) {
              val path = row.optString("path", "")
              val bm = try {
                android.graphics.BitmapFactory.decodeFile(path)
              } catch (ignored: Throwable) {
                null
              }
              if (bm != null) {
                val drawW = (widthPx - margin * 2).toFloat()
                val drawH = drawW * bm.height / bm.width
                val dst = android.graphics.RectF(
                  margin.toFloat(), y, widthPx - margin, y + drawH
                )
                canvas.drawBitmap(bm, null, dst, null)
                bm.recycle()
              }
            }
            y += h + lineGap
          }
          "text" -> {
            val align = row.optString("align", "right")
            val p = paintFor(row.optBoolean("bold", false), row.optInt("size", 0))
            val text = row.optString("text", "")
            val fm = p.fontMetrics
            val cy = y - fm.ascent
            p.textAlign = when (align) {
              "center" -> android.graphics.Paint.Align.CENTER
              "left" -> android.graphics.Paint.Align.LEFT
              else -> android.graphics.Paint.Align.RIGHT
            }
            val x = when (align) {
              "center" -> widthPx / 2f
              "left" -> margin.toFloat()
              else -> (widthPx - margin).toFloat()
            }
            canvas.drawText(text, x, cy, p)
            y += h
          }
          "two" -> {
            val p = paintFor(row.optBoolean("bold", false), 0)
            val fm = p.fontMetrics
            val cy = y - fm.ascent
            val label = row.optString("label", "")
            val value = row.optString("value", "")
            // RTL: التسمية عند الهامش الأيمن والقيمة عند الأيسر —
            // تماماً كما تطبعها ESC/POS ثنائية الأعمدة.
            p.textAlign = android.graphics.Paint.Align.RIGHT
            canvas.drawText(label, (widthPx - margin).toFloat(), cy, p)
            p.textAlign = android.graphics.Paint.Align.LEFT
            canvas.drawText(value, margin.toFloat(), cy, p)
            y += h
          }
          "sep" -> {
            val yMid = y + h / 2f
            var x = margin.toFloat()
            val dash = 7f * scale
            val gap = 5f * scale
            while (x < widthPx - margin) {
              canvas.drawLine(x, yMid, x + dash, yMid, blackPaint)
              x += dash + gap
            }
            y += h
          }
          "barcode" -> {
            // معاينة باركود: نمط أعمدة حتمي مشتق من النص (الشكل
            // كما تطبعه الطابعة؛ الفحص الفعلي للماسح ليس غرض
            // المعاينة).
            val value = row.optString("value", "")
            val barTop = y + 2f * scale
            val barBottom = y + 34f * scale
            var x = margin.toFloat()
            var i = 0
            val thin = 2f * scale
            val thick = 5f * scale
            while (x < widthPx - margin && i < 220) {
              val ch = if (value.isEmpty()) ' ' else value[i % value.length]
              val w = when ((ch.code + i) % 4) {
                0 -> thin
                1 -> thick
                2 -> thin
                else -> thin * 2
              }
              if ((ch.code + i) % 2 == 0) {
                canvas.drawRect(
                  x, barTop, x + w, barBottom, blackPaint
                )
              }
              x += w + thin
              i += 1
            }
            val p = paintFor(false, 0)
            p.textAlign = android.graphics.Paint.Align.CENTER
            val cy = barBottom + 8f * scale - p.fontMetrics.ascent
            canvas.drawText(value, widthPx / 2f, cy, p)
            y += h
          }
          "space" -> {
            y += h
          }
          else -> {}
        }
      }

      // ── الحفظ PNG في مجلد التنزيلات (نمط exportFile نفسه) ──
      val bytes = ByteArrayOutputStream().use { stream ->
        bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, stream)
        stream.toByteArray()
      }
      bitmap.recycle()
      val displayName = sanitizeFileName(fileName)
      val resultPath: String
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        val resolver = reactContext.contentResolver
        val values = ContentValues().apply {
          put(MediaStore.MediaColumns.DISPLAY_NAME, displayName)
          put(MediaStore.MediaColumns.MIME_TYPE, "image/png")
          put(
            MediaStore.MediaColumns.RELATIVE_PATH,
            Environment.DIRECTORY_DOWNLOADS + "/" + EXPORT_DIR_NAME
          )
        }
        val collection =
          MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val uri = resolver.insert(collection, values)
          ?: throw IllegalStateException("فشل إنشاء صورة الفاتورة")
        resolver.openOutputStream(uri)?.use { stream ->
          stream.write(bytes)
          stream.flush()
        } ?: throw IllegalStateException("تعذّر فتح الصورة للكتابة")
        resultPath = "Downloads/$EXPORT_DIR_NAME/$displayName"
      } else {
        @Suppress("DEPRECATION")
        val downloadsDir =
          Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        val targetDir = File(downloadsDir, EXPORT_DIR_NAME)
        if (!targetDir.exists() && !targetDir.mkdirs()) {
          throw IllegalStateException("تعذّر إنشاء مجلد التصدير")
        }
        val targetFile = File(targetDir, displayName)
        FileOutputStream(targetFile).use { stream ->
          stream.write(bytes)
          stream.flush()
        }
        resultPath = targetFile.absolutePath
      }

      val activity = currentActivity
      val handler = android.os.Handler((activity ?: reactContext).mainLooper)
      handler.post {
        try {
          Toast.makeText(
            reactContext,
            "تم حفظ شكل الفاتورة في: $resultPath",
            Toast.LENGTH_LONG
          ).show()
        } catch (ignored: Exception) {
          // Cosmetic only.
        }
      }

      promise.resolve(resultPath)
    } catch (t: Throwable) {
      promise.reject("RECEIPT_IMAGE_FAILED", "فشل إنشاء صورة الفاتورة: ${t.message}")
    }
  }

  /** Loads a Tajawal TTF from the app's bundled assets — the
   *  fonts ship uncompressed in assets/fonts (aaptOptions
   *  noCompress keeps them loadable by Typeface). */
  private fun loadTajawal(
    context: ReactApplicationContext,
    fileName: String
  ): android.graphics.Typeface {
    return try {
      android.graphics.Typeface.createFromAsset(context.assets, "fonts/$fileName")
    } catch (t: Throwable) {
      android.graphics.Typeface.DEFAULT
    }
  }
}
