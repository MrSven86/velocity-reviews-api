// REFRESH ENDPOINT — called by Vercel Cron every 2 weeks
// Triggers a separate scrape for each client in the registry.
// Each scrape runs as its own function call (own timeout).
//
// Manual trigger: /api/refresh
// Cron: automatic via vercel.json

import { clients } from "../clients.js";

export const maxDuration = 60;

export default async function handler(req, res) {
  // Verify cron secret if called by Vercel Cron
  // (prevents random people from triggering mass scrapes)
  const authHeader = req.headers.authorization;
  const isVercelCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const isManual = req.query.secret === process.env.CRON_SECRET;

  // Allow without auth if no CRON_SECRET is set (for testing)
  if (process.env.CRON_SECRET && !isVercelCron && !isManual) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (clients.length === 0) {
    return res.status(200).json({
      message: "No clients in registry. Add clients to clients.js",
    });
  }

  const baseUrl = `https://${req.headers.host}`;
  const triggered = [];

  // Fire-and-forget: trigger each scrape without waiting for it to finish.
  // Each scrape runs as its own serverless function with its own 120s timeout.
  // We batch 3 at a time to avoid overwhelming Apify.

  const BATCH_SIZE = 3;

  for (let i = 0; i < clients.length; i += BATCH_SIZE) {
    const batch = clients.slice(i, i + BATCH_SIZE);

    const promises = batch.map((client) => {
      const param = client.url ? `url=${encodeURIComponent(client.url)}` : `query=${encodeURIComponent(client.query)}`;
      const scrapeUrl = `${baseUrl}/api/scrape?platform=google&${param}&client=${client.id}&limit=${client.limit || 8}`;

      // Fire the request — don't wait for full response
      return fetch(scrapeUrl)
        .then(() => ({ client: client.id, status: "triggered" }))
        .catch(() => ({ client: client.id, status: "trigger_failed" }));
    });

    const results = await Promise.allSettled(promises);

    for (const result of results) {
      triggered.push(result.status === "fulfilled" ? result.value : { status: "failed" });
    }

    // Small delay between batches to be nice to Apify
    if (i + BATCH_SIZE < clients.length) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  return res.status(200).json({
    message: `Refresh triggered for ${clients.length} clients (${BATCH_SIZE} at a time)`,
    timestamp: new Date().toISOString(),
    triggered,
  });
}
