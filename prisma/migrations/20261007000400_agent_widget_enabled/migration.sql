-- The floating agent widget's own mute switch. Default true (pure UI
-- convenience, no side effect of its own).
ALTER TABLE "User" ADD COLUMN "agentWidgetEnabled" BOOLEAN NOT NULL DEFAULT true;
