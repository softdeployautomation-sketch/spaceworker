package top.spaceworker.rcagent

import top.spaceworker.rcagent.capture.HwKillSwitch
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HwKillSwitchTest {
    @Test
    fun skipAfterKillDuringH264Init() {
        assertTrue(HwKillSwitch.shouldSkip(
            fault = "KILLED process died after [1.4.0 1 mp:h264 init]",
            step = "1.4.0 1 mp:h264 init",
        ))
    }

    @Test
    fun noSkipOnCleanH264() {
        assertFalse(HwKillSwitch.shouldSkip(
            fault = "",
            step = "1.4.0 1 mp:ok h264",
        ))
    }

    @Test
    fun noSkipOnUnrelatedKill() {
        assertFalse(HwKillSwitch.shouldSkip(
            fault = "KILLED process died after [mp:codec qti]",
            step = "mp:codec qti",
        ))
    }

    @Test
    fun skipAfterNativeKillOnceH264WasRunning() {
        assertTrue(HwKillSwitch.shouldSkip(
            fault = "KILLED process died after [1.4.3 1 mp:ok h264 c2.mtk.avc.encoder]",
            step = "1.4.3 1 mp:ok h264 c2.mtk.avc.encoder 720x448",
        ))
    }
}
