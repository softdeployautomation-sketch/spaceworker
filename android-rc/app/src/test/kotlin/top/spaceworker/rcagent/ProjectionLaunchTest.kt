package top.spaceworker.rcagent

import android.content.Intent
import top.spaceworker.rcagent.capture.ProjectionLaunch
import org.junit.Assert.assertTrue
import org.junit.Test

class ProjectionLaunchTest {
    @Test
    fun backgroundLaunchUsesNewTask() {
        assertTrue(ProjectionLaunch.FLAGS and Intent.FLAG_ACTIVITY_NEW_TASK != 0)
        assertTrue(ProjectionLaunch.FLAGS and Intent.FLAG_ACTIVITY_SINGLE_TOP != 0)
        assertTrue(ProjectionLaunch.FLAGS and Intent.FLAG_ACTIVITY_CLEAR_TOP == 0)
    }
}
