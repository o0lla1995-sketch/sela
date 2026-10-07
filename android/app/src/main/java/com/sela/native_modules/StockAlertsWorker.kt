package com.sela.native_modules

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.database.sqlite.SQLiteDatabase
import android.os.Build
import androidx.core.app.NotificationManagerCompat
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.tencent.mmkv.MMKV
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale
import java.util.concurrent.TimeUnit

/**
 * StockAlertsWorker — v33 (round-41 #3): تنبيهات المخزون خارج التطبيق.
 * ─────────────────────────────────────────────────────────────────
 * «الإشعارات لا تظهر للمستخدم إلا إذا شغّل التطبيق» — كان تقييم
 * التنبيهات يجري في JS لحظة فتح الشاشات فقط. هذا العامل الخلفي
 * (WorkManager دوري كل 6 ساعات، يبقى مجدولاً عبر إعادة التشغيل)
 * يقرأ نفس قاعدة بيانات المتجر مباشرة من Kotlin ويرسل إشعارات
 * النظام حتى والتطبيق مغلق تماماً:
 *
 *  • نفس منطق StockAlertsService (JS) تماماً: نفد / منخفض /
 *    منتهي الصلاحية / قرب انتهاء الصلاحية، بنفس العتبات من إعدادات
 *    التاجر (MMKV — نفس مخزن react-native-mmkv).
 *  • دفتر خصم لكل «منتج:حالة:يوم» في SharedPreferences — إشعار
 *    واحد لكل حالة في اليوم (نفس انضباط مركز الإشعارات).
 *  • إشعار واحد لكل نوع حالة (4 كحد أقصى) بقائمة أسماء المنتجات
 *    في نص موسّع — لا إغراق المستخدم بإشعارات فردية.
 *  • قاعدة البيانات تُقرأ للقراءة فقط (WAL يسمح بالقراءة المتوازية
 *    حتى والتطبيق يعمل) — صفر كتابة، صفر تعارض.
 */
