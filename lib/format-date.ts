// Task 26, Piece 7d — shared relative-time formatting. First written for Piece 5a's
// mailbox "last tested" caption in components/mailboxes-panel.tsx; lifted into a
// shared lib so that component and the Extract page's job-date captions (Piece 7d)
// both use the SAME helper instead of two divergent date formatters.
//
// Coarse by design ("just now" / "Nm ago" / "Nh ago" / "Nd ago") — this is for
// throwaway captions, not a human calendar, so it never needs more precision than
// the biggest useful unit for a job or a mailbox test (days).
export function timeAgo(iso: string): string {
  const seconds = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}