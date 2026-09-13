-- Task 37 — persist an assistant message's inline structured pick (lead-source
-- dropdown, upload dropzone, or mailbox picker) as a JSON snapshot so a chat
-- reload renders the widget instead of losing it. Additive; existing rows are
-- unchanged (null). Mutually exclusive with the toolCall snapshot — a turn
-- either proposes something or asks a structured question, never both.
ALTER TABLE "AgentMessage" ADD COLUMN "inlineWidget" JSONB;