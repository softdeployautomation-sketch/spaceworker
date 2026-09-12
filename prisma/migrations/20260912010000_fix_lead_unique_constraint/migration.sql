-- Fix Lead's unique constraint: (searchJobId, sourceUrl) alone meant at most
-- ONE lead could ever be saved per page/PDF per job, silently discarding
-- every other email a rich document contains via createMany's
-- skipDuplicates. Confirmed live: a real 105-email membership-directory PDF
-- extracted correctly but only 1 row ever reached the database. Widening to
-- (searchJobId, sourceUrl, email) is strictly more permissive than the old
-- constraint -- any existing rows already unique under the old key remain
-- unique under the new one, so this cannot conflict with existing data.
DROP INDEX "Lead_searchJobId_sourceUrl_key";
CREATE UNIQUE INDEX "Lead_searchJobId_sourceUrl_email_key" ON "Lead"("searchJobId", "sourceUrl", "email");
