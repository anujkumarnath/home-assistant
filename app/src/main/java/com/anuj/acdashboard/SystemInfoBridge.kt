package com.anuj.acdashboard

import android.app.ActivityManager
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import android.webkit.JavascriptInterface
import org.json.JSONObject
import java.net.Inet4Address
import java.net.NetworkInterface

/**
 * On-device telemetry for the HUD screensaver: none of this depends on Home Assistant
 * or the network being reachable, so the dashboard still reads "SYSTEM ONLINE" info
 * even mid-outage.
 */
class SystemInfoBridge(private val context: Context) {

    @JavascriptInterface
    fun getSystemInfo(): String {
        val out = JSONObject()

        out.put("localIp", localIp())

        val wifiManager = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        val wifiInfo = wifiManager?.connectionInfo
        if (wifiInfo != null) {
            out.put("wifiRssi", wifiInfo.rssi)
            out.put("wifiLinkSpeedMbps", wifiInfo.linkSpeed)
            var ssid = wifiInfo.ssid ?: ""
            if (ssid.startsWith("\"") && ssid.endsWith("\"")) ssid = ssid.substring(1, ssid.length - 1)
            out.put("ssid", ssid)
        }

        out.put("isOnline", isOnline())

        val am = context.applicationContext.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val memInfo = ActivityManager.MemoryInfo()
        am.getMemoryInfo(memInfo)
        out.put("memTotalBytes", memInfo.totalMem)
        out.put("memAvailBytes", memInfo.availMem)

        out.put("thermalStatus", thermalStatus())
        out.put("uptimeSeconds", SystemClock.elapsedRealtime() / 1000)

        return out.toString()
    }

    private fun localIp(): String {
        try {
            val interfaces = NetworkInterface.getNetworkInterfaces() ?: return ""
            for (iface in interfaces) {
                if (!iface.isUp || iface.isLoopback) continue
                for (addr in iface.inetAddresses) {
                    if (addr is Inet4Address && !addr.isLoopbackAddress) {
                        return addr.hostAddress ?: ""
                    }
                }
            }
        } catch (e: Exception) {
            // fall through
        }
        return ""
    }

    private fun isOnline(): Boolean {
        val cm = context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val network = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(network) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }

    // System-wide /proc/loadavg is SELinux-blocked for regular apps on this device (shell
    // can read it, our app's untrusted_app domain can't) — a real platform restriction,
    // not a bug. Thermal status is the closest equivalent "device health" signal a normal
    // app can actually read.
    private fun thermalStatus(): String? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
        val pm = context.applicationContext.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return null
        return when (pm.currentThermalStatus) {
            PowerManager.THERMAL_STATUS_NONE -> "NOMINAL"
            PowerManager.THERMAL_STATUS_LIGHT -> "LIGHT"
            PowerManager.THERMAL_STATUS_MODERATE -> "MODERATE"
            PowerManager.THERMAL_STATUS_SEVERE -> "SEVERE"
            PowerManager.THERMAL_STATUS_CRITICAL -> "CRITICAL"
            PowerManager.THERMAL_STATUS_EMERGENCY -> "EMERGENCY"
            PowerManager.THERMAL_STATUS_SHUTDOWN -> "SHUTDOWN"
            else -> "NOMINAL"
        }
    }
}
