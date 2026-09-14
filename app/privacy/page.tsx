import type { Metadata } from "next";
import Link from "next/link";

import { env } from "@/lib/env";

export const metadata: Metadata = { title: "Privacy Policy — SpaceWorker OS" };

export default function PrivacyPage() {
  const contact = env.emailFrom || "support@spaceworker.app";
  return (
    <div className="min-h-screen bg-bg px-4 py-16">
      <div className="mx-auto max-w-2xl">
        <Link href="/" className="text-sm font-semibold text-brand-600 hover:underline">
          ← SpaceWorker OS
        </Link>
        <h1 className="mt-4 text-3xl font-bold text-fg">Privacy Policy</h1>
        <p className="mt-2 text-sm text-fg-muted">Last updated: September 2026</p>

        <div className="mt-10 space-y-8 text-sm leading-relaxed text-fg">
          <p className="text-fg-muted">
            SpaceWorker OS is an automation workspace for lead research and
            outreach. Because it handles genuinely sensitive data — extracted
            contact information, mailbox credentials, browser fingerprints, and
            payment records — this page explains plainly what we collect, why,
            how it&rsquo;s protected, and how long we keep it.
          </p>

          <section>
            <h2 className="text-lg font-semibold text-fg">1. What we collect</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-fg-muted">
              <li>
                <strong>Account email</strong> — the address you sign up with, used for login,
                verification, and sending your receipts/license keys.
              </li>
              <li>
                <strong>Extracted lead data</strong> — businesses, contact details, and profile
                fingerprints you collect through the extractor. This is <em>your</em> data; we
                store it so your jobs and lists persist across logins.
              </li>
              <li>
                <strong>SMTP mailbox credentials</strong> — for sending, you can connect your
                own mailbox. These are stored encrypted with AES-256-GCM and are never sent
                anywhere except to your own mailbox provider as part of sending.
              </li>
              <li>
                <strong>Browser-profile data</strong> — per-profile browsing context and
                fingerprints so your browser profiles stay separate and persistent.
              </li>
              <li>
                <strong>Payment records</strong> — for a purchase we store the Bitcoin/USDT
                transaction hash and the wallet address you paid to, so a purchase can be
                matched to your license.
              </li>
              <li>
                <strong>Linked Telegram chat id</strong> — only if you opt in to Telegram
                notifications in Settings; we store the chat id it takes to send you messages.
              </li>
              <li>
                <strong>AI usage</strong> — when you use the agent, prompts are relayed to our
                AI provider and attributed to your account via an opaque
                <code>external_user_id</code> (never your name or email), so daily AI cost can
                be tracked per account.
              </li>
            </ul>
          </section>

          {/* part 2 appended below */}
          <section>
            <h2 className="text-lg font-semibold text-fg">2. Cold-outreach data is your responsibility</h2>
            <p className="mt-2 text-fg-muted">
              The content of your outreach and the recipient lists you build are your own data
              and your own business responsibility. SpaceWorker OS stores them to run your
              campaigns, but it is up to you to ensure your sending complies with the laws that
              apply to you (e.g. CAN-SPAM, GDPR). This is not an anonymity product — see our
              Terms. As the sender, you control and are accountable for what and who you contact.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-fg">3. Retention and deletion</h2>
            <p className="mt-2 text-fg-muted">
              Today SpaceWorker OS automatically deletes completed extraction jobs — and all the
              leads they produced — once they are more than 30 days old, <em>if</em> none of
              their leads&rsquo; emails have ever been used in a campaign. Running or paused jobs,
              jobs that failed, and any lead whose details fed a campaign are kept. Anything
              outside that rule is retained until you ask us to delete it.
            </p>
            <p className="mt-2 text-fg-muted">
              To request deletion of data we hold about you, or of a specific job/campaign,
              email us at <strong>{contact}</strong> and we&rsquo;ll action it as soon as
              possible.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-fg">4. Payments never touch card data</h2>
            <p className="mt-2 text-fg-muted">
              We do not accept, store, or process any credit-card data — there is no PCI scope.
              Purchases are paid with Bitcoin or USDT-TRC20 directly to an address we provide,
              and we only record the transaction hash to match the payment to your license.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-fg">5. Telegram linking is opt-in and revocable</h2>
            <p className="mt-2 text-fg-muted">
              Linking a Telegram chat for notifications is entirely optional. You can disconnect
              it at any time from Settings, which removes the stored chat id.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-fg">6. Contact</h2>
            <p className="mt-2 text-fg-muted">
              Questions about this policy, or to exercise deletion, can be sent to{" "}
              <strong>{contact}</strong>.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}