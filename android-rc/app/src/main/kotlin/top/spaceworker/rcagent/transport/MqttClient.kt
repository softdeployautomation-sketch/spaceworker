package top.spaceworker.rcagent.transport

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import top.spaceworker.rcagent.RcApplication
import top.spaceworker.rcagent.boot.SelfHeal
import top.spaceworker.rcagent.core.AgentState
import top.spaceworker.rcagent.core.Capabilities
import top.spaceworker.rcagent.core.CapsSync
import top.spaceworker.rcagent.core.BackendPrefs
import top.spaceworker.rcagent.core.capsJson
import top.spaceworker.rcagent.core.Config
import top.spaceworker.rcagent.core.FaultLog
import top.spaceworker.rcagent.core.SessionBus
import top.spaceworker.rcagent.core.SessionRequest
import top.spaceworker.rcagent.core.androidId
import top.spaceworker.rcagent.core.deviceId
import top.spaceworker.rcagent.capture.MaintenanceOverlayService
import top.spaceworker.rcagent.core.volatileOf
import org.eclipse.paho.mqttv5.client.IMqttToken
import org.eclipse.paho.mqttv5.client.MqttActionListener
import org.eclipse.paho.mqttv5.client.MqttAsyncClient
import org.eclipse.paho.mqttv5.client.MqttCallback
import org.eclipse.paho.mqttv5.client.MqttConnectionOptions
import org.eclipse.paho.mqttv5.client.MqttDisconnectResponse
import org.eclipse.paho.mqttv5.client.persist.MemoryPersistence
import org.eclipse.paho.mqttv5.common.MqttException
import org.eclipse.paho.mqttv5.common.MqttMessage
import org.eclipse.paho.mqttv5.common.packet.MqttProperties
import org.json.JSONObject
import java.nio.charset.StandardCharsets

object MqttClient : MqttCallback {
    private val handler = Handler(Looper.getMainLooper())
    private var client: MqttAsyncClient? = null
    private var appCtx: Context? = null
    private var attempt = 0
    private var settleTries = 0
    private var replacing = false
    private var lastCapsFp: String? = null
    private val heartbeat = object : Runnable {
        override fun run() {
            publishHeartbeat()
            handler.postDelayed(this, Config.HEARTBEAT_MS)
        }
    }
    private val settleState = object : Runnable {
        override fun run() {
            val ctx = appCtx ?: return
            if (CapsSync.waitForA11y(Capabilities.a11yListed(ctx), Capabilities.a11yBound(), settleTries)) {
                settleTries++
                handler.postDelayed(this, CapsSync.WAIT_MS)
                return
            }
            publishState(retained = true)
        }
    }

    @Volatile var lastError: String? = null
        private set

    @Volatile var connected: Boolean = false
        private set

    fun start(ctx: Context) {
        appCtx = ctx.applicationContext
        connect()
    }

    fun connectNow() {
        handler.removeCallbacks(heartbeat)
        handler.removeCallbacks(settleState)
        attempt = 0
        connect()
    }

