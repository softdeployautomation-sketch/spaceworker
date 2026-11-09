package top.spaceworker.rcagent.settings

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import top.spaceworker.rcagent.R
import top.spaceworker.rcagent.boot.SelfHeal
import top.spaceworker.rcagent.capture.ScreenWake
import top.spaceworker.rcagent.core.AgentState
import top.spaceworker.rcagent.core.BackendPrefs
import top.spaceworker.rcagent.core.Capabilities
import top.spaceworker.rcagent.core.Config
import top.spaceworker.rcagent.core.FaultLog
import top.spaceworker.rcagent.core.SessionBus
import top.spaceworker.rcagent.core.deviceId
import top.spaceworker.rcagent.transport.MqttClient

class SettingsActivity : Activity() {
    private lateinit var summary: TextView
    private lateinit var log: TextView

    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        live = this
        ScreenWake.allowCapture(this)
        summary = TextView(this).apply {
            setTextColor(0xFFB0B0B0.toInt())
            textSize = 14f
            setPadding(0, 12, 0, 8)
        }
        log = TextView(this).apply {
            setTextColor(Color.LTGRAY)
            textSize = 13f
            setPadding(0, 16, 0, 24)
            typeface = android.graphics.Typeface.MONOSPACE
        }
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xFF121212.toInt())
            setPadding(24, 48, 24, 24)
            gravity = Gravity.TOP
            addView(TextView(this@SettingsActivity).apply {
                text = "RC Agent"
                textSize = 22f
                setTextColor(Color.WHITE)
            })
            addView(summary)
            addView(btn(getString(R.string.connection_open)) {
                startActivity(Intent(this@SettingsActivity, ConnectionActivity::class.java))
            })
            addView(btn("Stop session") { SessionBus.stop("user") })
            addView(btn("Self-heal + probe") {
                SelfHeal.run(this@SettingsActivity)
                MqttClient.publishState(retained = true)
                dump()
            })
            addView(btn("MQTT connect now") { MqttClient.connectNow(); dump() })
            addView(btn("Overlay permission") {
                startActivity(
                    Intent(
                        Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:$packageName"),
                    ),
                )
            })
            addView(btn("Enable accessibility") {
                startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            })
            // MediaProjection/H.264 is opt-in; default capture is Accessibility takeScreenshot (no prompt).
            val mpToggle = android.widget.CheckBox(this@SettingsActivity).apply {
                text = "Allow MediaProjection / H.264 (high-FPS, opt-in)"
                setTextColor(0xFFB0B0B0.toInt())
                textSize = 14f
                setPadding(0, 8, 0, 8)
                isChecked = BackendPrefs.mediaProjectionEnabled(this@SettingsActivity)
                setOnCheckedChangeListener { _, checked ->
                    BackendPrefs.saveMediaProjection(this@SettingsActivity, checked)
                    Log.i(Config.TAG, "mediaProjection=$checked")
                }
            }
            addView(mpToggle)
            addView(log)
        }
        setContentView(ScrollView(this).apply {
            setBackgroundColor(0xFF121212.toInt())
            addView(col)
        })
        if (Build.VERSION.SDK_INT >= 33) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        dump()
        applyWake()
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        applyWake()
    }

    override fun onResume() {
        super.onResume()
        foreground = true
        ScreenWake.allowCapture(this)
        if (AgentState.phase == AgentState.Phase.STREAMING) {
            moveTaskToBack(true)
            return
        }
        dump()
    }

    override fun onPause() {
        foreground = false
        super.onPause()
    }

    fun askFromUi() {
        captureRequested = true
        @Suppress("DEPRECATION")
        startActivityForResult(top.spaceworker.rcagent.capture.ProjectionRequestActivity.captureIntent(this), PROJ_REQ)
        top.spaceworker.rcagent.input.RcAccessibilityService.watchConsent()
    }

    @Deprecated("spec uses onActivityResult")
    override fun onActivityResult(req: Int, res: Int, data: Intent?) {
        if (req != PROJ_REQ || !captureRequested) return
        captureRequested = false
        if (res == RESULT_OK && data != null) SessionBus.onProjection(this, data)
        else SessionBus.onProjectionDenied()
    }

    private fun applyWake() {
        if (intent?.action != Config.WAKE_ACTION) return
        ScreenWake.acquire(this)
        MqttClient.connectNow()
        dump()
    }

    private fun dump() {
        summary.text = buildString {
            appendLine(BackendPrefs.displayBackend(this@SettingsActivity))
            appendLine(Config.mqttBroker)
            append("id=${deviceId(this@SettingsActivity)}")
        }
        val caps = Capabilities.probe(this)
        log.text = buildString {
            appendLine("deviceId=${deviceId(this@SettingsActivity)}")
            appendLine("agentVer=${Config.agentVer}")
            appendLine("mdm=${top.spaceworker.rcagent.mdm.ManagedConfig.lastApplied.ifBlank { "-" }}")
            appendLine("phase=${AgentState.phase}")
            appendLine("mqtt=${MqttClient.connected} ${Config.mqttBroker} err=${MqttClient.lastError}")
            appendLine("ws=${Config.wsBase}")
            appendLine("wan=${Config.wan}")
            appendLine("caps=$caps")
            appendLine("a11yListed=${Capabilities.a11yListed(this@SettingsActivity)}")
            appendLine("a11yInstance=${top.spaceworker.rcagent.input.RcAccessibilityService.instance != null}")
            appendLine("a11ySvc=${Settings.Secure.getString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)}")
            appendLine("overlay=${Settings.canDrawOverlays(this@SettingsActivity)}")
            appendLine("screen=${top.spaceworker.rcagent.core.screenSize(this@SettingsActivity)}")
            appendLine("input=${SessionBus.input?.name}")
            appendLine("enc=${top.spaceworker.rcagent.capture.CaptureService.encLabel}")
            appendLine("err=${SessionBus.lastError}")
            val step = FaultLog.stepLine()
            if (step.isNotEmpty()) appendLine("step=$step")
            val fault = FaultLog.faultText()
            if (fault.isNotEmpty()) appendLine("fault=${fault.take(900)}")
            val crash = top.spaceworker.rcagent.RcApplication.crashText()
            if (crash.isNotEmpty()) appendLine("crash=${crash.take(900)}")
        }
    }

    private fun btn(label: String, onClick: () -> Unit) = Button(this).apply {
        text = label
        setOnClickListener { onClick() }
    }

    override fun onDestroy() {
        if (live === this) live = null
        super.onDestroy()
    }

    private var captureRequested = false

    companion object {
        private const val PROJ_REQ = 7
        @Volatile private var live: SettingsActivity? = null
        @Volatile private var foreground = false

        fun hideForRemote() {
            ConnectionActivity.finishIfOpen()
            live?.moveTaskToBack(true)
        }

        fun requestCapture(): Boolean {
            val a = live ?: return false
            if (!foreground) return false
            a.runOnUiThread { a.askFromUi() }
            return true
        }
    }
}
