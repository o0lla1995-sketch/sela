package com.sela.pal.native_modules

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.io.FileOutputStream
import kotlin.math.max

/**
 * ImagePickerModule
 * ─────────────────────────────────────────────────────────────────
 * Opens the Android system image picker (SAF — no storage permission
 * needed on ANY Android version) and copies the chosen image into the
 * app's private files directory.
 *
 *   pickStoreLogo(maxDim)              -> branding/store_logo_*.png
 *   pickVoucherImage(maxDim)   v46     -> vouchers/voucher_*.jpg
 *   saveVoucherFromPath(p,max) v46     -> vouchers/voucher_*.jpg
 *                                          (from a camera shot file,
 *                                          the source inside scans/
 *                                          is deleted on success)
 *
 * The logo flow keeps its single-file behavior (the dir is cleared —
 * only one logo is ever needed). The voucher flow NEVER clears the
 * dir: every cash-movement voucher owns its file for its whole life
 * (rows are immutable — the audit trail rule), and the file is only
 * removed by the JS sheet when the attach is cancelled/replaced
 * BEFORE the movement is recorded.
 *
 * Voucher images are stored as JPEG q88 (photos, not line art) with
 * the long edge capped at maxDim — 1600 keeps an A4 receipt legible
 * while the file stays in the 150-400KB range.
 */
class ImagePickerModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext), ActivityEventListener {

  companion object {
    const val NAME = "SelaImagePicker"
    private const val REQUEST_PICK_LOGO = 8102
    private const val REQUEST_PICK_VOUCHER = 8103
  }

  /** One pending promise at a time — routed by its request code. */
  private var pendingPromise: Promise? = null
  private var pendingRequest: Int = 0
  private var pendingMaxDim: Int = 512
  private var pendingKind: String = "logo"

  init {
    reactContext.addActivityEventListener(this)
  }

  override fun getName(): String = NAME

  override fun onCatalystInstanceDestroy() {
    reactContext.removeActivityEventListener(this)
    pendingPromise?.reject("CANCELLED", "أُغلق منتقي الصور", null)
    pendingPromise = null
  }

  private fun begin(promise: Promise, request: Int, maxDim: Int, kind: String) {
    pendingPromise?.reject("BUSY", "عملية اختيار أخرى قيد التنفيذ", null)
    pendingPromise = promise
    pendingRequest = request
    pendingMaxDim = maxDim.coerceIn(128, 2048)
    pendingKind = kind
  }

