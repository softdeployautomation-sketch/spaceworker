import { CyberLabReplayPlayer } from "@/components/cyberlab-replay-player";

// TASK_156B S7-A — /cyberlab/replay/[id] renders INSIDE app/cyberlab/layout.tsx
// (same .lab-ops identity as the console). Auth, ownership and signature
// verification happen server-side in the episodes/[id] API the player calls —
// a foreign id 404s there (404, never a 403 oracle), so this page itself
// carries no data and nothing sensitive in the URL.
export default async function CyberLabReplayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CyberLabReplayPlayer episodeId={id} />;
}
