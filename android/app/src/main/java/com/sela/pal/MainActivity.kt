package com.sela.pal

import android.content.Context
import android.content.res.Configuration
import android.os.Bundle
import java.util.Locale
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

    /**
     * Returns the name of the main component registered from JavaScript. This is used to schedule
     * rendering of the component.
     */
    override fun getMainComponentName(): String = "Sela"

    /**
     * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
     * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
     */
    override fun createReactActivityDelegate(): ReactActivityDelegate =
        DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

    /**
     * سيلا is an Arabic-first POS. The JS side calls I18nManager.forceRTL, but
     * that only applies after a process restart and is fragile on some OEM
     * builds — merchants saw stock alerts laid out LEFT-to-right with content
     * cut off at the left edge. Forcing the Arabic locale + RTL layout
     * direction at the Activity level makes every screen, every horizontal
     * list and every system notification we build render right-to-left on
     * ANY device locale (Hebrew/English devices included), from the very
     * first frame.
     */
    override fun attachBaseContext(newBase: Context) {
        val locale = Locale("ar")
        Locale.setDefault(locale)
        val config = Configuration(newBase.resources.configuration)
        config.setLocale(locale)
        config.setLayoutDirection(locale)
        super.attachBaseContext(newBase.createConfigurationContext(config))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        // SelaSplash theme is set in AndroidManifest — keep it on the window until
        // React paints the first frame, then let the default theme take over.
        setTheme(R.style.AppTheme)
        super.onCreate(savedInstanceState)
    }
}
