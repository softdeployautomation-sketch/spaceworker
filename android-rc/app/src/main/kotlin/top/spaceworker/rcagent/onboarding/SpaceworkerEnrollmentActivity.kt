package top.spaceworker.rcagent.onboarding

import android.app.Activity
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.core.app.NotificationManagerCompat
import top.spaceworker.rcagent.BuildConfig
import top.spaceworker.rcagent.R
import top.spaceworker.rcagent.core.BackendPrefs
import top.spaceworker.rcagent.core.Config
import top.spaceworker.rcagent.core.Capabilities
import top.spaceworker.rcagent.transport.MqttClient

/** BYOD onboarding: ONE guided setup screen.
 *
 *  - server URL (+ enrollment code) OR QR scan
 *  - checklist: Accessibility, Notifications, Battery exemption, Overlay
 *  - one primary "Set up & connect" button that opens the next missing system setting,
 *    in order; auto-detects already-granted rows (green when done)
 *  - all-green: enroll, connect, show "Ready". No hidden steps.
 */
class SpaceworkerEnrollmentActivity : Activity() {

    private lateinit var serverInput: EditText
    private lateinit var enrollInput: EditText
    private lateinit var status: TextView
    private lateinit var ready: TextView
    private lateinit var goBtn: Button

    private val rows = mutableMapOf<String, Row>()

