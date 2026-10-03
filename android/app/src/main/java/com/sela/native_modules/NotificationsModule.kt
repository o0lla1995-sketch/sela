package com.sela.native_modules

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
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
      val builder = NotificationCompat.Builder(ctx, channel)
        .setSmallIcon(ctx.resources.getIdentifier("ic_stat_sela", "drawable", ctx.packageName))
        .setContentTitle(title)
        .setContentText(body)
        .setStyle(NotificationCompat.BigTextStyle().bigText(body))
        .setAutoCancel(true)
        .setPriority(
          if (kind == "out_of_stock") NotificationCompat.PRIORITY_HIGH
          else NotificationCompat.PRIORITY_DEFAULT
        )
      NotificationManagerCompat.from(ctx).notify(id.coerceAtLeast(1), builder.build())
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
