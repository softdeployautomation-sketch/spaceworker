"use client";

import { useState } from "react";

import { DevicesTab } from "@/components/admin/devices-tab";

// TASK_188 S2 — client half of the private devices page. The extracted
// DevicesTab is the SAME component the admin panel used to render (props and
// API calls untouched); only the owner state moved here, because the page that
// hosts it is a server component and cannot hold state itself.
export function SecretDevicesHost() {
  const [owner, setOwner] = useState<{ id: string; email: string } | null>(null);
  return <DevicesTab owner={owner} onOwnerChange={setOwner} />;
}
