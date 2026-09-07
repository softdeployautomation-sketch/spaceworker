import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Terms of Service — SpaceWorker" };

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-bg px-4 py-16">
      <div className="mx-auto max-w-2xl">
        <Link href="/" className="text-sm font-semibold text-brand-600 hover:underline">
          ← SpaceWorker
        </Link>
        <h1 className="mt-4 text-3xl font-bold text-fg">Terms of Service &amp; Acceptable Use</h1>
        <p className="mt-2 text-sm text-fg-muted">Last updated: September 2026</p>

        <div className="mt-10 space-y-8 text-sm leading-relaxed text-fg">
          <section>
            <h2 className="text-lg font-semibold text-fg">1. What SpaceWorker is</h2>
            <p className="mt-2 text-fg-muted">
              SpaceWorker provides a persistent, streamed private browser and
              related automation tools (lead extraction, mailbox sending, browser
              profiles) for legitimate research, outreach, and business use. By
              creating an account or using any part of the service, you agree to
              these terms.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-fg">2. Acceptable use</h2>
            <p className="mt-2 text-fg-muted">You agree not to use SpaceWorker, including its private-browser exit
              nodes and any IP address it routes your traffic through, to:</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-fg-muted">
              <li>Break any applicable law, including fraud, harassment, or unauthorized access to systems or data.</li>
              <li>Send unsolicited bulk email (spam), or send email in a way that violates CAN-SPAM, GDPR, or similar rules.</li>
              <li>Distribute malware, infringe intellectual property, or facilitate child sexual abuse material — this is
                zero-tolerance and will be reported to law enforcement immediately.</li>
              <li>Evade a service's rate limits, bans, or terms of service at a scale intended to cause harm, or scrape
                data in a way that violates the target site's own terms.</li>
              <li>Attempt to conceal the true identity of a session from us, or interfere with the logging described in
                Section 4 below.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-fg">3. Enforcement</h2>
            <p className="mt-2 text-fg-muted">
              We may suspend or terminate any account, without notice, that we
              reasonably believe violates Section 2 — including while we
              investigate a report or complaint. We are not obligated to
              provide a refund for a terminated account found to have violated
              these terms.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-fg">4. Logging &amp; cooperation with law enforcement</h2>
            <p className="mt-2 text-fg-muted">
              Because SpaceWorker's private browser routes your traffic through
              shared infrastructure we operate, we record which account was
              assigned which exit IP address and when, for every session. This
              exists so that if an abuse report or law enforcement request
              arrives about specific traffic, we can identify the responsible
              account rather than being unable to answer for infrastructure we
              provide. We will disclose this information to law enforcement, or
              to a third party alleging harm, when legally required to do so,
              or when we determine in good faith it's necessary to prevent
              serious harm or comply with the law.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-fg">5. No guarantee of anonymity</h2>
            <p className="mt-2 text-fg-muted">
              SpaceWorker's exit nodes are a tool for appearing from a different
              network location for legitimate research and outreach purposes —
              they are not an anonymity or privacy product, and we make no
              representation that traffic routed through them cannot be traced
              back to your account. Do not rely on this service to conceal
              illegal activity; per Section 4, it will not.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-fg">6. Service availability</h2>
            <p className="mt-2 text-fg-muted">
              Exit nodes, browser sessions, and automation features are provided
              as-is and may be interrupted, changed, or discontinued at any
              time. We do not guarantee any particular IP, location, or uptime.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-fg">7. Changes to these terms</h2>
            <p className="mt-2 text-fg-muted">
              We may update these terms from time to time. Continued use of
              SpaceWorker after a change means you accept the updated terms.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-fg">8. Contact</h2>
            <p className="mt-2 text-fg-muted">
              Questions about these terms, or to report suspected abuse, can be
              sent to the support address listed in your dashboard.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
