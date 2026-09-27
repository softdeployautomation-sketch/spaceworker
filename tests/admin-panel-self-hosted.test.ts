import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ConfirmProvider } from "../components/confirm-provider";
import AdminPanel from "../app/admin/(protected)/admin-panel";

// TASK_129 §2 — the admin panel's self-hosted tab filtering, proven by
// server-rendering the REAL AdminPanel component (not a copy of the filter).
// A self-hosted build must render exactly the 11 kept tabs and never the four
// hosted-only ones (Payments, Wallets, AI/Licenses). The prop is wired in
// production from isSelfHosted() in app/admin/(protected)/page.tsx; this test
// drives the same prop directly, which is the component's whole contract.
// Nothing here touches a DB, network, or browser — SSR renders the default
// Overview tab and the nav only.
function render(selfHosted: boolean): string {
  return renderToStaticMarkup(
    createElement(
      ConfirmProvider,
      null,
      createElement(AdminPanel, { initialUsers: [], selfHosted }),
    ),
  );
}

const HOSTED_ONLY = ["Payments", "Wallets", "AI", "Licenses"];
const KEPT = [
  "Overview",
  "Users",
  "Notifications",
  "Browser Sessions",
  "Search Queue",
  "Infrastructure",
  "Services",
  "Campaign Templates",
  "Mailboxes",
  "Campaigns",
  "Automations",
];

test("self-hosted: exactly the 11 hosted-appropriate tab buttons render", () => {
  const html = render(true);
  for (const label of KEPT) {
    assert.ok(html.includes(`>${label}</button>`), `expected the "${label}" tab button`);
  }
  for (const label of HOSTED_ONLY) {
    assert.ok(
      !html.includes(`>${label}</button>`),
      `"${label}" tab button must NOT render in a self-hosted build`,
    );
  }
  // 11 kept tabs and 4 omitted = the 15 the hosted build shows.
  assert.equal(KEPT.length, 11, "sanity: the kept set is exactly 11 tabs");
});

test("hosted: all 15 tab buttons (including the four hosted-only ones) render", () => {
  const html = render(false);
  for (const label of [...KEPT, ...HOSTED_ONLY]) {
    assert.ok(html.includes(`>${label}</button>`), `expected the "${label}" tab button`);
  }
});
