package top.spaceworker.rcagent.settings

import android.app.Activity
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import top.spaceworker.rcagent.R
import top.spaceworker.rcagent.capture.ScreenWake
import top.spaceworker.rcagent.core.AgentState
import top.spaceworker.rcagent.core.BackendPrefs
import top.spaceworker.rcagent.core.Config
import top.spaceworker.rcagent.core.androidId
import top.spaceworker.rcagent.core.deviceId
import top.spaceworker.rcagent.transport.MqttClient

class ConnectionActivity : Activity() {
    private lateinit var hostInput: EditText
    private lateinit var mqttInput: EditText
    private lateinit var mqttPassInput: EditText
    private lateinit var deviceIdInput: EditText
    private lateinit var relayPortInput: EditText
    private lateinit var status: TextView

    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        live = this
        ScreenWake.allowCapture(this)
        setContentView(R.layout.activity_connection)
        hostInput = findViewById(R.id.host_input)
        mqttInput = findViewById(R.id.mqtt_input)
        mqttPassInput = findViewById(R.id.mqtt_pass_input)
        deviceIdInput = findViewById(R.id.device_id_input)
        relayPortInput = findViewById(R.id.relay_port_input)
        status = findViewById(R.id.status_text)
        findViewById<Button>(R.id.save_btn).setOnClickListener { save() }
        fill()
    }

    override fun onResume() {
        super.onResume()
        ScreenWake.allowCapture(this)
        if (AgentState.phase == AgentState.Phase.STREAMING) finish()
    }

    private fun fill() {
        hostInput.setText(BackendPrefs.displayBackend(this))
        mqttInput.setText(BackendPrefs.mqttBroker(this))
        mqttPassInput.setText(BackendPrefs.mqttPassword(this))
        deviceIdInput.hint = androidId(this).ifBlank { getString(R.string.connection_device_hint) }
        deviceIdInput.setText(BackendPrefs.savedDeviceId(this))
        relayPortInput.setText(BackendPrefs.displayRelayPort(this))
        status.text = effective()
    }

    private fun save() {
        if (BackendPrefs.parseHost(hostInput.text.toString()) == null) {
            Toast.makeText(this, R.string.connection_bad_host, Toast.LENGTH_SHORT).show()
            return
        }
        val mqttRaw = mqttInput.text.toString()
        if (mqttRaw.isNotBlank() && BackendPrefs.parseMqtt(mqttRaw) == null) {
            Toast.makeText(this, R.string.connection_bad_mqtt, Toast.LENGTH_SHORT).show()
            return
        }
        val portRaw = relayPortInput.text.toString().trim()
        val clearPort = portRaw.isEmpty() || portRaw == "0"
        if (!clearPort && BackendPrefs.parseRelayPort(portRaw) == null) {
            Toast.makeText(this, R.string.connection_bad_port, Toast.LENGTH_SHORT).show()
            return
        }
        BackendPrefs.saveHost(this, hostInput.text.toString())
        val mqtt = BackendPrefs.saveMqtt(this, mqttRaw) ?: return
        if (clearPort) BackendPrefs.clearRelayPort(this)
        else BackendPrefs.saveRelayPort(this, portRaw)
        val idRaw = deviceIdInput.text.toString().trim()
        if (idRaw.isEmpty()) BackendPrefs.clearDeviceId(this)
        else BackendPrefs.saveDeviceId(this, idRaw)
        BackendPrefs.saveMqttPassword(this, mqttPassInput.text.toString())
        fill()
        Toast.makeText(this, mqtt, Toast.LENGTH_SHORT).show()
        MqttClient.connectNow()
    }

    private fun effective() = buildString {
        appendLine("host=${BackendPrefs.displayBackend(this@ConnectionActivity)}")
        appendLine("mqtt=${Config.mqttBroker}")
        appendLine("deviceId=${deviceId(this@ConnectionActivity)}")
        appendLine("ws=${Config.wsBase}")
        append("mdm=${top.spaceworker.rcagent.mdm.ManagedConfig.lastApplied.ifBlank { "-" }}")
    }

    override fun onDestroy() {
        if (live === this) live = null
        super.onDestroy()
    }

    companion object {
        @Volatile private var live: ConnectionActivity? = null
        fun finishIfOpen() {
            live?.finish()
        }
    }
}
