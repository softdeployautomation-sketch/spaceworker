import type { Metadata } from "next";
import { randomBytes } from "crypto";

import ClownGate from "@/components/clown-gate";
import SupportForm from "@/components/support-form";

// Public homepage (owner, 2026-10-16): text-free joker gate. The image sits
// on top, a scrambled version of it sits below, and solving the scramble
// reveals the support form. Referral enforcement lives entirely on
// /login, /signup and the /r/:code route handler (which stamps the sw_ref
// cookie) — this page carries no copy and no referral UI on purpose.
export const metadata: Metadata = {
  title: "SpaceWorker",
};

export default function GatePage() {
  const seed = randomBytes(8).toString("hex");

  return (
    <ClownGate src="/joker.jpeg" seed={seed}>
      <SupportForm />
    </ClownGate>
  );
}
