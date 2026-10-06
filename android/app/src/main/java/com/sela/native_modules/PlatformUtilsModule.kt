package com.sela.native_modules

import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.media.AudioManager
import android.media.ToneGenerator
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.widget.Toast
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream

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
