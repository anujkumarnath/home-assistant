package com.anuj.acdashboard

import android.content.Context
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Bridges the WebView UI to the Home Assistant REST API over plain HttpURLConnection.
 * Doing the HTTP calls natively (instead of fetch() inside the page) sidesteps browser
 * CORS entirely, so nothing needs to change in Home Assistant's own configuration.
 */
class HaBridge(private val context: Context, private val webView: WebView) {

    init {
        // Global disable of HttpURLConnection's keep-alive pool. A per-request
        // "Connection: close" header wasn't enough to stop reuse of a wedged pooled
        // socket on this device; this system property is the actual documented switch.
        System.setProperty("http.keepAlive", "false")
    }


    private val executor = Executors.newCachedThreadPool()
    private val prefs = context.getSharedPreferences("ha_settings", Context.MODE_PRIVATE)

    companion object {
        // Defaults mirror config/ui-lovelace.yaml's ac-cycle-flow-card so first run needs
        // only a base URL + token.
        val DEFAULT_ENTITIES: Map<String, String> = mapOf(
            "phaseEntity" to "input_select.ac_cycle_phase",
            "awayEntity" to "input_boolean.ac_away_mode",
            "autoCycleEntity" to "input_boolean.auto_cycle_enabled",
            "maxRuntimeEntity" to "input_number.max_runtime_minutes",
            "plug1Switch" to "switch.ac_plug_1_socket_1",
            "plug2Switch" to "switch.ac_plug_2_socket_1",
            "plug1Timer" to "timer.plug_1_runtime",
            "plug2Timer" to "timer.plug_2_runtime",
            "plug1PowerEntity" to "sensor.ac_plug_1_power",
            "plug2PowerEntity" to "sensor.ac_plug_2_power",
            "plug1CurrentEntity" to "sensor.ac_plug_1_current",
            "plug2CurrentEntity" to "sensor.ac_plug_2_current",
            "plug1MonthlyEnergyEntity" to "sensor.plug_1_monthly_energy",
            "plug2MonthlyEnergyEntity" to "sensor.plug_2_monthly_energy",
            "plug1ParticipateEntity" to "input_boolean.plug1_participate",
            "plug2ParticipateEntity" to "input_boolean.plug2_participate",
            "plug1UseUnusedCycleEntity" to "input_boolean.plug1_use_unused_cycle",
            "plug2UseUnusedCycleEntity" to "input_boolean.plug2_use_unused_cycle",
            "plug1Name" to "Anuj's AC",
            "plug2Name" to "Cinu's AC",
            "weatherEntity" to "weather.forecast_home"
        )
    }

    @JavascriptInterface
    fun getSettings(): String {
        val out = JSONObject()
        out.put("baseUrl", prefs.getString("baseUrl", "http://192.168.1.3:8123"))
        out.put("token", prefs.getString("token", ""))
        val entities = JSONObject()
        for ((key, default) in DEFAULT_ENTITIES) {
            entities.put(key, prefs.getString("entity_$key", default))
        }
        out.put("entities", entities)
        return out.toString()
    }

    @JavascriptInterface
    fun saveSettings(json: String) {
        val obj = JSONObject(json)
        val editor = prefs.edit()
        if (obj.has("baseUrl")) editor.putString("baseUrl", obj.getString("baseUrl").trimEnd('/'))
        if (obj.has("token")) editor.putString("token", obj.getString("token"))
        if (obj.has("entities")) {
            val entities = obj.getJSONObject("entities")
            for (key in DEFAULT_ENTITIES.keys) {
                if (entities.has(key)) editor.putString("entity_$key", entities.getString(key))
            }
        }
        editor.apply()
    }

