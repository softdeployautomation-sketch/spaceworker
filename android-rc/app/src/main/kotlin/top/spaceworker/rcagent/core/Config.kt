package top.spaceworker.rcagent.core

import android.content.Context
import top.spaceworker.rcagent.BuildConfig
import top.spaceworker.rcagent.RcApplication

object Config {
    const val TAG = "RC"
    const val PKG = "top.spaceworker.rcagent"
    const val SVC = "$PKG/$PKG.input.RcAccessibilityService"
    const val SVC_SHORT = "$PKG/.input.RcAccessibilityService"
    const val WAKE_ACTION = "$PKG.WAKE"
    const val HEARTBEAT_MS = 120_000L
    const val MQTT_KEEPALIVE_S = 60
    const val KEYFRAME_WATCHDOG_MS = 2_500L
    const val KEYFRAME_DEADLINE_MS = 500L
    const val ENCODER_RESTART_COOLDOWN_MS = 5_000L
    const val WAKE_PUSH_MS = 15_000L
    const val SESSION_WAKE_MS = 30 * 60_000L
    const val KICK_FRAME_MS = 500L
    const val SHOT_MS = 350L
    const val CONGESTION_TICK_MS = 250L
    const val GESTURE_FLUSH_MS = 40L
    const val MIN_BITRATE = 300_000
    const val MAX_BITRATE = 2_500_000
    const val WAN_MAX_BITRATE = 1_500_000
    const val MAX_ENCODE_W = 720
    const val WAN_ENCODE_W = 720
    const val WAN_JPEG_W = 480
    const val WAN_JPEG_Q = 42
    const val LAN_JPEG_Q = 70
    const val WAN_JPEG_GAP_MS = 160L
    const val LAN_JPEG_GAP_MS = 80L
    const val DEFAULT_FPS = 20
    const val WAN_FPS = 15
    const val I_FRAME_SEC = 2
    const val WAN_I_FRAME_SEC = 4
    const val MQTT_PORT = 1883
    const val MQTT_TLS_PORT = 8883
    const val RELAY_PORT = 3001

    val mqttBroker: String get() = BackendPrefs.mqttBroker(RcApplication.app)
    val wsBase: String get() = BackendPrefs.wsBase(RcApplication.app)
    val allowCleartext: Boolean get() = BuildConfig.ALLOW_CLEARTEXT
    val agentVer: String get() = BuildConfig.VERSION_NAME
    val wan: Boolean get() = runCatching { Wan.isPublicHost(BackendPrefs.host(RcApplication.app)) }.getOrDefault(false)
    val maxEncodeW: Int get() = if (wan) WAN_ENCODE_W else MAX_ENCODE_W
    val maxBitrate: Int get() = if (wan) WAN_MAX_BITRATE else MAX_BITRATE
    val encodeFps: Int get() = if (wan) WAN_FPS else DEFAULT_FPS
    val iFrameSec: Int get() = if (wan) WAN_I_FRAME_SEC else I_FRAME_SEC
    val congestionTickMs: Long get() = if (wan) 1_000L else CONGESTION_TICK_MS

    fun isCleartextUri(uri: String): Boolean {
        val s = uri.trim().lowercase()
        return s.startsWith("http://") || s.startsWith("tcp://") || s.startsWith("ws://")
    }

    fun permitsUri(uri: String): Boolean = allowCleartext || !isCleartextUri(uri)
}

object Wan {
    fun isPublicHost(host: String): Boolean {
        val h = host.trim().lowercase().substringBefore("%")
        if (h.isEmpty() || h == "localhost" || h == "127.0.0.1" || h == "::1") return false
        if (h.endsWith(".local")) return false
        if (h.startsWith("192.168.") || h.startsWith("10.")) return false
        if (h.startsWith("172.")) {
            val second = h.substringAfter(".").substringBefore(".").toIntOrNull() ?: return true
            if (second in 16..31) return false
        }
        return true
    }
}

object BackendPrefs {
    private const val PREFS = "rc"
    private const val KEY_HOST = "backend_host"
    private const val KEY_MQTT = "mqtt_broker"
    private const val KEY_TLS = "backend_tls"
    private const val KEY_MQTT_PASS = "mqtt_password"
    private const val KEY_DEVICE_ID = "device_id"
    private const val KEY_RELAY_PORT = "relay_port"
    private const val KEY_MEDIA_PROJECTION = "media_projection"

    fun parseHost(raw: String): String? {
        val rest = raw.trim().substringAfter("://", raw.trim()).substringBefore("/").substringBefore("?")
        val host = rest.substringBefore(":").trim()
        if (host.isEmpty() || host.any { it.isWhitespace() }) return null
        return host
    }

    fun isTlsUrl(raw: String): Boolean {
        val s = raw.trim()
        return s.startsWith("https://") || s.startsWith("wss://")
    }

    fun parseMqtt(raw: String): String? {
        val s = raw.trim()
        if (s.isEmpty()) return null
        val scheme = if (
            s.startsWith("ssl://") || s.startsWith("tls://") || s.startsWith("mqtts://")
        ) "ssl" else "tcp"
        val rest = s.substringAfter("://", s).substringBefore("/").substringBefore("?")
        val host = rest.substringBefore(":").trim()
        if (host.isEmpty() || host.any { it.isWhitespace() }) return null
        val portRaw = rest.substringAfter(":", "")
        val defaultPort = if (scheme == "ssl") Config.MQTT_TLS_PORT else Config.MQTT_PORT
        val port = if (portRaw.isEmpty()) defaultPort else portRaw.toIntOrNull() ?: return null
        if (port !in 1..65535) return null
        return "$scheme://$host:$port"
    }

