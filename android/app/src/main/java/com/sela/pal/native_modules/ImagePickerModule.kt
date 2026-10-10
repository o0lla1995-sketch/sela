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
 * app's private files directory as a logo-ready PNG/JPEG.
 *
 *   pickStoreLogo(maxDim) -> absolute path of the saved copy
 *
 * Used by Settings so the merchant can set the store logo that also
 * prints at the top of thermal receipts.
 */
class ImagePickerModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext), ActivityEventListener {

  companion object {
    const val NAME = "SelaImagePicker"
    private const val REQUEST_PICK_LOGO = 8102
  }

  private var pendingPromise: Promise? = null
  private var pendingMaxDim: Int = 512

  init {
    reactContext.addActivityEventListener(this)
  }

  override fun getName(): String = NAME

  override fun onCatalystInstanceDestroy() {
    reactContext.removeActivityEventListener(this)
    pendingPromise?.reject("CANCELLED", "أُغلق منتقي الصور", null)
    pendingPromise = null
  }

  @ReactMethod
  fun pickStoreLogo(maxDim: Int, promise: Promise) {
    val activity: Activity? = currentActivity
    if (activity == null) {
      promise.reject("NO_ACTIVITY", "لا توجد نافذة نشطة", null)
      return
    }
    pendingPromise?.reject("BUSY", "عملية اختيار أخرى قيد التنفيذ", null)
    pendingPromise = promise
    pendingMaxDim = maxDim.coerceIn(128, 1024)
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

  override fun onActivityResult(
    activity: Activity?,
    requestCode: Int,
    resultCode: Int,
    data: Intent?
  ) {
    if (requestCode != REQUEST_PICK_LOGO) return
    val promise = pendingPromise ?: return
    pendingPromise = null
    try {
      if (resultCode != Activity.RESULT_OK || data?.data == null) {
        promise.reject("CANCELLED", "لم يتم اختيار صورة", null)
        return
      }
      val uri: Uri = data.data!!
      val copied = copyAndScale(uri, pendingMaxDim)
      if (copied != null) {
        promise.resolve(copied)
      } else {
        promise.reject("COPY_FAILED", "تعذر حفظ الشعار", null)
      }
    } catch (e: Exception) {
      promise.reject("PICK_FAILED", "فشل اختيار الشعار: ${e.message}", e)
    }
  }

  override fun onNewIntent(intent: Intent?) {
    // No-op — required by ActivityEventListener.
  }

  /** Decodes the SAF uri, downscales to maxDim and writes a private copy. */
  private fun copyAndScale(uri: Uri, maxDim: Int): String? {
    var bitmap: Bitmap? = null
    var out: Bitmap? = null
    try {
      val resolver = reactContext.contentResolver
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
      if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

      var sample = 1
      val longest = max(bounds.outWidth, bounds.outHeight)
      while (longest / (sample * 2) >= maxDim) sample *= 2
      val opts = BitmapFactory.Options().apply { inSampleSize = sample }
      bitmap = resolver.openInputStream(uri)?.use {
        BitmapFactory.decodeStream(it, null, opts)
      } ?: return null

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
}