    private fun connect() {
        val ctx = appCtx ?: RcApplication.app
        val id = deviceId(ctx)
        val broker = Config.mqttBroker
        if (!Config.permitsUri(broker)) {
            lastError = "cleartext mqtt blocked"
            Log.e(Config.TAG, lastError!!)
            return
        }
        if (!Config.allowCleartext && BackendPrefs.mqttPassword(ctx).isBlank()) {
            lastError = "mqtt password required"
            Log.e(Config.TAG, lastError!!)
            return
        }
        replacing = true
        handler.removeCallbacks(heartbeat)
        handler.removeCallbacks(settleState)
        runCatching { client?.disconnect() }
        runCatching { client?.close() }
        client = null
        connected = false
        val opts = MqttConnectionOptions().apply {
            isCleanStart = true
            keepAliveInterval = Config.MQTT_KEEPALIVE_S
            connectionTimeout = 10
            sessionExpiryInterval = 0
            userName = id
            val pass = BackendPrefs.mqttPassword(ctx)
            if (pass.isNotEmpty()) password = pass.toByteArray(StandardCharsets.UTF_8)
            if (broker.startsWith("ssl://") || broker.startsWith("tls://")) {
                socketFactory = javax.net.ssl.SSLContext.getDefault().socketFactory
            }
            setWill(
                "rc/state/$id",
                MqttMessage("""{"online":false,"ts":${System.currentTimeMillis()}}""".toByteArray())
                    .apply {
                        qos = 1
                        isRetained = true
                    },
            )
        }
        val c = MqttAsyncClient(broker, id, MemoryPersistence())
        c.setCallback(this)
        client = c
        Log.i(Config.TAG, "mqtt connect $id -> $broker")
        try {
            c.connect(opts, null, object : MqttActionListener {
                override fun onSuccess(asyncActionToken: IMqttToken?) {
                    if (client !== c) return
                    replacing = false
                    attempt = 0
                    connected = true
                    lastError = null
                    if (AgentState.phase == AgentState.Phase.RECONNECTING) {
                        AgentState.set(AgentState.Phase.IDLE)
                    }
                    runCatching { c.subscribe("rc/cmd/$id", 1) }
                    settleTries = 0
                    handler.removeCallbacks(settleState)
                    handler.post(settleState)
                    handler.removeCallbacks(heartbeat)
                    handler.postDelayed(heartbeat, Config.HEARTBEAT_MS)
                    Log.i(Config.TAG, "mqtt connected")
                }

                override fun onFailure(asyncActionToken: IMqttToken?, exception: Throwable?) {
                    if (client !== c) return
                    replacing = false
                    connected = false
                    lastError = exception?.message ?: "mqtt fail"
                    Log.w(Config.TAG, "mqtt fail: $lastError")
                    scheduleReconnect()
                }
            })
        } catch (t: Throwable) {
            replacing = false
            lastError = t.message ?: "mqtt connect throw"
            Log.w(Config.TAG, "mqtt connect throw: $lastError")
            scheduleReconnect()
        }
    }

    private fun scheduleReconnect() {
        attempt += 1
        if (AgentState.phase == AgentState.Phase.IDLE ||
            AgentState.phase == AgentState.Phase.RECONNECTING
        ) {
            AgentState.set(AgentState.Phase.RECONNECTING)
        }
        val delay = Reconnect.delayMs(attempt)
        Log.i(Config.TAG, "mqtt reconnect in ${delay}ms attempt=$attempt")
        handler.postDelayed({ connect() }, delay)
    }

    override fun disconnected(disconnectResponse: MqttDisconnectResponse?) {
        connected = false
        Log.w(Config.TAG, "mqtt disconnected ${disconnectResponse?.reasonString} rc=${disconnectResponse?.returnCode}")
        handler.removeCallbacks(heartbeat)
        if (replacing) return
        scheduleReconnect()
    }

    override fun mqttErrorOccurred(exception: MqttException?) {
        Log.w(Config.TAG, "mqtt error ${exception?.message}")
    }

    override fun messageArrived(topic: String?, message: MqttMessage?) {
        val payload = message?.payload?.toString(StandardCharsets.UTF_8) ?: return
        handler.post { CommandHandler.onCommand(appCtx ?: return@post, payload) }
    }

    override fun deliveryComplete(token: IMqttToken?) {}
    override fun connectComplete(reconnect: Boolean, serverURI: String?) {}
    override fun authPacketArrived(reasonCode: Int, properties: MqttProperties?) {}

    fun publishState(retained: Boolean) {
        val ctx = appCtx ?: return
        val id = deviceId(ctx)
        val caps = Capabilities.probe(ctx)
        lastCapsFp = CapsSync.fingerprint(caps, Config.agentVer)
        val body = JSONObject()
            .put("online", true)
            .put("agentVer", Config.agentVer)
            .put("androidId", androidId(ctx))
            .put("caps", capsJson(caps))
            .put("volatile", JSONObject(volatileOf(ctx)))
            .put("lastError", SessionBus.lastError ?: "")
            .put("step", FaultLog.stepLine())
            .put("fault", FaultLog.faultText().lineSequence().take(5).joinToString(" | ").take(400))
            .put("ts", System.currentTimeMillis())
        Log.i(Config.TAG, "state a11y=${caps.a11y} pm=${caps.projectMedia} overlay=${caps.overlay} knox=${caps.knox}")
        publish("rc/state/$id", body.toString(), retained, 1)
    }

    fun publishHeartbeat() {
        val ctx = appCtx ?: return
        val caps = Capabilities.probe(ctx)
        val fp = CapsSync.fingerprint(caps, Config.agentVer)
        if (fp != lastCapsFp) {
            publishState(retained = true)
            return
        }
        val id = deviceId(ctx)
        val body = JSONObject()
            .put("online", true)
            .put("volatile", JSONObject(volatileOf(ctx)))
            .put("ts", System.currentTimeMillis())
        publish("rc/state/$id", body.toString(), retained = false, qos = 0)
    }

