import { redirect } from "next/navigation";

import { getAdminSession } from "@/lib/admin-auth";
import { ADMIN_PATH, ADMIN_LOGIN_PATH } from "@/lib/admin-path";

import { SecretDevicesHost } from "../101/host";

// TASK_190 S1 — "Open console" deep link: the ACTIONS dropdown opens
// `/admin=topsecret6199/device/<deviceId>` in a new tab, so this dynamic
// segment must RESOLVE (200) for any id or the menu item would dead-end in
// a 404. It renders the SAME guarded console page as the static unlisted
// route one directory up (the id in the URL names the row the admin came
// from; the console itself lists every machine — same content, same guard).
//
// The static segment `101` keeps precedence over this one, so the original
// unlisted URL behaves byte-for-byte as before. Secrecy rules still apply:
// no OTHER file may link either URL (the dropdown lives only on this page,
// reachable only with the admin session), and this file must never contain
// the retired pre-TASK_188 path string. proxy.ts gates the whole admin root
// before the page runs; the check below is the belt to that suspenders —
// exactly the guard the static sibling carries.
export const dynamic = "force-dynamic";

export default async function SecretAdminDeviceDeepLinkPage() {
  const session = await getAdminSession();
  if (!session) redirect(ADMIN_LOGIN_PATH);

  return (
    <div className="min-h-screen bg-zinc-100 dark:bg-zinc-950">
      <main className="mx-auto max-w-6xl p-6">
        <SecretDevicesHost adminPath={ADMIN_PATH} />
      </main>
    </div>
  );
}