    fun defaultHost(): String = parseHost(BuildConfig.MQTT_BROKER) ?: parseHost(BuildConfig.WS_BASE) ?: "127.0.0.1"

    fun host(ctx: Context): String {
        val saved = ctx.getSharedPreferences(PREFS, 0).getString(KEY_HOST, null)
        return saved?.takeIf { it.isNotBlank() } ?: defaultHost()
    }

    fun savedDeviceId(ctx: Context): String =
        ctx.getSharedPreferences(PREFS, 0).getString(KEY_DEVICE_ID, null).orEmpty()

    fun saveDeviceId(ctx: Context, raw: String): String? {
        val id = raw.trim()
        if (id.isEmpty()) return null
        ctx.getSharedPreferences(PREFS, 0).edit().putString(KEY_DEVICE_ID, id).apply()
        return id
    }

    fun clearDeviceId(ctx: Context) {
        ctx.getSharedPreferences(PREFS, 0).edit().remove(KEY_DEVICE_ID).apply()
    }

    fun parseRelayPort(raw: String): Int? {
        val n = raw.trim().toIntOrNull() ?: return null
        return n.takeIf { it in 1..65535 }
    }

    fun saveRelayPort(ctx: Context, raw: String): Int? {
        val n = parseRelayPort(raw) ?: return null
        ctx.getSharedPreferences(PREFS, 0).edit().putInt(KEY_RELAY_PORT, n).apply()
        return n
    }

    fun clearRelayPort(ctx: Context) {
        ctx.getSharedPreferences(PREFS, 0).edit().remove(KEY_RELAY_PORT).apply()
    }

    fun displayRelayPort(ctx: Context): String = relayPort(ctx)?.toString().orEmpty()

    fun relayPort(ctx: Context): Int? {
        val p = ctx.getSharedPreferences(PREFS, 0)
        if (!p.contains(KEY_RELAY_PORT)) return null
        return p.getInt(KEY_RELAY_PORT, 0).takeIf { it in 1..65535 }
    }

    /** MediaProjection/H.264 is opt-in: default capture is Accessibility takeScreenshot (no prompt). */
    fun mediaProjectionEnabled(ctx: Context): Boolean =
        ctx.getSharedPreferences(PREFS, 0).getBoolean(KEY_MEDIA_PROJECTION, false)

    fun saveMediaProjection(ctx: Context, enabled: Boolean) {
        ctx.getSharedPreferences(PREFS, 0).edit().putBoolean(KEY_MEDIA_PROJECTION, enabled).apply()
    }

    fun tls(ctx: Context): Boolean {
        val p = ctx.getSharedPreferences(PREFS, 0)
        if (p.contains(KEY_TLS)) return p.getBoolean(KEY_TLS, false)
        return isTlsUrl(BuildConfig.WS_BASE) || BuildConfig.MQTT_BROKER.startsWith("ssl://")
    }

    fun displayBackend(ctx: Context): String {
        val h = host(ctx)
        return if (tls(ctx)) "https://$h" else h
    }

    fun saveHost(ctx: Context, raw: String): String? {
        val h = parseHost(raw) ?: return null
        ctx.getSharedPreferences(PREFS, 0).edit()
            .putString(KEY_HOST, h)
            .putBoolean(KEY_TLS, isTlsUrl(raw))
            .apply()
        return if (isTlsUrl(raw)) "https://$h" else h
    }

    fun mqttBroker(ctx: Context): String {
        val saved = ctx.getSharedPreferences(PREFS, 0).getString(KEY_MQTT, null)
        if (!saved.isNullOrBlank()) return saved
        return BuildConfig.MQTT_BROKER
    }

    /** Blank MQTT field clears override and follows backend host + default port. */
    fun saveMqtt(ctx: Context, raw: String): String? {
        val ed = ctx.getSharedPreferences(PREFS, 0).edit()
        if (raw.isBlank()) {
            ed.remove(KEY_MQTT).apply()
            return mqttBroker(ctx)
        }
        val uri = parseMqtt(raw) ?: return null
        ed.putString(KEY_MQTT, uri).apply()
        return uri
    }

    /** Không có mật khẩu mặc định trong source: MDM hoặc build property phải cấp. */
    fun mqttPassword(ctx: Context): String =
        ctx.getSharedPreferences(PREFS, 0).getString(KEY_MQTT_PASS, null)
            ?.takeIf { it.isNotEmpty() }
            ?: BuildConfig.MQTT_PASSWORD

    fun saveMqttPassword(ctx: Context, raw: String) {
        ctx.getSharedPreferences(PREFS, 0).edit().putString(KEY_MQTT_PASS, raw).apply()
    }

    fun wsBase(ctx: Context): String {
        val h = host(ctx)
        val p = relayPort(ctx)
        return if (tls(ctx)) {
            if (p == null || p == 443) "wss://$h" else "wss://$h:$p"
        } else {
            "ws://$h:${p ?: Config.RELAY_PORT}"
        }
    }
}
