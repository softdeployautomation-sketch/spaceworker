package top.spaceworker.rcagent

import top.spaceworker.rcagent.core.Capabilities
import top.spaceworker.rcagent.core.CapsSync
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CapsSyncTest {
    @Test
    fun waitsWhileA11yListedButUnbound() {
        assertTrue(CapsSync.waitForA11y(listed = true, bound = false, tryIndex = 0))
        assertFalse(CapsSync.waitForA11y(listed = true, bound = false, tryIndex = CapsSync.MAX_WAIT_TRIES))
        assertFalse(CapsSync.waitForA11y(listed = true, bound = true, tryIndex = 0))
        assertFalse(CapsSync.waitForA11y(listed = false, bound = false, tryIndex = 0))
    }

    @Test
    fun fingerprintChangesWithA11y() {
        val base = Capabilities("default", false, "unsupported", true, true, null)
        val on = base.copy(a11y = true)
        assertTrue(CapsSync.fingerprint(base, "1.2.0") != CapsSync.fingerprint(on, "1.2.0"))
        assertEquals(
            CapsSync.fingerprint(on, "1.2.0"),
            CapsSync.fingerprint(on.copy(), "1.2.0"),
        )
    }

    @Test
    fun a11yListedAcceptsShortAndLongComponent() {
        assertTrue(Capabilities.listedIn("top.spaceworker.rcagent/top.spaceworker.rcagent.input.RcAccessibilityService"))
        assertTrue(Capabilities.listedIn("top.spaceworker.rcagent/.input.RcAccessibilityService"))
        assertTrue(Capabilities.listedIn("com.hmdm.launcher/.A11y:top.spaceworker.rcagent/.input.RcAccessibilityService"))
        assertFalse(Capabilities.listedIn("com.google.android.marvin.talkback/.TalkBackService"))
        assertFalse(Capabilities.listedIn(""))
    }

    @Test
    fun consentLabelsMatchStartNow() {
        assertTrue(top.spaceworker.rcagent.capture.AutoConsent.isConsentLabel("Start now"))
        assertTrue(top.spaceworker.rcagent.capture.AutoConsent.isConsentLabel("Entire screen"))
        assertTrue(top.spaceworker.rcagent.capture.AutoConsent.isConsentLabel("Toàn bộ màn hình"))
        assertTrue(!top.spaceworker.rcagent.capture.AutoConsent.isConsentLabel("A single app"))
        assertTrue(!top.spaceworker.rcagent.capture.AutoConsent.isConsentLabel("Một ứng dụng"))
        assertTrue(top.spaceworker.rcagent.capture.AutoConsent.isConsentLabel("Start recording or casting"))
        assertTrue(!top.spaceworker.rcagent.capture.AutoConsent.isConsentLabel("Cancel"))
        assertTrue(!top.spaceworker.rcagent.capture.AutoConsent.isConsentLabel("Don't allow"))
    }

    @Test
    fun consentRunsOnAppOpenWithoutSession() {
        assertFalse(top.spaceworker.rcagent.capture.AutoConsent.shouldScan(true, false, false))
        assertFalse(top.spaceworker.rcagent.capture.AutoConsent.shouldScan(false, false, false))
        assertFalse(top.spaceworker.rcagent.capture.AutoConsent.shouldScan(false, true, false))
        assertTrue(top.spaceworker.rcagent.capture.AutoConsent.shouldScan(false, true, true))
    }
}