    @JavascriptInterface
    fun fetchStates(reqId: String, entityIdsJson: String) {
        executor.execute {
            val result = JSONObject()
            try {
                val ids = org.json.JSONArray(entityIdsJson)
                val baseUrl = prefs.getString("baseUrl", "") ?: ""
                val token = prefs.getString("token", "") ?: ""
                // A single bulk /api/states request per poll turned out worse in practice:
                // this network path has a periodic multi-second stall (narrowed to the LAN
                // path itself — direct calls from the HA host never see it), and one request
                // per poll can fall into lockstep with that period. Many small, fast,
                // independently-timed requests average out far better.
                for (i in 0 until ids.length()) {
                    val entityId = ids.getString(i)
                    if (entityId.isBlank()) continue
                    try {
                        result.put(entityId, getState(baseUrl, token, entityId))
                    } catch (e: Exception) {
                        Log.e("HaBridge", "fetch failed for $entityId: ${e.javaClass.simpleName}: ${e.message}")
                        result.put(entityId, JSONObject().put("error", e.message ?: "error"))
                    }
                }
                result.put("_ok", true)
            } catch (e: Exception) {
                Log.e("HaBridge", "fetchStates failed: ${e.javaClass.simpleName}: ${e.message}")
                result.put("_ok", false)
                result.put("_error", e.message ?: "error")
            }
            postResult(reqId, result.toString())
        }
    }

    @JavascriptInterface
    fun callService(reqId: String, domain: String, service: String, entityId: String, extraJson: String) {
        executor.execute {
            val result = JSONObject()
            try {
                val baseUrl = prefs.getString("baseUrl", "") ?: ""
                val token = prefs.getString("token", "") ?: ""
                val body = JSONObject(extraJson)
                if (entityId.isNotBlank()) body.put("entity_id", entityId)
                postJson(baseUrl, token, "/api/services/$domain/$service", body)
                result.put("_ok", true)
            } catch (e: Exception) {
                result.put("_ok", false)
                result.put("_error", e.message ?: "error")
            }
            postResult(reqId, result.toString())
        }
    }

    // The connect (not read) phase intermittently stalls for several seconds on this
    // network path — narrowed down to the Fire TV's own WiFi (direct calls to the same
    // HA instance from its host machine never stall), not connection-pool reuse (disabling
    // keep-alive entirely made no difference) and not Home Assistant itself. A few short
    // attempts recover far more reliably than one long one.
    private fun <T> withRetry(attempts: Int = 3, body: () -> T): T {
        var lastError: Exception? = null
        repeat(attempts) { attempt ->
            try {
                return body()
            } catch (e: java.io.IOException) {
                lastError = e
                // Random jitter so retries don't stay locked in step with whatever
                // periodic stall caused the failure in the first place.
                if (attempt < attempts - 1) Thread.sleep((50..250).random().toLong())
            }
        }
        throw lastError!!
    }

    private fun getState(baseUrl: String, token: String, entityId: String): JSONObject = withRetry {
        val url = URL("$baseUrl/api/states/$entityId")
        val conn = url.openConnection() as HttpURLConnection
        conn.requestMethod = "GET"
        conn.setRequestProperty("Authorization", "Bearer $token")
        conn.connectTimeout = 2500
        conn.readTimeout = 2500
        try {
            val code = conn.responseCode
            if (code != 200) throw RuntimeException("HTTP $code")
            val text = BufferedReader(InputStreamReader(conn.inputStream)).use { it.readText() }
            JSONObject(text)
        } finally {
            conn.disconnect()
        }
    }

    private fun postJson(baseUrl: String, token: String, path: String, body: JSONObject) = withRetry {
        val url = URL("$baseUrl$path")
        val conn = url.openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.setRequestProperty("Authorization", "Bearer $token")
        conn.setRequestProperty("Content-Type", "application/json")
        conn.connectTimeout = 2500
        conn.readTimeout = 2500
        conn.doOutput = true
        try {
            OutputStreamWriter(conn.outputStream).use { it.write(body.toString()) }
            val code = conn.responseCode
            if (code !in 200..299) throw RuntimeException("HTTP $code")
            conn.inputStream.close()
        } finally {
            conn.disconnect()
        }
    }

    private fun postResult(reqId: String, json: String) {
        webView.post {
            val js = "window.onBridgeResult && window.onBridgeResult(${JSONObject.quote(reqId)}, ${JSONObject.quote(json)});"
            webView.evaluateJavascript(js, null)
        }
    }
}
