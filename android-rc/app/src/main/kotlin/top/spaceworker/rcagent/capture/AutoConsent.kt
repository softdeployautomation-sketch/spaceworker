package top.spaceworker.rcagent.capture

import android.accessibilityservice.AccessibilityService
import android.os.Build
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import top.spaceworker.rcagent.core.AgentState
import top.spaceworker.rcagent.core.Capabilities
import top.spaceworker.rcagent.core.Config
import top.spaceworker.rcagent.core.SessionBus
import top.spaceworker.rcagent.transport.MqttClient

object AutoConsent {
    private val ids = listOf(
        "android:id/button1",
        "com.android.systemui:id/button1",
        "com.android.systemui:id/start_button",
        "com.android.systemui:id/enable_screen_share",
    )

    fun handle(svc: AccessibilityService, e: AccessibilityEvent?) {
        if (e == null) return
        if (!shouldScan(SessionBus.awaitingProjection, AgentState.phase == AgentState.Phase.ACQUIRING, SessionBus.current != null)) return
        scan(svc)
    }

    fun scan(svc: AccessibilityService): Boolean {
        if (!shouldScan(SessionBus.awaitingProjection, AgentState.phase == AgentState.Phase.ACQUIRING, SessionBus.current != null)) return false
        if (Capabilities.probe(svc).projectMedia == "allow") return false
        val roots = LinkedHashSet<AccessibilityNodeInfo>()
        svc.rootInActiveWindow?.let { roots += it }
        if (Build.VERSION.SDK_INT >= 21) {
            svc.windows.orEmpty().mapNotNull(AccessibilityWindowInfo::getRoot).forEach { roots += it }
        }
        var clicked = false
        for (root in roots) {
            if (clickTree(root)) clicked = true
        }
        return clicked
    }

    fun shouldScan(awaitingProjection: Boolean, acquiring: Boolean, hasSession: Boolean): Boolean {
        if (!hasSession) return false
        return awaitingProjection || acquiring
    }

    fun isConsentLabel(raw: String): Boolean {
        val t = raw.lowercase().trim()
        if (t.isEmpty()) return false
        if (listOf(
                "cancel", "deny", "don't allow", "dont allow",
                "hủy", "từ chối", "không cho phép", "stop",
                "single app", "a single app", "một ứng dụng", "một app",
            ).any { t == it || t.startsWith("$it ") }
        ) return false
        return listOf(
            "start now",
            "start recording",
            "start recording or casting",
            "entire screen",
            "full screen",
            "share screen",
            "share the screen",
            "allow",
            "while using",
            "bắt đầu ngay",
            "bắt đầu",
            "toàn bộ màn hình",
            "chia sẻ màn hình",
            "cho phép",
        ).any { t.contains(it) }
    }

    private fun clickTree(root: AccessibilityNodeInfo): Boolean {
        for (id in ids) {
            val n = root.findAccessibilityNodeInfosByViewId(id).firstOrNull() ?: continue
            val label = listOf(n.text, n.contentDescription).mapNotNull { it?.toString() }.joinToString(" ")
            if (!isConsentLabel(label)) continue
            if (click(n, "$id $label")) return true
        }
        val hits = ArrayList<Pair<Int, AccessibilityNodeInfo>>()
        collect(root, hits)
        hits.sortBy { it.first }
        return hits.any { click(it.second, it.second.text?.toString() ?: "node") }
    }

    private fun collect(n: AccessibilityNodeInfo, out: ArrayList<Pair<Int, AccessibilityNodeInfo>>) {
        val label = listOf(n.text, n.contentDescription, n.hintText)
            .mapNotNull { it?.toString() }
            .joinToString(" ")
        if (n.isClickable && isConsentLabel(label)) {
            val rank = when {
                label.contains("entire", true) ||
                    label.contains("toàn bộ", true) ||
                    label.contains("full screen", true) -> 0
                label.contains("start now", true) || label.contains("bắt đầu ngay", true) -> 1
                label.contains("start", true) || label.contains("bắt đầu", true) -> 2
                else -> 3
            }
            out += rank to n
        }
        for (i in 0 until n.childCount) {
            n.getChild(i)?.let { collect(it, out) }
        }
    }

    private fun click(n: AccessibilityNodeInfo, why: String): Boolean {
        val ok = n.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        Log.i(Config.TAG, "autoclick ${if (ok) "ok" else "fail"} $why")
        if (ok) MqttClient.publishEvent("AUTOCLICK", why)
        return ok
    }
}
