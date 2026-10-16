import { redirect } from "next/navigation";

// Hidden-login / invite-only: the Cyber Lab marketing tab routes through the
// gated `/home`, which bounces unauthorized visitors to the public clown
// page. The lab itself (layout + /cyberlab/replay/*) is session-entitled
// and unchanged.
export default function CyberLabPage() {
  redirect("/home");
}
