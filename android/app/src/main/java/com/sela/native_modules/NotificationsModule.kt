package com.sela.native_modules

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationManagerCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * NotificationsModule
 * ─────────────────────────────────────────────────────────────────
 * Local system notifications for stock alerts (low stock / out of
 * stock) — fully offline, no push service involved.
 *
 *  areNotificationsEnabled() -> Boolean
 *  requestPermission()       -> Boolean (Android 13+ POST_NOTIFICATIONS)
 *  show(id, title, body, kind) -> posts to the "sela_alerts" channel
 */
class NotificationsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  companion object {
    const val CHANNEL_ID = "sela_alerts"
    const val CHANNEL_SALES_ID = "sela_sales"
  }

  override fun getName(): String = "SelaNotifications"

  init {
    createChannels()
  }

  private fun createChannels() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = reactApplicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val alerts = NotificationChannel(
      CHANNEL_ID,
      "تنبيهات المخزون",
      NotificationManager.IMPORTANCE_HIGH
    ).apply {
      description = "تنبيهات نفاد وانخفاض المخزون"
    }
    val sales = NotificationChannel(
      CHANNEL_SALES_ID,
      "ملخصات المبيعات",
      NotificationManager.IMPORTANCE_DEFAULT
    ).apply {
      description = "ملخصات نهاية اليوم والمبيعات"
    }
    nm.createNotificationChannel(alerts)
    nm.createNotificationChannel(sales)
  }

  private fun hasPermission(): Boolean {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      reactApplicationContext.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
        PackageManager.PERMISSION_GRANTED
    } else {
      NotificationManagerCompat.from(reactApplicationContext).areNotificationsEnabled()
    }
  }

  @ReactMethod
  fun areNotificationsEnabled(promise: Promise) {
    try {
      promise.resolve(hasPermission())
    } catch (e: Exception) {
      promise.reject("E_NOTIF", e.message, e)
    }
  }

  @ReactMethod
  fun requestPermission(promise: Promise) {
    try {
      val activity = currentActivity
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && activity != null) {
        if (hasPermission()) {
          promise.resolve(true)
          return
        }
        // Delegate the actual system dialog to the JS layer's
        // PermissionsAndroid — here we only report the current state.
        promise.resolve(false)
        return
      }
      promise.resolve(NotificationManagerCompat.from(reactApplicationContext).areNotificationsEnabled())
    } catch (e: Exception) {
      promise.reject("E_NOTIF", e.message, e)
    }
  }

  @ReactMethod
  fun show(id: Int, title: String, body: String, kind: String, promise: Promise) {
    try {
      if (!hasPermission()) {
        promise.resolve(false)
        return
      }
      val ctx = reactApplicationContext
      val channel = when (kind) {
        "sale" -> CHANNEL_SALES_ID
        else -> CHANNEL_ID
      }
      // Arabic-first notification. The app context itself is already
      // Arabic/RTL (MainApplication.attachBaseContext forces it), so the
      // builder inherits the RTL configuration. As a text-level guarantee
      // on any OEM shade, each string is prefixed with RLM (U+200F) so the
      // bidi paragraph base direction is right-to-left — fixes "alerts
      // read left-to-right and get cut off at the left edge" on devices
      // whose system locale isn't Arabic.
      val rlm = "\u200F"
      val notification = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Notification.Builder(ctx, channel)
      } else {
        @Suppress("DEPRECATION")
        Notification.Builder(ctx)
      }.apply {
        setSmallIcon(
          ctx.resources.getIdentifier("ic_stat_sela", "drawable", ctx.packageName)
        )
        setContentTitle(rlm + title)
        setContentText(rlm + body)
        setStyle(Notification.BigTextStyle().bigText(rlm + body))
        setAutoCancel(true)
        setPriority(
          if (kind == "out_of_stock") Notification.PRIORITY_HIGH
          else Notification.PRIORITY_DEFAULT
        )
      }.build()
      NotificationManagerCompat.from(ctx).notify(id.coerceAtLeast(1), notification)
      promise.resolve(true)
    } catch (e: Exception) {
      // A failed notification must never crash the app.
      promise.reject("E_NOTIF", "تعذر إرسال الإشعار: ${e.message}", e)
    }
  }

  @ReactMethod
  fun cancelAll(promise: Promise) {
    try {
      NotificationManagerCompat.from(reactApplicationContext).cancelAll()
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("E_NOTIF", e.message, e)
    }
  }
}
