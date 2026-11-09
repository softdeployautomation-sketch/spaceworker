package top.spaceworker.rcagent.core

/** When to wait vs publish retained rc/state so backend does not store a11y=false during bind. */
object CapsSync {
    const val MAX_WAIT_TRIES = 5
    const val WAIT_MS = 400L

    fun fingerprint(caps: Capabilities, agentVer: String): String =
        listOf(
            caps.projectMedia,
            caps.a11y.toString(),
            caps.knox,
            caps.overlay.toString(),
            caps.secureSettings.toString(),
            caps.encoder?.name.orEmpty(),
            agentVer,
        ).joinToString("|")

    fun waitForA11y(listed: Boolean, bound: Boolean, tryIndex: Int): Boolean =
        listed && !bound && tryIndex < MAX_WAIT_TRIES
}
