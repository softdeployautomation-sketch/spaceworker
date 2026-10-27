import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session-user";
import { fetchClineRecommendedModels } from "@cline/sdk";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const data = await fetchClineRecommendedModels();
    const freeModels = (data.free ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      tags: m.tags ?? [],
    }));

    return NextResponse.json({
      free: freeModels,
      count: freeModels.length,
    });
  } catch (err) {
    // Fallback to a small set of known free Cline models if the network call fails
    return NextResponse.json({
      free: [
        { id: "cline-free/nemotron-3.5-super-vl", name: "Nemotron 3.5 Super VL", description: "NVIDIA Nemotron 3.5 Super VL (free tier)", tags: ["free", "vision"] },
        { id: "cline-free/nemotron-3.5-lightning", name: "Nemotron 3.5 Lightning", description: "NVIDIA Nemotron 3.5 Lightning (free tier)", tags: ["free"] },
        { id: "cline-free/solar-mini-4", name: "Solar Mini 4", description: "Upstage Solar Mini 4 (free tier)", tags: ["free"] },
        { id: "cline-free/beam", name: "Beam", description: "Beam model (free tier)", tags: ["free"] },
      ],
      count: 4,
      fallback: true,
    });
  }
}