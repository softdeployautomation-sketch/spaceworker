"use client";

import { useState } from "react";

import { DevicesTab } from "@/components/admin/devices-tab";

// TASK_188 S2 — client half of the private devices page. The extracted
// DevicesTab is the SAME component the admin panel used to render (props and
// API calls untouched); only the owner state moved here, because the page that
// hosts it is a server component and cannot hold state itself.
//
// adminPath is threaded through as a PROP (TASK_195 S4): this host is a
// client component, so the secret path may arrive only from its server page,
// never be hardcoded here (build-leak tripwire).
export function SecretDevicesHost({ adminPath }: { adminPath: string }) {
  const [owner, setOwner] = useState<{ id: string; email: string } | null>(null);
  return <DevicesTab owner={owner} onOwnerChange={setOwner} adminPath={adminPath} />;
}
