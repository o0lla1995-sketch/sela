package com.sela.native_modules

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import kotlin.math.max
import kotlin.math.min

/**
 * ImageDecoderModule
 * ─────────────────────────────────────────────────────────────────
 * Decodes camera photos into raw RGB data for the on-device TFLite
 * vision pipeline — entirely on a background-ish native call, with
 * no frame processors and no JSI worklets involved.
 *
 *  decodeRgb(path, size)  -> base64 of size*size*3 RGB bytes
 *                            (center-cropped to a square, downscaled)
 *  saveScaled(path, maxDim, quality) -> writes a downscaled JPEG copy
 *                            (used for catalogue thumbnails) and
 *                            returns its absolute path.
 *
 * This module is what makes the vision pipeline robust: it replaces
 * the previous react-native-vision-camera Frame Processor approach
 * (which silently crashed on devices because the worklets runtime
 * was not bundled).
 */
class ImageDecoderModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "ImageDecoder"

  // ── decodeRgb ────────────────────────────────────────────────
  @ReactMethod
  fun decodeRgb(path: String, size: Int, promise: Promise) {
    if (size <= 0 || size > 512) {
      promise.reject("E_ARGS", "حجم فك الترميز غير صالح", null)
      return
    }
    var bitmap: Bitmap? = null
    var cropped: Bitmap? = null
    var scaled: Bitmap? = null
    try {
      val file = File(path)
      if (!file.exists() || file.length() == 0L) {
        promise.reject("E_NOFILE", "ملف الصورة غير موجود", null)
        return
      }

      // 1. Read bounds only.
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(path, bounds)
      if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
        promise.reject("E_DECODE", "تعذر قراءة أبعاد الصورة", null)
        return
      }

      // 2. Decode with power-of-two sampling close to the target square.
      var sample = 1
      val shortSide = min(bounds.outWidth, bounds.outHeight)
      while (shortSide / (sample * 2) >= size) {
        sample *= 2
      }
      val opts = BitmapFactory.Options().apply { inSampleSize = sample }
      bitmap = BitmapFactory.decodeFile(path, opts)
      if (bitmap == null) {
        promise.reject("E_DECODE", "تعذر فك ترميز الصورة", null)
        return
      }

      // 3. Center-crop to a square, then scale to the exact model input.
      val w = bitmap.width
      val h = bitmap.height
      val side = min(w, h)
      val left = (w - side) / 2
      val top = (h - side) / 2
      cropped = if (side == w && side == h) {
        bitmap
      } else {
        Bitmap.createBitmap(bitmap, left, top, side, side)
      }
      scaled = if (cropped.width == size) {
        cropped
      } else {
        Bitmap.createScaledBitmap(cropped, size, size, true)
      }

      // 4. Extract RGB bytes.
      val n = size * size
      val pixels = IntArray(n)
      scaled.getPixels(pixels, 0, size, 0, 0, size, size)
      val bytes = ByteArray(n * 3)
      var i = 0
      for (p in pixels) {
        bytes[i++] = ((p shr 16) and 0xFF).toByte()
        bytes[i++] = ((p shr 8) and 0xFF).toByte()
        bytes[i++] = (p and 0xFF).toByte()
      }

      // 5. Base64 across the bridge (JS decodes with atob).
      val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
      promise.resolve(b64)
    } catch (oom: OutOfMemoryError) {
      promise.reject("E_OOM", "نفدت الذاكرة أثناء معالجة الصورة — أعد المحاولة", null)
    } catch (e: Exception) {
      promise.reject("E_DECODE", "فشل فك ترميز الصورة: ${e.message}", e)
    } finally {
      recycleIfNot(bitmap, cropped, scaled)
    }
  }

  // ── saveScaled ───────────────────────────────────────────────
  @ReactMethod
  fun saveScaled(path: String, maxDim: Int, quality: Int, promise: Promise) {
    if (maxDim <= 0 || maxDim > 2048) {
      promise.reject("E_ARGS", "أبعاد التصغير غير صالحة", null)
      return
    }
    var bitmap: Bitmap? = null
    var out: Bitmap? = null
    try {
      val src = File(path)
      if (!src.exists()) {
        promise.reject("E_NOFILE", "ملف الصورة غير موجود", null)
        return
      }
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(path, bounds)
      if (bounds.outWidth <= 0) {
        promise.reject("E_DECODE", "تعذر قراءة أبعاد الصورة", null)
        return
      }
      var sample = 1
      val longest = max(bounds.outWidth, bounds.outHeight)
      while (longest / (sample * 2) >= maxDim) {
        sample *= 2
      }
      bitmap = BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample })
      if (bitmap == null) {
        promise.reject("E_DECODE", "تعذر فك ترميز الصورة", null)
        return
      }
      val scale = min(1f, maxDim.toFloat() / max(bitmap.width, bitmap.height))
      out = if (scale < 1f) {
        Bitmap.createScaledBitmap(
          bitmap,
          max(1, (bitmap.width * scale).toInt()),
          max(1, (bitmap.height * scale).toInt()),
          true
        )
      } else {
        bitmap
      }

      val dir = File(reactApplicationContext.filesDir, "thumbs")
      if (!dir.exists()) dir.mkdirs()
      val dst = File(dir, "thumb_${System.currentTimeMillis()}.jpg")
      FileOutputStream(dst).use { fos ->
        out.compress(Bitmap.CompressFormat.JPEG, quality.coerceIn(30, 100), fos)
      }
      promise.resolve(dst.absolutePath)
    } catch (oom: OutOfMemoryError) {
      promise.reject("E_OOM", "نفدت الذاكرة أثناء تصغير الصورة", null)
    } catch (e: Exception) {
      promise.reject("E_SAVE", "فشل حفظ الصورة المصغرة: ${e.message}", e)
    } finally {
      recycleIfNot(bitmap, out)
    }
  }

  private fun recycleIfNot(vararg bitmaps: Bitmap?) {
    val distinct = bitmaps.filterNotNull().distinct()
    // If the same instance was aliased (crop == src), recycle only once.
    distinct.forEach { it.recycle() }
  }
}
