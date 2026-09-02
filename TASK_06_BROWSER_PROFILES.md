# SpaceWorker Task 6 — Browser Profiles (Phase 1)

**Assigned to Michael.** This task is independent of Tasks 2–5 (it only touches the worker layer, not the queue or extraction engine). Can be built in parallel with Task 5 once Task 1 is merged on `main`. Phase 1 uses persistent per-user profiles on shared hardware; Phase 1.5 (post-funding) upgrades to per-user VMs/containers with isolated IPs.

**Read `PLAN.md` first** for full product context — you don't need the whole thing, but the "Why BYO SMTP" section explains why user isolation matters even in v1.

## What this is, in one paragraph

Today, when the extraction worker launches a browser (Playwright → Chromium), each job gets a fresh throwaway profile with no stored sessions, cookies, or history. This means every authenticated source requires login per job, and we can't use site-specific stored auth. Phase 1 fixes this by giving each user a persistent Chrome profile directory on disk (`/mnt/browser-profiles/{userId}/`), so repeated jobs from the same user share cookies, sessions, and history — **without needing external proxy services or VM infrastructure**. Jobs still use throwaway temporary directories for isolation, but the browser profile itself persists across jobs. This gives the appearance of a "personal browser" to each user while keeping everything on shared hardware.

## Prisma schema

```prisma
model User {
  // ...existing fields...
  browserProfiles BrowserProfile[]
}

model BrowserProfile {
  id          String   @id @default(cuid())
  userId      String
  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  profilePath String   // absolute path, e.g. /mnt/browser-profiles/{userId}
  createdAt   DateTime @default(now())
  lastUsedAt  DateTime @updatedAt
  
  @@unique([userId])
  @@index([userId])
}
```

Add `browserProfiles BrowserProfile[]` to `User`. Migration via `npx prisma migrate dev --name add_browser_profiles`.

## New utility — `lib/browser-profiles.ts` (server-only)

```ts
import "server-only";

import { db } from "./db";
import { mkdir } from "fs/promises";
import { join } from "path";

const BROWSER_PROFILES_BASE = "/mnt/browser-profiles";

export interface BrowserProfileInfo {
  userId: string;
  profilePath: string;
}

/**
 * Get or create a persistent browser profile directory for a user.
 * If the profile already exists, return its path and update lastUsedAt.
 * If not, create the directory, create a DB row, and return the path.
 *
 * The directory itself is NOT automatically cleaned up — it persists across
 * jobs so the same user's repeated queries share cookies, sessions, history, etc.
 * This is Phase 1; Phase 1.5 (post-funding) adds per-VM isolation and
 * cleanup policies.
 */
export async function getOrCreateBrowserProfile(userId: string): Promise<BrowserProfileInfo> {
  const existing = await db.browserProfile.findUnique({ where: { userId } });
  if (existing) {
    // Update lastUsedAt
    await db.browserProfile.update({
      where: { userId },
      data: { lastUsedAt: new Date() },
    });
    return { userId, profilePath: existing.profilePath };
  }

  // Create new profile directory and DB row
  const profilePath = join(BROWSER_PROFILES_BASE, userId);
  try {
    await mkdir(profilePath, { recursive: true, mode: 0o755 });
  } catch (err) {
    throw new Error(`Failed to create browser profile directory ${profilePath}: ${err}`);
  }

  try {
    await db.browserProfile.create({
      data: {
        userId,
        profilePath,
        lastUsedAt: new Date(),
      },
    });
  } catch (err) {
    throw new Error(`Failed to create browser profile record: ${err}`);
  }

  return { userId, profilePath };
}

/**
 * List all browser profiles (for admin inspection, optional).
 */
export async function listBrowserProfiles(limit = 100) {
  return db.browserProfile.findMany({
    take: limit,
    orderBy: { lastUsedAt: "desc" },
  });
}
```

## Integration with `worker/automation_server.py`

The extraction engine already launches Playwright via a function called `_launch_browser()` (or similar). Update that function to accept a `browser_profile_path` parameter and pass it to Playwright:

```python
import asyncio
from playwright.async_api import async_playwright

async def _launch_browser(browser_profile_path: str):
    """
    Launch Chromium with a persistent user profile.
    
    Args:
      browser_profile_path: absolute path to the user's profile directory,
                            e.g. /mnt/browser-profiles/{userId}
    """
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            args=[
                f"--user-data-dir={browser_profile_path}",
            ],
            headless=True,
        )
        return browser
```

The caller (in `worker/api.py`, the job handler) should:
1. Fetch the user ID from the job params (or from a JWT/auth token sent with the POST /jobs request)
2. Call `getOrCreateBrowserProfile(userId)` via a Node server-side endpoint or a direct DB query (if you wire Python DB access — see "Open questions" below)
3. Pass the returned `profilePath` to the extraction engine
4. Launch jobs as today, but with the profile path injected

## Phase 1 scope (this task)

- ✅ Prisma model and migration
- ✅ `lib/browser-profiles.ts` utility (get or create)
- ✅ Update extraction engine to accept and use `browser_profile_path`
- ✅ Wire job handler in `worker/api.py` to fetch profile path before launching browser
- ✅ Verification that profiles persist across jobs from the same user

## Phase 1.5 scope (post-funding, separate task — do NOT build this now)

- Per-user VMs or containerized agents
- Network isolation (each user's container gets its own IP via proxy pool)
- Cleanup policy (delete profiles older than X days)
- Monitor profile disk usage

## Verification

1. **Profile creation**: Fire a job from User A. Confirm `/mnt/browser-profiles/{userA}` directory exists and contains Chromium cache/profile files.
2. **Profile reuse**: Fire a second job from User A with a different query. Confirm the same profile directory is reused (check `lastUsedAt` timestamp in DB).
3. **User isolation**: Fire a job from User B. Confirm `/mnt/browser-profiles/{userB}` is a separate directory.
4. **Cookie persistence**: Manually inject a test cookie into User A's profile before job start (via a Playwright script or direct file edit in the profile). Run User A's job. Confirm the job can read the cookie. Run User B's job and confirm it cannot see User A's cookie.
5. **Directory structure**: List profiles and confirm each is a standard Chromium user-data-dir with `Default/` subdirectory, `Preferences` file, etc.

## Open questions for implementation

1. **Python-side DB access**: Should the extraction engine call back to Node.js to fetch the profile path (via an internal API endpoint), or should the `worker/api.py` job handler fetch the profile path in Node and pass it as a job parameter? (Recommended: pass as parameter to avoid Python DB dependency.)
2. **Disk usage limits**: Phase 1 has no cleanup. Should we document expected disk space per user (typically 50–200MB per profile depending on site data cached)? Phase 1.5 will add a cleanup policy.
3. **Permission/ownership**: Profiles are created with mode `0o755`. Should the process running the extraction worker own them, or a shared `browser` user? (Simple: same user that runs the worker; revisit in Phase 1.5 when containerizing.)

## Repo access

Push to `main` (this is documentation, not code changes yet). Code changes land in PRs to `main` after review.
