import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { transporterForMailbox } from "@/lib/mailer-send";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params; // MUST await — async in Next.js 16

  const mailbox = await prisma.mailbox.findFirst({
    where: { id, userId: session.userId },
  });
  if (!mailbox) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let ok = false;
  let error: string | undefined;
  try {
    const transport = transporterForMailbox(mailbox);
    await transport.verify();
    ok = true;
  } catch (e) {
    error = e instanceof Error ? e.message : "Unknown error";
  }

  await prisma.mailbox.update({
    where: { id: mailbox.id },
    data: { lastTestedAt: new Date(), lastTestOk: ok },
  });

  return NextResponse.json({ ok, error });
}