class StockAlertsWorker(context: Context, params: WorkerParameters) :
    CoroutineWorker(context, params) {

  companion object {
    const val WORK_NAME = "sela_stock_alerts_bg"
    private const val CHANNEL_ID = "sela_alerts"
    private const val PREFS = "sela_bg_alerts"
    private const val SETTINGS_KEY = "settings_json_v1"
    private const val MMKV_ID = "vision-pos-store"
    private const val MAX_NAMES_PER_NOTICE = 8

    /** يجدول العامل الدوري (كل 6 ساعات) — يُنادى من Application.onCreate. */
    fun ensureScheduled(context: Context) {
      val request =
          PeriodicWorkRequestBuilder<StockAlertsWorker>(6, TimeUnit.HOURS).build()
      WorkManager.getInstance(context).enqueueUniquePeriodicWork(
          WORK_NAME,
          ExistingPeriodicWorkPolicy.KEEP,
          request,
      )
    }
  }

  private val rlm = "\u200F" // RTL paragraph base for any OEM shade.

  /** إعدادات التاجر من نفس مخزن MMKV الذي يكتب فيه JS. */
  private data class Settings(
      val alertsEnabled: Boolean,
      val lowThreshold: Int,
      val expiryDays: Int,
  )

  private fun readSettings(): Settings {
    return try {
      MMKV.initialize(applicationContext)
      val mmkv = MMKV.mmkvWithID(MMKV_ID)
      val raw = mmkv?.decodeString(SETTINGS_KEY)
      if (raw.isNullOrBlank()) {
        Settings(true, 5, 14)
      } else {
        val json = JSONObject(raw)
        Settings(
            json.optBoolean("stockAlertsEnabled", true),
            json.optInt("lowStockDefaultThreshold", 5),
            json.optInt("expiryAlertDays", 14),
        )
      }
    } catch (e: Exception) {
      Settings(true, 5, 14)
    }
  }

  private fun hasNotificationPermission(): Boolean {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      applicationContext.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
          PackageManager.PERMISSION_GRANTED
    } else {
      NotificationManagerCompat.from(applicationContext).areNotificationsEnabled()
    }
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm =
        applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (nm.getNotificationChannel(CHANNEL_ID) == null) {
      nm.createNotificationChannel(
          NotificationChannel(
              CHANNEL_ID,
              "تنبيهات المخزون",
              NotificationManager.IMPORTANCE_HIGH,
          ).apply { description = "تنبيهات نفاد وانخفاض المخزون والصلاحية" })
    }
  }

  private fun todayString(): String {
    val fmt = SimpleDateFormat("yyyy-MM-dd", Locale.US)
    fmt.timeZone = Calendar.getInstance().timeZone
    return fmt.format(Calendar.getInstance().time)
  }

  override suspend fun doWork(): Result {
    try {
      val settings = readSettings()
      if (!settings.alertsEnabled || !hasNotificationPermission()) {
        return Result.success()
      }

      // قاعدة البيانات — نفس ملف op-sqlite، قراءة فقط.
      val dbFile = File(applicationContext.getDatabasePath("sela.db").absolutePath)
      if (!dbFile.exists()) {
        return Result.success()
      }
      val db =
          SQLiteDatabase.openDatabase(
              dbFile.absolutePath,
              null,
              SQLiteDatabase.OPEN_READONLY,
          )

      val out = mutableListOf<String>()
      val low = mutableListOf<String>()
      val expired = mutableListOf<String>()
      val expiring = mutableListOf<String>()

      db.rawQuery(
          """
          SELECT id, name, stock_quantity, low_stock_threshold, expiry_date
            FROM products
           WHERE is_archived = 0
          """,
          null,
      ).use { cursor ->
        val today = todayString()
        while (cursor.moveToNext()) {
          val id = cursor.getLong(0)
          val name = cursor.getString(1) ?: continue
          val stock = cursor.getDouble(2)
          val thresholdRaw = cursor.getDouble(3)
          val expiry = cursor.getString(4)

          val threshold =
              if (cursor.isNull(3) || thresholdRaw <= 0.0)
                  settings.lowThreshold.toDouble()
              else thresholdRaw

          if (stock <= 0.0) {
            out.add(name)
          } else if (stock <= threshold) {
            low.add(name)
          }

          if (expiry != null && expiry.length >= 10) {
            val day = expiry.substring(0, 10)
            when {
              day < today -> expired.add(name)
              day <= plusDays(today, settings.expiryDays) -> expiring.add(name)
            }
          }
        }
      }
      db.close()

      val prefs: SharedPreferences =
          applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val today = todayString()
      val editor = prefs.edit()

      postByState(prefs, editor, today, "expired", expired)
      postByState(prefs, editor, today, "out", out)
      postByState(prefs, editor, today, "expiring", expiring)
      postByState(prefs, editor, today, "low", low)

      editor.apply()
      return Result.success()
    } catch (e: Exception) {
      // العامل الخلفي لا ينهار أبداً — المحاولة التالية بعد 6 ساعات.
      return Result.success()
    }
  }

  private fun plusDays(isoDate: String, days: Int): String {
    return try {
      val fmt = SimpleDateFormat("yyyy-MM-dd", Locale.US)
      fmt.timeZone = Calendar.getInstance().timeZone
      val cal = Calendar.getInstance()
      cal.time = fmt.parse(isoDate) ?: return isoDate
      cal.add(Calendar.DAY_OF_MONTH, days)
      fmt.format(cal.time)
    } catch (e: Exception) {
      isoDate
    }
  }

  /** إشعار واحد لكل نوع حالة — مرة واحدة يومياً مهما تكرر العامل. */
  private fun postByState(
      prefs: SharedPreferences,
      editor: SharedPreferences.Editor,
      today: String,
      state: String,
      names: List<String>,
  ) {
    if (names.isEmpty()) return
    val key = "$state:$today"
    if (prefs.getBoolean(key, false)) return
    editor.putBoolean(key, true)

    val listed = names.take(MAX_NAMES_PER_NOTICE).joinToString(" · ")
    val suffix =
        if (names.size > MAX_NAMES_PER_NOTICE) {
          " · و${names.size - MAX_NAMES_PER_NOTICE} أخرى"
        } else ""

    val (title, body) =
        when (state) {
          "expired" ->
              "منتهي الصلاحية: ${names.size} منتج" to
                  "$listed$suffix — أخرجها من الرف أو خصّمها قبل أن تصل للزبون."
          "out" ->
              "نفد المخزون: ${names.size} منتج" to
                  "$listed$suffix — أعد التزويد كي لا تفقد مبيعاتها."
          "expiring" ->
              "قرب انتهاء الصلاحية: ${names.size} منتج" to
                  "$listed$suffix — رتّب عرضاً أو خصماً لتصريفها."
          else ->
              "مخزون منخفض: ${names.size} منتج" to
                  "$listed$suffix — راجع التزويد."
        }

    ensureChannel()
    val notification =
        (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(applicationContext, CHANNEL_ID)
        else
            @Suppress("DEPRECATION") Notification.Builder(applicationContext))
            .apply {
              setSmallIcon(
                  applicationContext.resources.getIdentifier(
                      "ic_stat_sela", "drawable", applicationContext.packageName))
              setContentTitle(rlm + title)
              setContentText(rlm + body)
              setStyle(Notification.BigTextStyle().bigText(rlm + body))
              setAutoCancel(true)
              setPriority(
                  if (state == "out" || state == "expired")
                      Notification.PRIORITY_HIGH
                  else Notification.PRIORITY_DEFAULT)
            }
            .build()
    val id = 9000 + state.hashCode() % 1000
    NotificationManagerCompat.from(applicationContext).notify(id, notification)
  }
}
