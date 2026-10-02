package com.smartvisionpos.native_modules

import android.content.ContentValues
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.widget.Toast
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
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
  ReactContextBaseJavaModule(reactContext) {

  companion object {
    const val NAME = "PlatformUtils"
    private const val EXPORT_DIR_NAME = "SmartVisionPOS"
  }

  override fun getName(): String = NAME

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

  override fun invalidate() {
    super.invalidate()
    // Nothing to clean up — no threads or receivers held.
  }
}
