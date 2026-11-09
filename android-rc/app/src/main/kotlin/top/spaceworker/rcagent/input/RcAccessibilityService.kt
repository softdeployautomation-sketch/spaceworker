package top.spaceworker.rcagent.input

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityEvent
import top.spaceworker.rcagent.RcApplication
import top.spaceworker.rcagent.capture.AutoConsent
import top.spaceworker.rcagent.core.AgentState
import top.spaceworker.rcagent.core.Config
import top.spaceworker.rcagent.core.SessionBus

class RcAccessibilityService : AccessibilityService() {
    private val handler = Handler(Looper.getMainLooper())
    private var consentTries = 0
    private val consentWatch = object : Runnable {
        override fun run() {
            if (AgentState.phase != AgentState.Phase.ACQUIRING &&
                !SessionBus.awaitingProjection
            ) return
            AutoConsent.scan(this@RcAccessibilityService)
            consentTries++
            if (consentTries < CONSENT_TRIES) handler.postDelayed(this, Config.KICK_FRAME_MS)
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        AutoConsent.handle(this, event)
    }

    override fun onInterrupt() {}

    override fun onServiceConnected() {
        instance = this
        android.util.Log.i(Config.TAG, "a11y connected")
        SessionBus.onA11yReady(this)
    }

    override fun onUnbind(intent: Intent?): Boolean {
        handler.removeCallbacks(consentWatch)
        instance = null
        SessionBus.onA11yLost(RcApplication.app)
        return super.onUnbind(intent)
    }

    fun watchConsent() {
        handler.removeCallbacks(consentWatch)
        consentTries = 0
        handler.post(consentWatch)
    }

    companion object {
        private const val CONSENT_TRIES = 40

        @Volatile var instance: RcAccessibilityService? = null

        fun watchConsent() {
            instance?.watchConsent()
        }
    }
}
