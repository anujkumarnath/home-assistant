package com.anuj.acdashboard

import android.annotation.SuppressLint
import android.service.dreams.DreamService
import android.webkit.WebSettings
import android.webkit.WebView

/**
 * The system screensaver (DreamService) implementation. Loads the exact same page
 * MainActivity shows — the app's only screen doubles as the screensaver, so there's
 * nothing dream-specific here.
 */
class ScreensaverDreamService : DreamService() {

    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onAttachedToWindow() {
        super.onAttachedToWindow()

        // false = any touch/key input ends the dream automatically (standard screensaver behavior)
        isInteractive = false
        isFullscreen = true

        webView = WebView(this)
        setContentView(webView)

        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.cacheMode = WebSettings.LOAD_NO_CACHE

        webView.addJavascriptInterface(HaBridge(this, webView), "AndroidBridge")
        webView.addJavascriptInterface(SystemInfoBridge(this), "SystemInfo")
        webView.loadUrl("file:///android_asset/index.html")
    }

    override fun onDetachedFromWindow() {
        webView.destroy()
        super.onDetachedFromWindow()
    }
}
