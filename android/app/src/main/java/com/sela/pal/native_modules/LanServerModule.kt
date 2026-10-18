package com.sela.pal.native_modules

import android.os.Build
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.BufferedInputStream
import java.io.BufferedWriter
import java.io.OutputStreamWriter
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.nio.charset.StandardCharsets
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import org.json.JSONObject

/**
 * LanServerModule — v58 (الجولة 62): خادم «سيلّا كاشير» على الشبكة
 * المحلية.
 * ─────────────────────────────────────────────────────────────────
 * غلاف أصلي رفيع (بلا أي مكتبة خارجية): خادم HTTP/1.1 مبسّط على
 * منفذ محلي يستقبل طلبات تطبيق الكاشير ويمررها إلى JS عبر حدث
 * `lanRequest`، ثم ينتظر ردّ JS عبر `respond(id, status, body)`
 * (مهلة 30 ثانية) ويكتب الاستجابة للعميل. منطق العمل كله في TS
 * (LanHandlers) — نفس مسارات البيع/الإرجاع التي تستعملها واجهة
 * نقطة البيع نفسها، بلا تكرار ولا مسار موازٍ.
 *
 *  • start(port, storeName)  → يشغّل HTTP + مستجيب بث الاستكشاف UDP.
 *  • stop()                  → يوقفهما ويقطع كل الطلبات المعلقة.
 *  • respond(id, status, jsonBody) → رد JS على طلب HTTP معلق.
 *  • setStoreName(name)      → تحديث اسم المتجر في ردود الاستكشاف.
 *
 * الاستكشاف (UDP 8951): تطبيق الكاشير يبث `SELA_POS_DISCOVER_v1`
 * على الشبكة؛ كل نقطة بيع تسمع البث ترد ببطاقة JSON:
 *   {app:"sela-pos", proto:1, port:8950, store:"…", device:"…"}
 *
 * ملاحظات:
 *  • كل اتصال على خيطه الخاص — انتظار رد JS عبر CountDownLatch لا
 *    يعرقل بقية الاتصالات ولا خيط واجهة المستخدم.
 *  • نص الطلب يُقرأ كاملاً وفق Content-Length (تطبيق الكاشير هو
 *    العميل الوحيد — لا حاجة لـ chunked ولا keep-alive).
 *  • الأذونات جاهزة أصلاً: INTERNET موجود في البيان، والشبكة
 *    المحلية مسموحة (usesCleartextTraffic).
 */
class LanServerModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  companion object {
    const val NAME = "LanServer"
    const val DISCOVERY_PORT = 8951
    const val DISCOVERY_MAGIC = "SELA_POS_DISCOVER_v1"
    const val REQUEST_TIMEOUT_MS = 30_000L
    const val MAX_HEADER_BYTES = 64 * 1024
    const val MAX_BODY_BYTES = 2 * 1024 * 1024
  }

  override fun getName(): String = NAME

  private val running = AtomicBoolean(false)
  private var serverSocket: ServerSocket? = null
  private var discoverySocket: DatagramSocket? = null
  private val pending = ConcurrentHashMap<String, PendingResponse>()
  private val requestSeq = AtomicLong(0)

  @Volatile
  private var storeName: String = "متجر sela"

  /** ردّ مُعلّق ينتظره خيط الاتصال. */
  private class PendingResponse(val latch: CountDownLatch) {
    @Volatile
    var status: Int = 503

    @Volatile
    var body: String = "{\"ok\":false,\"error\":\"انتهت مهلة الطلب\"}"
  }

  // ── واجهة JS ───────────────────────────────────────────────────

  @ReactMethod
  fun start(port: Int, store: String, promise: com.facebook.react.bridge.Promise) {
    if (running.get()) {
      promise.resolve(true)
      return
    }
    storeName = store
    try {
      val server = ServerSocket()
      server.reuseAddress = true
      server.bind(InetAddress.getByName("0.0.0.0"), port)
      serverSocket = server
      running.set(true)

      val acceptThread = Thread {
        while (running.get()) {
          try {
            val client = server.accept()
            client.soTimeout = 35_000
            Thread { serve(client) }.start()
          } catch (e: Exception) {
            if (running.get()) {
              Thread.sleep(150)
            }
          }
        }
      }
      acceptThread.isDaemon = true
      acceptThread.name = "lan-http-accept"
      acceptThread.start()

      startDiscovery()

      promise.resolve(true)
    } catch (e: Exception) {
      running.set(false)
      serverSocket = null
      promise.reject("LAN_START_FAILED", e.message ?: "تعذر فتح المنفذ", e)
    }
  }

  @ReactMethod
  fun stop(promise: com.facebook.react.bridge.Promise) {
    running.set(false)
    try {
      serverSocket?.close()
    } catch (_: Exception) {
    }
    serverSocket = null
    try {
      discoverySocket?.close()
    } catch (_: Exception) {
    }
    discoverySocket = null
    // حرّر كل الطلبات المعلقة فوراً برمز إيقاف الخدمة.
    for ((_, pendingResponse) in pending) {
      pendingResponse.status = 503
      pendingResponse.body = "{\"ok\":false,\"error\":\"أُوقف خادم الكاشير\"}"
      pendingResponse.latch.countDown()
    }
    pending.clear()
    promise.resolve(true)
  }

  @ReactMethod
  fun isRunning(promise: com.facebook.react.bridge.Promise) {
    promise.resolve(running.get())
  }

  @ReactMethod
  fun setStoreName(name: String) {
    storeName = name
  }

  @ReactMethod
  fun respond(id: String, status: Int, body: String) {
    val pendingResponse = pending.remove(id)
    if (pendingResponse != null) {
      pendingResponse.status = status
      pendingResponse.body = body
      pendingResponse.latch.countDown()
    }
  }

  // ── خدمة HTTP ──────────────────────────────────────────────────

  private fun serve(client: Socket) {
    try {
      client.use { socket ->
        val input = BufferedInputStream(socket.getInputStream())
        val writer = BufferedWriter(
          OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8),
        )

        // طلب واحد لكل اتصال (Connection: close) — أبسط نموذج
        // يكفي تماماً لتطبيق الكاشير على الشبكة المحلية.
        val requestLine = readLine(input) ?: return
        val parts = requestLine.split(" ")
        if (parts.size < 2) {
          writeResponse(writer, 400, "{\"ok\":false,\"error\":\"طلب غير صالح\"}")
          return
        }
        val method = parts[0].uppercase()
        val rawTarget = parts[1]

        // ترويسات
        val headers = HashMap<String, String>()
        while (true) {
          val line = readLine(input) ?: break
          if (line.isEmpty()) {
            break
          }
          val colon = line.indexOf(':')
          if (colon > 0) {
            headers[line.substring(0, colon).trim().lowercase()] =
              line.substring(colon + 1).trim()
          }
        }

        // جسم الطلب وفق Content-Length
        val contentLength = headers["content-length"]?.toIntOrNull() ?: 0
        var body = ""
        if (contentLength > 0) {
          if (contentLength > MAX_BODY_BYTES) {
            writeResponse(writer, 413, "{\"ok\":false,\"error\":\"الطلب كبير جداً\"}")
            return
          }
          val bodyBytes = ByteArray(contentLength)
          var read = 0
          while (read < contentLength) {
            val n = input.read(bodyBytes, read, contentLength - read)
            if (n < 0) {
              break
            }
            read += n
          }
          body = String(bodyBytes, 0, read, StandardCharsets.UTF_8)
        }

        // تقسيم المسار ومعاملات الاستعلام
        var path = rawTarget
        var query = ""
        val qMark = rawTarget.indexOf('?')
        if (qMark >= 0) {
          path = rawTarget.substring(0, qMark)
          query = rawTarget.substring(qMark + 1)
        }

        val id = "lan-${requestSeq.incrementAndGet()}"
        val payload = Arguments.createMap().apply {
          putString("id", id)
          putString("method", method)
          putString("path", path)
          putString("query", query)
          putString("body", body)
          putString(
            "auth",
            headers["authorization"],
          )
          putString("ip", socket.inetAddress?.hostAddress)
        }

        val pendingResponse = PendingResponse(CountDownLatch(1))
        pending[id] = pendingResponse
        emitEvent("lanRequest", payload)

        if (!pendingResponse.latch.await(REQUEST_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
          pending.remove(id)
          writeResponse(
            writer,
            503,
            "{\"ok\":false,\"error\":\"انتهت مهلة معالجة الطلب\"}",
          )
          return
        }
        writeResponse(writer, pendingResponse.status, pendingResponse.body)
      }
    } catch (_: Exception) {
      // انقطع الاتصال أو أُوقف الخادم — لا شيء آخر يجب فعله.
    }
  }

  /** قراءة سطر نصي منفقّط بـ CRLF من الدفق. */
  private fun readLine(input: BufferedInputStream): String? {
    val out = StringBuilder()
    var total = 0
    while (true) {
      val b = input.read()
      if (b < 0) {
        return if (out.isEmpty()) null else out.toString()
      }
      if (b == '\n'.code) {
        break
      }
      if (b != '\r'.code) {
        out.append(b.toChar())
        total += 1
        if (total > MAX_HEADER_BYTES) {
          return null
        }
      }
    }
    return out.toString()
  }

  private fun writeResponse(writer: BufferedWriter, status: Int, body: String) {
    val reason = when (status) {
      200 -> "OK"
      400 -> "Bad Request"
      401 -> "Unauthorized"
      403 -> "Forbidden"
      404 -> "Not Found"
      413 -> "Payload Too Large"
      429 -> "Too Many Requests"
      503 -> "Service Unavailable"
      else -> "Error"
    }
    val bytes = body.toByteArray(StandardCharsets.UTF_8)
    writer.write("HTTP/1.1 $status $reason\r\n")
    writer.write("Content-Type: application/json; charset=utf-8\r\n")
    writer.write("Content-Length: ${bytes.size}\r\n")
    writer.write("Connection: close\r\n")
    writer.write("\r\n")
    writer.write(body)
    writer.flush()
  }

  // ── مستجيب بث الاستكشاف (UDP) ─────────────────────────────────

  private fun startDiscovery() {
    try {
      val socket = DatagramSocket(null)
      socket.reuseAddress = true
      socket.broadcast = true
      socket.bind(java.net.InetSocketAddress(DISCOVERY_PORT))
      discoverySocket = socket
      val thread = Thread {
        val buffer = ByteArray(512)
        while (running.get()) {
          try {
            val packet = DatagramPacket(buffer, buffer.size)
            socket.soTimeout = 500
            socket.receive(packet)
            val text = String(packet.data, 0, packet.length, StandardCharsets.UTF_8)
            if (text.trim() == DISCOVERY_MAGIC) {
              val card = JSONObject().apply {
                put("app", "sela-pos")
                put("proto", 1)
                put("port", serverSocket?.localPort ?: 8950)
                put("store", storeName)
                put("device", "${Build.MANUFACTURER} ${Build.MODEL}")
              }
              val reply = card.toString().toByteArray(StandardCharsets.UTF_8)
              socket.send(
                DatagramPacket(
                  reply,
                  reply.size,
                  packet.address,
                  packet.port,
                ),
              )
            }
          } catch (e: SocketTimeoutException) {
            // استقصاء دوري بلا انسداد.
          } catch (_: Exception) {
            if (running.get()) {
              Thread.sleep(200)
            }
          }
        }
      }
      thread.isDaemon = true
      thread.name = "lan-discovery"
      thread.start()
    } catch (_: Exception) {
      // المنفذ محجوز من نقطة بيع أخرى على نفس الجهاز — استمر بلا
      // استكشاف (الاتصال اليدوي بالعنوان يبقى متاحاً).
    }
  }

  private fun emitEvent(name: String, params: com.facebook.react.bridge.WritableMap) {
    try {
      reactApplicationContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(name, params)
    } catch (_: Exception) {
      // JS غير جاهز (تمهيد الإقلاع) — الطلب سينتهي مهلته عند العميل.
    }
  }
}
