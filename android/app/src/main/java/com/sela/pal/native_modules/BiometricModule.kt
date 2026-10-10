package com.sela.pal.native_modules

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * BiometricModule — v13 (round-19 #2) app-lock fingerprint gate.
 * ─────────────────────────────────────────────────────────────────
 * Wraps androidx.biometric BiometricPrompt for the JS app-lock:
 *
 *   availability() → "available" | "none_enrolled" | "unavailable"
 *   authenticate(title, subtitle, cancelText) → true | false
 *
 * Notes:
 *  - RN 0.74's ReactActivity extends AppCompatActivity extends
 *    FragmentActivity, so BiometricPrompt plugs straight into
 *    MainActivity — no activity changes needed.
 *  - Errors (user cancel / lockout / too many attempts) resolve
 *    `false` instead of rejecting — the JS side falls back to the
 *    PIN pad, and "unavailable" is handled before ever calling.
 *  - BiometricPrompt must run on the UI thread; @ReactMethod with a
 *    Promise runs on a background module thread, so the prompt is
 *    dispatched via runOnUiThread.
 *  - A single in-flight prompt is enforced — a second call while one
 *    is showing quietly resolves false (no stacked dialogs).
 */
class BiometricModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  companion object {
    const val NAME = "SelaBiometric"
  }

  @Volatile
  private var promptActive = false

  override fun getName(): String = NAME

  @ReactMethod
  fun availability(promise: Promise) {
    try {
      val manager = BiometricManager.from(reactApplicationContext)
      val code =
        manager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_WEAK)
      val status = when (code) {
        BiometricManager.BIOMETRIC_SUCCESS -> "available"
        BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> "none_enrolled"
        else -> "unavailable"
      }
      promise.resolve(status)
    } catch (e: Exception) {
      promise.resolve("unavailable")
    }
  }

  @ReactMethod
  fun authenticate(
    title: String,
    subtitle: String,
    cancelText: String,
    promise: Promise
  ) {
    val activity = currentActivity
    if (activity == null || activity !is FragmentActivity || activity.isFinishing) {
      promise.resolve(false)
      return
    }
    if (promptActive) {
      promise.resolve(false)
      return
    }
    activity.runOnUiThread {
      if (promptActive) {
        promise.resolve(false)
        return@runOnUiThread
      }
      try {
        val manager = BiometricManager.from(reactApplicationContext)
        val canAuth =
          manager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_WEAK)
        if (canAuth != BiometricManager.BIOMETRIC_SUCCESS) {
          promise.resolve(false)
          return@runOnUiThread
        }
        promptActive = true
        val callback = object : BiometricPrompt.AuthenticationCallback() {
          override fun onAuthenticationSucceeded(
            result: BiometricPrompt.AuthenticationResult
          ) {
            promptActive = false
            promise.resolve(true)
          }

          override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
            // User cancel / lockout / no space — anything recoverable
            // means "not now" → the PIN pad stays available.
            promptActive = false
            promise.resolve(false)
          }
        }
        val prompt = BiometricPrompt(
          activity,
          ContextCompat.getMainExecutor(activity),
          callback
        )
        val info = BiometricPrompt.PromptInfo.Builder()
          .setTitle(title)
          .setSubtitle(subtitle)
          .setNegativeButtonText(cancelText)
          .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_WEAK)
          .setConfirmationRequired(false)
          .build()
        prompt.authenticate(info)
      } catch (e: Exception) {
        promptActive = false
        promise.resolve(false)
      }
    }
  }
}
