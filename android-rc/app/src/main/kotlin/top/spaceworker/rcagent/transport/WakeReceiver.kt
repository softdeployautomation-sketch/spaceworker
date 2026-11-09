package top.spaceworker.rcagent.transport

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import top.spaceworker.rcagent.capture.ScreenWake
import top.spaceworker.rcagent.core.Config

class WakeReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, i: Intent) {
        ScreenWake.acquire(ctx, Config.WAKE_PUSH_MS)
        MqttClient.connectNow()
    }
}
