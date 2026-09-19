"use client";

// navigator.clipboard.writeText() needs a secure context AND a live user
// gesture, and silently rejects outside either (an http:// admin URL, a
// permissions-policy-restricted embed, some browser privacy settings) --
// confirmed live: "Copy failed" firing for a real admin user on a real
// license key. document.execCommand("copy") is deprecated but works in
// strictly more places (no secure-context requirement), so it's the fallback
// here rather than just giving up and telling people to select manually.
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // fall through to the legacy path below
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    // Off-screen but still focusable/selectable -- display:none elements
    // can't be selected, which execCommand("copy") requires.
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}
