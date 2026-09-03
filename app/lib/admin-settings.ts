import "server-only";
import { prisma } from "./prisma";

// Reads the AdminSetting singleton, creating it with schema defaults if missing.
// Wallet addresses are admin-configurable at runtime (no env vars required).
export async function getAdminSettings() {
  return prisma.adminSetting.upsert({
    where: { id: "singleton" },
    update: {},
    create: {},
  });
}