package top.spaceworker.rcagent

import top.spaceworker.rcagent.core.FaultLog
import org.junit.Assert.assertTrue
import org.junit.Test

class FaultLogTest {
    @Test
    fun formatIncludesCauseChain() {
        val t = IllegalStateException("startForeground", SecurityException("FGS type mediaProjection"))
        val s = FaultLog.format("FGS_MP", "startForeground mediaProjection", t)
        assertTrue(s.contains("FGS_MP"))
        assertTrue(s.contains("startForeground mediaProjection"))
        assertTrue(s.contains("IllegalStateException"))
        assertTrue(s.contains("SecurityException"))
        assertTrue(s.contains("mediaProjection"))
    }
}
