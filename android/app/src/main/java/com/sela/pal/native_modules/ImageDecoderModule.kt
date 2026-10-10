package com.sela.pal.native_modules

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
 *  decodeRgbEx(path, size, zoom, fit, flip) -> same, with the
 *                            v9.1 ensemble controls (round-14 #2):
 *                            zoom (0,1] = center square of
 *                            min(w,h)*zoom — a deeper crop; fit =
 *                            scale the WHOLE frame to the square
 *                            (packaging context); flip = horizontal
 *                            mirror (enrollment augmentation).
 *  decodeRgbWindow(path, size, cx, cy, w) -> v10 (round-16 #4)
 *                            multi-product window probe: a square
 *                            window of side min(w,h)*w centered at
 *                            (cx,cy) in FRACTIONS of the frame,
 *                            cropped from a CACHED decode of the
 *                            same path — the 10-window pass decodes
 *                            the JPEG once and crops cheaply.
 *  releaseDecodeCache()  -> frees the cached bitmap (call when the
 *                            window pass for a photo is done).
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

  // ── v10 window-probe cache ─────────────────────────────────────
  // The multi-product pass fires ~10 window decodes for the SAME
  // photo. Decoding the JPEG once (long edge capped at 1280 — plenty
  // for a 0.55 window at 224px input) and cropping the cached bitmap
  // makes the extra windows nearly free.
  private val decodeLock = Any()
  private var cachedPath: String? = null
  private var cachedBitmap: Bitmap? = null

  /** Decodes (or reuses) the cached photo for window crops. */
  private fun windowSource(path: String): Bitmap? {
    synchronized(decodeLock) {
      if (cachedPath == path && cachedBitmap != null) {
        return cachedBitmap
      }
      val file = File(path)
      if (!file.exists() || file.length() == 0L) {
        return null
      }
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(path, bounds)
      if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
        return null
      }
      val cap = 1280
      var sample = 1
      val longest = max(bounds.outWidth, bounds.outHeight)
      while (longest / (sample * 2) >= cap) {
        sample *= 2
      }
      val decoded = BitmapFactory.decodeFile(
        path, BitmapFactory.Options().apply { inSampleSize = sample }
      ) ?: return null
      val scale = min(1f, cap.toFloat() / max(decoded.width, decoded.height))
      val scaled = if (scale < 1f) {
        Bitmap.createScaledBitmap(
          decoded,
          max(1, (decoded.width * scale).toInt()),
          max(1, (decoded.height * scale).toInt()),
          true
        ).also { if (it !== decoded) decoded.recycle() }
      } else {
        decoded
      }
      runCatching { cachedBitmap?.recycle() }
      cachedBitmap = scaled
      cachedPath = path
      return scaled
    }
  }

  /** Extracts size×size RGB from a square window (fraction coords). */
  private fun windowRgb(
    src: Bitmap,
    size: Int,
    cx: Float,
    cy: Float,
    w: Float,
  ): ByteArray? {
    val bw = src.width
    val bh = src.height
    val side = (min(bw, bh) * w).toInt().coerceIn(8, min(bw, bh))
    var left = (cx * bw - side / 2f).toInt()
    var top = (cy * bh - side / 2f).toInt()
    left = left.coerceIn(0, bw - side)
    top = top.coerceIn(0, bh - side)
    val crop = Bitmap.createBitmap(src, left, top, side, side)
    val scaled = if (crop.width == size && crop.height == size) {
      crop
    } else {
      Bitmap.createScaledBitmap(crop, size, size, true).also {
        if (it !== crop) crop.recycle()
      }
    }
    return try {
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
      bytes
    } finally {
      scaled.recycle()
    }
  }

  /** v10 (round-16 #4): one multi-product window probe. */
  @ReactMethod
  fun decodeRgbWindow(
    path: String,
    size: Int,
    cx: Double,
    cy: Double,
    w: Double,
    promise: Promise
  ) {
    if (size <= 0 || size > 512) {
      promise.reject("E_ARGS", "حجم فك الترميز غير صالح", null)
      return
    }
    try {
      val src = synchronized(decodeLock) { windowSource(path) }
      if (src == null) {
        promise.reject("E_NOFILE", "ملف الصورة غير موجود", null)
        return
      }
      val bytes = synchronized(decodeLock) {
        windowRgb(src, size, cx.toFloat(), cy.toFloat(), w.toFloat())
      }
      if (bytes == null) {
        promise.reject("E_DECODE", "تعذر قص نافذة الصورة", null)
        return
      }
      promise.resolve(Base64.encodeToString(bytes, Base64.NO_WRAP))
    } catch (oom: OutOfMemoryError) {
      runCatching { releaseCacheLocked() }
      promise.reject("E_OOM", "نفدت الذاكرة أثناء معالجة الصورة — أعد المحاولة", null)
    } catch (e: Exception) {
      promise.reject("E_DECODE", "فشل فك ترميز الصورة: ${e.message}", e)
    }
  }

  /** Frees the cached window-probe bitmap. */
  @ReactMethod
  fun releaseDecodeCache(promise: Promise) {
    synchronized(decodeLock) {
      runCatching { releaseCacheLocked() }
    }
    promise.resolve(null)
  }

  private fun releaseCacheLocked() {
    runCatching { cachedBitmap?.recycle() }
    cachedBitmap = null
    cachedPath = null
  }

  // -- decodeRgb (public API) ------------------------------------
  @ReactMethod
  fun decodeRgb(path: String, size: Int, promise: Promise) {
    decodeRgbInternal(path, size, 1f, false, false, promise)
  }

  /**
   * v9.1 (round-14 #2): ensemble decode — zoom (a deeper center
   * crop), whole-frame fit (packaging context) and horizontal
   * mirror (enrollment augmentation) on the SAME proven pipeline.
   */
  @ReactMethod
  fun decodeRgbEx(
    path: String,
    size: Int,
    zoom: Double,
    fit: Boolean,
    flip: Boolean,
    promise: Promise
  ) {
    val z = when {
      fit -> 1f
      zoom <= 0.0 || zoom > 1.0 -> 1f
      else -> zoom.toFloat()
    }
    decodeRgbInternal(path, size, z, fit, flip, promise)
  }

  private fun decodeRgbInternal(
    path: String,
    size: Int,
    zoom: Float,
    fit: Boolean,
    flip: Boolean,
    promise: Promise
  ) {
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

      // 3. v9.1 ensemble crop for the model input:
      //    fit      -> the WHOLE frame scaled to size x size (context),
      //    zoom<=1  -> center square of side = min(w,h)*zoom (a deeper
      //                crop zooms INTO the product; 1 = classic crop).
      val w = bitmap.width
      val h = bitmap.height
      cropped = if (fit) {
        Bitmap.createScaledBitmap(bitmap, size, size, true)
      } else {
        val side = (min(w, h) * zoom).toInt().coerceIn(8, min(w, h))
        val left = (w - side) / 2
        val top = (h - side) / 2
        if (side == w && side == h) {
          bitmap
        } else {
          Bitmap.createBitmap(bitmap, left, top, side, side)
        }
      }
      scaled = if (cropped.width == size && cropped.height == size) {
        cropped
      } else {
        Bitmap.createScaledBitmap(cropped, size, size, true)
      }

      // 3.5 v9.1: optional horizontal mirror (enrollment
      //     augmentation — orientation-invariant fingerprints).
      if (flip && scaled.width == size && scaled.height == size) {
        val matrix = android.graphics.Matrix().apply { setScale(-1f, 1f) }
        val mirrored = Bitmap.createBitmap(scaled, 0, 0, size, size, matrix, false)
        recycleIfNot(scaled)
        scaled = mirrored
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