  /** Gallery pick for the store logo (Settings — receipt header). */
  @ReactMethod
  fun pickStoreLogo(maxDim: Int, promise: Promise) {
    val activity: Activity? = currentActivity
    if (activity == null) {
      promise.reject("NO_ACTIVITY", "لا توجد نافذة نشطة", null)
      return
    }
    begin(promise, REQUEST_PICK_LOGO, maxDim, "logo")
    try {
      val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
        type = "image/*"
        addCategory(Intent.CATEGORY_OPENABLE)
      }
      activity.startActivityForResult(
        Intent.createChooser(intent, "اختر شعار المتجر"),
        REQUEST_PICK_LOGO
      )
    } catch (e: Exception) {
      pendingPromise = null
      promise.reject("PICK_FAILED", "تعذر فتح منتقي الصور: ${e.message}", e)
    }
  }

  /**
   * v46: gallery pick for a cash-movement voucher photo. Same SAF
   * flow as the logo; the copy lands in filesDir/vouchers as JPEG
   * and the dir is NEVER cleared.
   */
  @ReactMethod
  fun pickVoucherImage(maxDim: Int, promise: Promise) {
    val activity: Activity? = currentActivity
    if (activity == null) {
      promise.reject("NO_ACTIVITY", "لا توجد نافذة نشطة", null)
      return
    }
    begin(promise, REQUEST_PICK_VOUCHER, maxDim, "voucher")
    try {
      val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
        type = "image/*"
        addCategory(Intent.CATEGORY_OPENABLE)
      }
      activity.startActivityForResult(
        Intent.createChooser(intent, "اختر صورة السند"),
        REQUEST_PICK_VOUCHER
      )
    } catch (e: Exception) {
      pendingPromise = null
      promise.reject("PICK_FAILED", "تعذر فتح منتقي الصور: ${e.message}", e)
    }
  }

  /**
   * v46: adopt an EXISTING image file (the scanner camera shot saved
   * under filesDir/scans) as the movement's voucher: decode → scale
   * to maxDim → save into filesDir/vouchers as JPEG q88 → delete the
   * source when it lives inside scans/ (the camera temp). Rejects on
   * a missing/undecodable file — the JS sheet shows the Arabic toast.
   */
  @ReactMethod
  fun saveVoucherFromPath(path: String, maxDim: Int, promise: Promise) {
    try {
      if (path.isBlank()) {
        promise.reject("E_ARGS", "مسار الصورة فارغ", null)
        return
      }
      val src = File(path)
      if (!src.exists() || src.length() == 0L) {
        promise.reject("E_NOFILE", "ملف الصورة غير موجود", null)
        return
      }
      val clamped = maxDim.coerceIn(128, 2048)
      val saved = scaleSaveVoucher(
        { decodeSampled(src.absolutePath, clamped) },
        clamped
      )
      if (saved == null) {
        promise.reject("E_DECODE", "تعذر قراءة صورة السند", null)
        return
      }
      // Success: the camera temp inside scans/ is no longer needed.
      val scansRoot = File(reactContext.filesDir, "scans").absolutePath
      if (src.absolutePath.startsWith(scansRoot + File.separator)) {
        try { src.delete() } catch (_: Exception) { /* best effort */ }
      }
      promise.resolve(saved)
    } catch (oom: OutOfMemoryError) {
      promise.reject("E_OOM", "نفدت الذاكرة أثناء تجهيز صورة السند", null)
    } catch (e: Exception) {
      promise.reject("E_SAVE", "فشل تجهيز صورة السند: ${e.message}", e)
    }
  }

  override fun onActivityResult(
    activity: Activity?,
    requestCode: Int,
    resultCode: Int,
    data: Intent?,
  ) {
    if (requestCode != REQUEST_PICK_LOGO && requestCode != REQUEST_PICK_VOUCHER) return
    val promise = pendingPromise ?: return
    val kind = pendingKind
    val maxDim = pendingMaxDim
    pendingPromise = null
    try {
      if (resultCode != Activity.RESULT_OK || data?.data == null) {
        promise.reject("CANCELLED", "لم يتم اختيار صورة", null)
        return
      }
      val uri: Uri = data.data!!
      if (kind == "voucher") {
        val saved = scaleSaveVoucher(
          { decodeFromUri(uri, maxDim) },
          maxDim
        )
        if (saved != null) {
          promise.resolve(saved)
        } else {
          promise.reject("COPY_FAILED", "تعذر حفظ صورة السند", null)
        }
      } else {
        val copied = copyAndScaleLogo(uri, maxDim)
        if (copied != null) {
          promise.resolve(copied)
        } else {
          promise.reject("COPY_FAILED", "تعذر حفظ الشعار", null)
        }
      }
    } catch (e: Exception) {
      promise.reject("PICK_FAILED", "فشل اختيار الصورة: ${e.message}", e)
    }
  }

  override fun onNewIntent(intent: Intent?) {
    // No-op — required by ActivityEventListener.
  }

  // ── shared pipelines ────────────────────────────────────────────

  /**
   * v46: bounds-sampled decode of a plain file — camera shots can be
   * 12MP+; reading bounds first and sampling avoids a 48MB bitmap
   * just to throw most of it away during the downscale to maxDim.
   */
  private fun decodeSampled(path: String, maxDim: Int): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(path, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    val longest = max(bounds.outWidth, bounds.outHeight)
    while (longest / (sample * 2) >= maxDim) sample *= 2
    val opts = BitmapFactory.Options().apply { inSampleSize = sample }
    return BitmapFactory.decodeFile(path, opts)
  }

  /** SAF uri → sampled bitmap (logo path, PNG decode bounds first). */
  private fun decodeFromUri(uri: Uri, maxDim: Int): Bitmap? {
    val resolver = reactContext.contentResolver
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    val longest = max(bounds.outWidth, bounds.outHeight)
    while (longest / (sample * 2) >= maxDim) sample *= 2
    val opts = BitmapFactory.Options().apply { inSampleSize = sample }
    return resolver.openInputStream(uri)?.use {
      BitmapFactory.decodeStream(it, null, opts)
    }
  }

  /** Decodes the SAF uri, downscales to maxDim, PNG into branding/. */
  private fun copyAndScaleLogo(uri: Uri, maxDim: Int): String? {
    var bitmap: Bitmap? = null
    var out: Bitmap? = null
    try {
      bitmap = decodeFromUri(uri, maxDim) ?: return null
      val scale = minOf(1f, maxDim.toFloat() / max(bitmap.width, bitmap.height))
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
      val dir = File(reactContext.filesDir, "branding")
      if (!dir.exists()) dir.mkdirs()
      // Clean previous logos — only one is ever needed.
      dir.listFiles()?.forEach { it.delete() }
      val dst = File(dir, "store_logo_${System.currentTimeMillis()}.png")
      FileOutputStream(dst).use { fos ->
        out.compress(Bitmap.CompressFormat.PNG, 100, fos)
      }
      return dst.absolutePath
    } catch (oom: OutOfMemoryError) {
      return null
    } catch (e: Exception) {
      return null
    } finally {
      val distinct = listOfNotNull(bitmap, out).distinct()
      distinct.forEach { if (!it.isRecycled) it.recycle() }
    }
  }

  /**
   * v46: bitmap factory → scaled to maxDim (long edge) → JPEG q88 in
   * filesDir/vouchers. `decode` may return null on a broken file —
   * that maps to E_DECODE upstream.
   */
  private fun scaleSaveVoucher(decode: () -> Bitmap?, maxDim: Int): String? {
    var bitmap: Bitmap? = null
    var out: Bitmap? = null
    try {
      bitmap = decode() ?: return null
      val scale = minOf(1f, maxDim.toFloat() / max(bitmap.width, bitmap.height))
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
      val dir = File(reactContext.filesDir, "vouchers")
      if (!dir.exists()) dir.mkdirs()
      // NEVER clear this dir — every voucher file is owned by an
      // immutable cash_movements row for its whole audit life.
      val dst = File(dir, "voucher_${System.currentTimeMillis()}.jpg")
      FileOutputStream(dst).use { fos ->
        out.compress(Bitmap.CompressFormat.JPEG, 88, fos)
      }
      return dst.absolutePath
    } catch (oom: OutOfMemoryError) {
      return null
    } catch (e: Exception) {
      return null
    } finally {
      val distinct = listOfNotNull(bitmap, out).distinct()
      distinct.forEach { if (!it.isRecycled) it.recycle() }
    }
  }
}
