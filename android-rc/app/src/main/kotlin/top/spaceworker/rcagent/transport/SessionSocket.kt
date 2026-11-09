package top.spaceworker.rcagent.transport

import android.util.Log
import top.spaceworker.rcagent.capture.Encoder
import top.spaceworker.rcagent.capture.FrameSink
import top.spaceworker.rcagent.core.Config
import top.spaceworker.rcagent.core.SessionBus
import top.spaceworker.rcagent.core.SessionDiag
import org.json.JSONObject
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.net.URLEncoder
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class SessionSocket(
    private val wsUrl: String,
    private val token: String,
    private val onText: (String) -> Unit,
) : FrameSink {
    private var ws: WebSocket? = null
    var codecConfigProvider: () -> ByteArray? = { null }
    var onOpen: (() -> Unit)? = null
    private val dropDelta = AtomicBoolean(false)
    private val firstKey = AtomicBoolean(true)
    private val closing = AtomicBoolean(false)
    private val lock = Any()
    @Volatile private var open = false
    private var pendingKey: ByteArray? = null
    private var pendingJpeg: ByteArray? = null
    private val pendingText = ArrayDeque<String>(24)

    fun connect() {
        if (!Config.permitsUri(wsUrl)) {
            Log.e(Config.TAG, "cleartext ws blocked $wsUrl")
            SessionBus.stop("wss required")
            return
        }
        val sep = if (wsUrl.contains('?')) "&" else "?"
        val url = "$wsUrl${sep}token=${URLEncoder.encode(token, "UTF-8")}"
        val req = Request.Builder().url(url).build()
        ws = http.newWebSocket(req, listener)
        firstKey.set(true)
        Log.i(Config.TAG, "ws connect $wsUrl")
    }

    fun sendText(s: String) {
        synchronized(lock) {
            if (!open) {
                while (pendingText.size >= 24) pendingText.removeFirst()
                pendingText.addLast(s)
                return
            }
        }
        ws?.send(s)
    }

    fun queueBytes(): Long = ws?.queueSize() ?: 0

    fun tickCongestion(
        br: Int,
        setBr: (Int) -> Unit,
        requestKf: () -> Unit,
        setBacklog: (Boolean) -> Unit,
    ) {
        val q = ws?.queueSize() ?: 0
        setBacklog(q > 64 * 1024)
        val d = Congestion.tick(q, br, Config.wan)
        if (d.bitrate != br) setBr(d.bitrate)
        if (d.dropDelta) dropDelta.set(true)
        if (d.requestKeyframe) requestKf()
    }

    fun tickCongestion(enc: Encoder) {
        tickCongestion(enc.bitrate, enc::setBitrate, enc::requestKeyframe) { enc.backlogged = it }
    }

    override fun onEncoded(type: Byte, ptsUs: Long, payload: ByteArray) {
        if (type == Framing.TYPE_JPEG) {
            val packed = Framing.pack(type, ptsUs, payload)
            synchronized(lock) {
                if (!open) {
                    pendingJpeg = packed
                    return
                }
            }
            if ((ws?.queueSize() ?: 0) > 96 * 1024) return
            ws?.send(ByteString.of(*packed))
            return
        }
        // 0x01 is flushed once on open; later config resets gotKey on current rc-web.
        if (type == Framing.TYPE_CONFIG) return
        if (type == Framing.TYPE_DELTA && dropDelta.get()) return
        if (type == Framing.TYPE_KEY) dropDelta.set(false)
        val packed = packH264(type, ptsUs, payload)
        synchronized(lock) {
            if (!open) {
                if (type == Framing.TYPE_KEY) pendingKey = packed
                return
            }
        }
        ws?.send(ByteString.of(*packed))
        if (type == Framing.TYPE_KEY && firstKey.compareAndSet(true, false)) {
            SessionDiag.emit("key.sent", JSONObject().put("n", packed.size))
        }
    }

    private fun packH264(type: Byte, ptsUs: Long, payload: ByteArray): ByteArray {
        val body = if (type == Framing.TYPE_KEY && !Framing.startsWithSps(payload)) {
            val cfg = codecConfigProvider()
            if (cfg != null && cfg.size > 9) cfg.copyOfRange(9, cfg.size) + payload else payload
        } else payload
        return Framing.pack(type, ptsUs, body)
    }

    fun close() {
        if (!closing.compareAndSet(false, true)) return
        synchronized(lock) {
            open = false
            pendingKey = null
            pendingJpeg = null
            pendingText.clear()
        }
        ws?.close(1000, "teardown")
        ws = null
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            if (closing.get()) return
            val held: ByteArray?
            val jpeg: ByteArray?
            val texts: List<String>
            synchronized(lock) {
                open = true
                held = pendingKey
                jpeg = pendingJpeg
                texts = pendingText.toList()
                pendingKey = null
                pendingJpeg = null
                pendingText.clear()
                // P-frames encoded during handshake depend on dropped NALs.
                dropDelta.set(true)
            }
            Log.i(Config.TAG, "ws open")
            texts.forEach { webSocket.send(it) }
            if (held != null) {
                webSocket.send(ByteString.of(*held))
                firstKey.set(false)
                Log.i(Config.TAG, "ws flush key n=${held.size}")
                SessionDiag.emit("ws.open", JSONObject().put("key", true).put("n", held.size))
            } else {
                codecConfigProvider()?.let { webSocket.send(ByteString.of(*it)) }
                SessionDiag.emit("ws.open", JSONObject().put("key", false).put("n", 0))
            }
            jpeg?.let { webSocket.send(ByteString.of(*it)) }
            onOpen?.invoke()
            SessionDiag.flush()
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            onText(text)
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            val t = bytes.utf8()
            if (t.startsWith("{")) onText(t)
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, reason)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            open = false
            Log.i(Config.TAG, "ws closed $code $reason")
            SessionDiag.emit("ws.closed", JSONObject().put("code", code).put("why", reason))
            if (!closing.get()) SessionBus.stop("ws_closed")
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            open = false
            Log.w(Config.TAG, "ws fail ${t.message}")
            SessionDiag.emit("ws.fail", JSONObject().put("why", t.message ?: "fail"))
            if (!closing.get()) SessionBus.stop("ws_fail")
        }
    }

    companion object {
        private val http = OkHttpClient.Builder()
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(20, TimeUnit.SECONDS)
            .build()
    }
}
