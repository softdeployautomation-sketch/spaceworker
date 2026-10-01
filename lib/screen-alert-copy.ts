// TASK_152 M5 — pure copy/label helpers for the Screen monitoring ALERTS card.
//
// WHY THIS IS ITS OWN MODULE (and not just functions inside the card): the card
// is a `"use client"` component that imports React and lucide-react, so it
// cannot be loaded in a plain node test (react-server build has no createContext
// => lucide-react throws at import time). These three helpers are pure string
// logic with NO React / DB / browser / Next dependency, so keeping them here is
// what lets tests/screen-notifications.test.ts pin the exact "off means off"
// wording against the REAL functions instead of a paraphrase. The card imports
// them from here. Nothing in this file may gain a client/server dependency.

export interface ScreenAlertsPrefs {
  triggersEnabled: boolean;
  digestEnabled: boolean;
  digestIntervalMinutes: number;
}

/** The one-line state of the whole feature, in plain words. Never optimistic. */
export function screenAlertsStateCopy(prefs: ScreenAlertsPrefs): string {
  if (!prefs.triggersEnabled && !prefs.digestEnabled) {
    return "Alerts are OFF. Nothing will be sent about your monitored screens.";
  }
  if (prefs.triggersEnabled && prefs.digestEnabled) {
    return "Alerts are ON: you'll be told when a screen matches a trigger, plus a periodic digest.";
  }
  return prefs.triggersEnabled
    ? "Triggers are ON. The periodic digest is OFF."
    : "The periodic digest is ON. Triggers are OFF.";
}

/** Human cadence label for a digest interval in minutes. */
export function digestCadenceLabel(minutes: number): string {
  if (minutes % 1440 === 0) {
    const d = minutes / 1440;
    return `every ${d} day${d === 1 ? "" : "s"}`;
  }
  if (minutes % 60 === 0) {
    const h = minutes / 60;
    return `every ${h} hour${h === 1 ? "" : "s"}`;
  }
  return `every ${minutes} minutes`;
}

/** Human cooldown label. */
export function cooldownLabel(minutes: number): string {
  if (minutes % 60 === 0) {
    const h = minutes / 60;
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  return `${minutes} minutes`;
}
