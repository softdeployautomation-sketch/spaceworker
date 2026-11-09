package top.spaceworker.rcagent.mdm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import top.spaceworker.rcagent.transport.MqttClient

class ManagedConfigReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent?) {
        val a = intent?.action ?: return
        if (a == Intent.ACTION_APPLICATION_RESTRICTIONS_CHANGED) {
            if (ManagedConfig.applyFromRestrictions(ctx.applicationContext)) {
                MqttClient.connectNow()
            }
        } else if (a == "com.hmdm.push.configUpdated") {
            HeadwindBridge.pull()
        }
    }
}
