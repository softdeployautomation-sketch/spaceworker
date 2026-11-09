package top.spaceworker.rcagent.mdm

import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.ServiceConnection
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import com.hmdm.IMdmApi
import top.spaceworker.rcagent.core.Config
import top.spaceworker.rcagent.transport.MqttClient

/** Binds Headwind PluginApiService and pulls Application Settings for this package. */
object HeadwindBridge : ServiceConnection {
    private const val ACTION = "com.hmdm.action.Connect"
    private const val PKG = "com.hmdm.launcher"
    private const val LEGACY = "ru.headwind.kiosk"
    private const val CONFIG_UPDATED = "com.hmdm.push.configUpdated"

    private val main = Handler(Looper.getMainLooper())
    private var app: Context? = null
    private var api: IMdmApi? = null
    private var bound = false
    private var receiverReg = false
    private var reconnects = 0

    private val configRx = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context?, intent: Intent?) {
            if (intent?.action == CONFIG_UPDATED) pull()
        }
    }

    fun start(ctx: Context) {
        app = ctx.applicationContext
        bind()
        if (!receiverReg) {
            val f = IntentFilter(CONFIG_UPDATED)
            if (Build.VERSION.SDK_INT >= 33) {
                ctx.applicationContext.registerReceiver(configRx, f, Context.RECEIVER_EXPORTED)
            } else {
                @Suppress("DEPRECATION")
                ctx.applicationContext.registerReceiver(configRx, f)
            }
            receiverReg = true
        }
    }

    private fun bind() {
        val ctx = app ?: return
        if (bound) return
        val i = Intent(ACTION).setPackage(PKG)
        bound = runCatching { ctx.bindService(i, this, Context.BIND_AUTO_CREATE) }.getOrDefault(false)
        if (!bound) {
            i.setPackage(LEGACY)
            bound = runCatching { ctx.bindService(i, this, Context.BIND_AUTO_CREATE) }.getOrDefault(false)
        }
        if (!bound) Log.i(Config.TAG, "hmdm not installed")
    }

    override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
        reconnects = 0
        api = IMdmApi.Stub.asInterface(service)
        Log.i(Config.TAG, "hmdm connected")
        pull()
    }

    override fun onServiceDisconnected(name: ComponentName?) {
        api = null
        bound = false
        Log.w(Config.TAG, "hmdm disconnected")
        val delay = if (reconnects == 0) 5_000L else 60_000L
        reconnects++
        main.postDelayed({ bind() }, delay)
    }

    fun pull() {
        val ctx = app ?: return
        val remote = api ?: return
        val pkg = ctx.packageName
        val raw = LinkedHashMap<String, String>()
        for (k in listOf(
            ManagedConfig.HOST, "backend", "relay_host",
            ManagedConfig.MQTT, "mqtt_broker",
            ManagedConfig.MQTT_PASSWORD, "mqtt_pass",
            ManagedConfig.DEVICE_ID, "deviceId",
            ManagedConfig.RELAY_PORT, "ws_port",
        )) {
            val v = runCatching { remote.queryAppPreference(pkg, k) }.getOrNull()
            if (!v.isNullOrBlank()) raw[k] = v
        }
        if (ManagedConfig.apply(ctx, raw)) MqttClient.connectNow()
    }
}