    fun publishProbe(nonce: String?) {
        val ctx = appCtx ?: return
        val id = deviceId(ctx)
        val caps = Capabilities.probe(ctx)
        val body = JSONObject()
            .put("online", true)
            .put("agentVer", Config.agentVer)
            .put("androidId", androidId(ctx))
            .put("caps", capsJson(caps))
            .put("volatile", JSONObject(volatileOf(ctx)))
            .put("ts", System.currentTimeMillis())
        if (!nonce.isNullOrBlank()) body.put("nonce", nonce)
        publish("rc/probe/$id", body.toString(), retained = false, qos = 1)
    }

    fun publishEvent(code: String, msg: String) {
        val ctx = appCtx ?: return
        val id = deviceId(ctx)
        val body = JSONObject()
            .put("t", "event")
            .put("code", code)
            .put("msg", msg)
            .put("ts", System.currentTimeMillis())
        publish("rc/event/$id", body.toString(), retained = false, qos = 1)
    }

    private fun publish(topic: String, payload: String, retained: Boolean, qos: Int) {
        val c = client ?: return
        if (!c.isConnected) return
        runCatching {
            c.publish(topic, payload.toByteArray(), qos, retained)
            Log.i(Config.TAG, "pub $topic q$qos n=${payload.length}")
        }.onFailure { Log.w(Config.TAG, "pub $topic fail: ${it.message}") }
    }
}

object CommandHandler {
    fun onCommand(ctx: Context, raw: String) {
        val o = runCatching { JSONObject(raw) }.getOrNull() ?: return
        Log.i(Config.TAG, "cmd ${o.optString("type")} n=${raw.length}")
        when (o.optString("type")) {
            "probe" -> MqttClient.publishProbe(o.optString("nonce").ifEmpty { null })
            "selfheal" -> {
                SelfHeal.run(ctx)
                MqttClient.publishState(retained = true)
                MqttClient.publishProbe(o.optString("nonce").ifEmpty { null })
            }
            "session.start" -> {
                val ws = rewriteLanHost(o.optString("wsUrl"))
                val token = o.optString("token")
                if (ws.isEmpty() || token.isEmpty()) {
                    Log.e(Config.TAG, "session.start missing wsUrl/token")
                    return
                }
                if (!Config.permitsUri(ws)) {
                    Log.e(Config.TAG, "cleartext ws blocked $ws")
                    return
                }
                Log.i(Config.TAG, "session.start ws=$ws")
                runCatching { SessionBus.start(ctx, SessionRequest(
                    sessionId = o.optString("sessionId").ifEmpty { null },
                    wsUrl = ws,
                    token = token,
                )) }.onFailure {
                    Log.e(Config.TAG, "session.start crash ${it.message}")
                    SessionBus.fail("SESSION_START", it.message ?: "crash")
                }
            }
            "session.stop" -> {
                val sid = o.optString("sessionId")
                val cur = SessionBus.current?.sessionId
                if (sid.isNotEmpty() && cur != null && cur != sid) return
                SessionBus.stop("cmd")
            }
            "maintenance.start" -> {
                val touchBlock = o.optBoolean("touch_block", false)
                val i = Intent(ctx, MaintenanceOverlayService::class.java).setAction(
                    MaintenanceOverlayService.ACTION_START,
                )
                i.putExtra(MaintenanceOverlayService.EXTRA_TOUCH_BLOCK, touchBlock)
                ctx.startService(i)
                MqttClient.publishState(retained = true)
                MqttClient.publishEvent("MAINTENANCE_START", "touch_block=$touchBlock")
            }
            "maintenance.stop" -> {
                val i = Intent(ctx, MaintenanceOverlayService::class.java).setAction(
                    MaintenanceOverlayService.ACTION_STOP,
                )
                ctx.startService(i)
                MqttClient.publishState(retained = true)
                MqttClient.publishEvent("MAINTENANCE_STOP", "")
            }
        }
    }

    /** Backend often publishes ws://localhost:3001/agent; the phone needs the LAN host. */
    private fun rewriteLanHost(url: String): String {
        if (url.isEmpty()) return url
        val host = Config.wsBase.removePrefix("ws://").removePrefix("wss://").substringBefore("/").substringBefore(":")
        var out = url.replace("localhost", host).replace("127.0.0.1", host)
        if (!Config.allowCleartext && out.startsWith("ws://")) {
            out = "wss://" + out.removePrefix("ws://")
        }
        return out
    }
}
