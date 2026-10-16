import { redirect } from "next/navigation";

// Hidden-login / invite-only: marketing subtabs route through the gated
// `/home`, which bounces unauthorized visitors to the public clown page.
export default function PricingPage() {
  redirect("/home");
}
