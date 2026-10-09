import type { DatabaseSync } from "node:sqlite";
import { deliveriesSince } from "./clock.ts";
import { all, ensureListingIndexes, get } from "./db.ts";

export type CreatorMatch = {
  id: string;
  name: string;
  niche_score: number;
  latest_reach: number;
  deliveries_90d: number;
};

export type CreatorPage = {
  campaign_id: string;
  total: number;
  creators: CreatorMatch[];
};

type CampaignRow = { niches_json: string };
type CreatorPageRow = {
  id: string;
  name: string;
  niche_score: number;
  latest_reach: number;
  deliveries_90d: number;
  total: number;
};
type CountRow = { n: number };

const PAGE_SQL = `
SELECT id, name, niche_score, latest_reach, deliveries_90d, COUNT(*) OVER() AS total
FROM (
  SELECT
    c.id AS id,
    c.name AS name,
    (
      SELECT COUNT(*)
      FROM json_each(c.niches_json) AS cn
      JOIN json_each(?) AS camp ON camp.value = cn.value
    ) AS niche_score,
    COALESCE(
      (
        SELECT SUM(
          (
            SELECT m.views
            FROM metrics AS m
            WHERE m.account_id = sa.id
            ORDER BY m.captured_at DESC, m.id DESC
            LIMIT 1
          )
        )
        FROM social_accounts AS sa
        WHERE sa.creator_id = c.id
      ),
      0
    ) AS latest_reach,
    (
      SELECT COUNT(*)
      FROM deliveries AS d
      WHERE d.creator_id = c.id AND d.delivered_at >= ?
    ) AS deliveries_90d
  FROM creators AS c
)
WHERE niche_score > 0
ORDER BY niche_score DESC, latest_reach DESC, id ASC
LIMIT ? OFFSET ?
`;

const TOTAL_SQL = `
SELECT COUNT(*) AS n
FROM creators AS c
WHERE (
  SELECT COUNT(*)
  FROM json_each(c.niches_json) AS cn
  JOIN json_each(?) AS camp ON camp.value = cn.value
) > 0
`;

export async function listCreators(
  db: DatabaseSync,
  input: { campaignId: string; limit: number; offset: number },
): Promise<CreatorPage | null> {
  const campaign = await get<CampaignRow>(
    db,
    "SELECT niches_json FROM campaigns WHERE id = ?",
    input.campaignId,
  );
  if (!campaign) return null;

  await ensureListingIndexes(db);
  const since = deliveriesSince();
  const rows = await all<CreatorPageRow>(
    db,
    PAGE_SQL,
    campaign.niches_json,
    since,
    input.limit,
    input.offset,
  );

  let total = rows[0] !== undefined ? Number(rows[0].total) : 0;
  if (rows.length === 0) {
    const counted = await get<CountRow>(db, TOTAL_SQL, campaign.niches_json);
    total = Number(counted?.n ?? 0);
  }

  return {
    campaign_id: input.campaignId,
    total,
    creators: rows.map((row) => ({
      id: row.id,
      name: row.name,
      niche_score: Number(row.niche_score),
      latest_reach: Number(row.latest_reach),
      deliveries_90d: Number(row.deliveries_90d),
    })),
  };
}
