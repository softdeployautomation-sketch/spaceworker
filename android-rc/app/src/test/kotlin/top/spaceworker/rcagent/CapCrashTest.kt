package top.spaceworker.rcagent

import top.spaceworker.rcagent.capture.CapCrash
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class CapCrashTest {
    @Before
    fun reset() {
        CapCrash.clear()
    }

    @Test
    fun matchesRcCapTextureDeath() {
        val e = IllegalStateException("Unable to update texture contents (see logcat for details)")
        assertTrue(CapCrash.isTextureDeath("rc-cap", e))
    }

    @Test
    fun anyErrorOnRcCapIsCaptureCrash() {
        assertTrue(CapCrash.isCaptureThread("rc-cap"))
        assertFalse(CapCrash.isCaptureThread("main"))
        assertFalse(CapCrash.isCaptureThread("rc-mqtt"))
    }

    @Test
    fun abandonBlocksWaitOnHelperEvenIfThreadStillAlive() {
        assertTrue(CapCrash.canWaitOnHelper(threadAlive = true))
        CapCrash.markAbandon()
        assertFalse(CapCrash.canWaitOnHelper(threadAlive = true))
        assertFalse(CapCrash.canWaitOnHelper(threadAlive = false))
    }

    @Test
    fun deadHelperThreadIsNeverWaitedOn() {
        assertFalse(CapCrash.canWaitOnHelper(threadAlive = false))
    }
}