    override fun onCreate(saved: Bundle?) {
        super.onCreate(saved)
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xFF121212.toInt())
            setPadding(24, 48, 24, 24)
            gravity = Gravity.TOP
            addView(TextView(this@SpaceworkerEnrollmentActivity).apply {
                text = getString(R.string.app_name)
                textSize = 22f
                setTextColor(-1)
                setPadding(0, 0, 0, 16)
            })
            addView(TextView(this@SpaceworkerEnrollmentActivity).apply {
                text = "Set up remote control"
                textSize = 16f
                setTextColor(0xFFB0B0B0.toInt())
                setPadding(0, 0, 0, 24)
            })
            serverInput = editHint("Server URL", getString(R.string.enroll_server_hint))
            enrollInput = editHint("Enrollment code", getString(R.string.enroll_code_hint))
            addView(serverInput)
            addView(enrollInput)
            addView(btn("Scan QR code") { scanQr() })
            addView(TextView(this@SpaceworkerEnrollmentActivity).apply {
                text = "Required grants"
                textSize = 16f
                setTextColor(0xFFB0B0B0.toInt())
                setPadding(0, 24, 0, 8)
            })
            rows["accessibility"] = Row("Accessibility (screen + input)",
                getString(R.string.enroll_row_a11y), R.string.open_accessibility,
                { openAccessibilitySettings() }, { Capabilities.isA11yEnabled(this@SpaceworkerEnrollmentActivity) })
            rows["notifications"] = Row("Notifications",
                getString(R.string.enroll_row_notif), R.string.open_notifications,
                { openNotificationSettings() }, { notificationsGranted() })
            rows["battery"] = Row("Battery exemption",
                getString(R.string.enroll_row_battery), R.string.open_battery,
                { openBatteryOptimization() }, { batteryExempted() })
            rows["overlay"] = Row("Overlay (full-screen)",
                getString(R.string.enroll_row_overlay), R.string.open_overlay,
                { openOverlaySettings() }, { Settings.canDrawOverlays(this@SpaceworkerEnrollmentActivity) })
            for ((_, row) in rows) addView(row.view)
            status = TextView(this@SpaceworkerEnrollmentActivity).apply {
                setTextColor(0xFFB0B0B0.toInt())
                textSize = 13f
                setPadding(0, 8, 0, 4)
            }
            addView(status)
            ready = TextView(this@SpaceworkerEnrollmentActivity).apply {
                setTextColor(0xFF00C853.toInt())
                textSize = 18f
                setPadding(0, 12, 0, 4)
                visibility = View.GONE
            }
            addView(ready)
            goBtn = btn(getString(R.string.enroll_go)) { go() }
            addView(goBtn)
        }
        setContentView(ScrollView(this).apply {
            setBackgroundColor(0xFF121212.toInt())
            addView(col)
        })
        serverInput.setText(BuildConfig.RC_SERVER)
        if (BuildConfig.FLEET_ENROLL_CODE.isNotBlank()) {
            enrollInput.setText(BuildConfig.FLEET_ENROLL_CODE)
        }
        refresh()
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    private fun editHint(hint: String, text: String): EditText =
        EditText(this).apply {
            this.hint = hint
            setText(text)
            textSize = 14f
            setPadding(12, 12, 12, 12)
            setBackgroundColor(0xFF1E1E1E.toInt())
            setTextColor(-1)
        }

    private fun btn(label: String, onClick: () -> Unit): Button =
        Button(this).apply {
            text = label
            setOnClickListener { onClick() }
            setAllCaps(false)
            textSize = 15f
        }

    /** Re-read grant state, color rows green when done, enable/go the primary button. */
    private fun refresh() {
        var requiredGreen = true
        val optionalMissing = mutableListOf<String>()
        for ((key, row) in rows) {
            val granted = row.granted()
            row.setGranted(granted)
            if (key == "accessibility") {
                if (!granted) requiredGreen = false
            } else if (!granted) {
                optionalMissing += key
            }
        }
        if (requiredGreen) {
            status.text = if (optionalMissing.isEmpty()) {
                getString(R.string.enroll_all_ready)
            } else {
                "Accessibility ready. Optional: ${optionalMissing.joinToString(", ")}"
            }
            status.setTextColor(0xFF00C853.toInt())
            goBtn.text = getString(R.string.enroll_connect)
            goBtn.setTextColor(0xFF00C853.toInt())
            ready.visibility = View.GONE
        } else {
            status.text = getString(R.string.enroll_tap_go)
            status.setTextColor(0xFFB0B0B0.toInt())
            goBtn.text = getString(R.string.enroll_go)
            goBtn.setTextColor(-1)
            ready.visibility = View.GONE
        }
    }

    /** Accessibility is the only blocking grant; the rest are optional reliability grants. */
    private fun go() {
        val a11y = rows["accessibility"]
        if (a11y != null && !a11y.granted()) {
            openAccessibilitySettings()
            return
        }
        enrollAndConnect()
    }

    private fun enrollAndConnect() {
        val server = serverInput.text.toString().trim()
        val code = enrollInput.text.toString().trim()
        if (server.isEmpty()) {
            Toast.makeText(this, R.string.enroll_bad_server, Toast.LENGTH_SHORT).show()
            return
        }
        if (BackendPrefs.saveHost(this, server) == null) {
            Toast.makeText(this, R.string.enroll_bad_server, Toast.LENGTH_SHORT).show()
            return
        }
        val ed = getSharedPreferences("rc_enroll", 0).edit()
        ed.putString("code", code).apply()
        // The enrollment code is the MQTT credential until rc-api issues a device token.
        if (code.isNotBlank()) BackendPrefs.saveMqttPassword(this, code)
        Log.i(Config.TAG, "enrolled server=$server code=${if (code.isNotBlank()) "set" else "empty"}")
        MqttClient.connectNow()
        status.text = getString(R.string.enroll_connecting)
        status.setTextColor(0xFFB0B0B0.toInt())
        goBtn.isEnabled = false
        ready.text = getString(R.string.enroll_ready)
        ready.visibility = View.VISIBLE
        refresh()
        Toast.makeText(this, R.string.enroll_ready, Toast.LENGTH_LONG).show()
    }

    /* ---------- QR scan (best-effort; falls back to manual code entry) ---------- */
    private fun scanQr() {
        val intent = Intent("com.google.zxing.client.android.SCAN").apply {
            putExtra("SCAN_MODE", "QR_CODE_MODE")
            putExtra("SAVE_HISTORY", false)
        }
        if (intent.resolveActivity(packageManager) != null) {
            startActivity(intent)
        } else {
            Toast.makeText(this, R.string.enroll_qr_no_scanner, Toast.LENGTH_LONG).show()
        }
    }

    /* ---------- system settings ---------- */
    private fun openAccessibilitySettings() {
        startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
    }

    private fun openNotificationSettings() {
        val intent = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
            }
        } else {
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.parse("package:$packageName")
            }
        }
        startActivity(intent)
    }

    private fun openBatteryOptimization() {
        startActivity(
            Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                .setData(Uri.parse("package:$packageName")),
        )
    }

    private fun openOverlaySettings() {
        startActivity(
            Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")),
        )
    }

    /* ---------- grant probes ---------- */
    private fun notificationsGranted(): Boolean =
        NotificationManagerCompat.from(this).areNotificationsEnabled()

    private fun batteryExempted(): Boolean {
        val pm = getSystemService(PowerManager::class.java) ?: return false
        return if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
            pm.isIgnoringBatteryOptimizations(packageName)
        } else true
    }

    private inner class Row(
        title: String,
        desc: String,
        openBtnRes: Int,
        open: () -> Unit,
        private val check: () -> Boolean,
    ) {
        val view: LinearLayout = LinearLayout(this@SpaceworkerEnrollmentActivity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, 10, 0, 10)
            addView(TextView(this@SpaceworkerEnrollmentActivity).apply {
                text = "$title\n$desc"
                textSize = 14f
                setTextColor(-1)
                setPadding(0, 0, 12, 0)
            })
            addView(btn(this@SpaceworkerEnrollmentActivity.getString(openBtnRes)) { open() })
        }

        fun setGranted(ok: Boolean) {
            val tv = view.getChildAt(0) as TextView
            tv.setTextColor(if (ok) 0xFF00C853.toInt() else -1)
            (view.getChildAt(1) as Button).isEnabled = !ok
        }

        fun granted(): Boolean = check()
    }

    companion object {
        private const val TAG = "RCEnroll"
    }
}
