package com.anuj.acdashboard

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.WebSettings
import android.webkit.WebView

class MainActivity : Activity() {

    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        hideSystemUi()
        requestLocationPermissionForSsid()

        webView = WebView(this)
        setContentView(webView)

        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.cacheMode = WebSettings.LOAD_NO_CACHE
        settings.mediaPlaybackRequiresUserGesture = false

        webView.addJavascriptInterface(HaBridge(this, webView), "AndroidBridge")
        webView.addJavascriptInterface(SystemInfoBridge(this), "SystemInfo")
        webView.isFocusable = true
        webView.isFocusableInTouchMode = true
        webView.requestFocus()

        webView.loadUrl("file:///android_asset/index.html")
    }

    // A focused <input> in this WebView build inconsistently swallows DPAD_UP/DOWN for
    // native caret movement instead of dispatching a DOM keydown event. Intercepting here
    // and driving navigation straight from JS sidesteps that entirely.
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val dir = when (event.keyCode) {
            KeyEvent.KEYCODE_DPAD_UP -> "up"
            KeyEvent.KEYCODE_DPAD_DOWN -> "down"
            else -> null
        }
        if (dir != null) {
            if (event.action == KeyEvent.ACTION_DOWN) {
                webView.evaluateJavascript("window.__nativeNav && window.__nativeNav('$dir')", null)
            }
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemUi()
    }

    // Android masks the real WiFi SSID from WifiManager unless the app holds location
    // permission (SSID is treated as coarse location data). One-time system prompt; the
    // user's choice persists until they revoke it or reinstall the app.
    private fun requestLocationPermissionForSsid() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION), 1)
        }
    }

    private fun hideSystemUi() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            )
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}
