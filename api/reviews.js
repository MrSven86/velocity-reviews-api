// Vercel Serverless Function — Cached Review Server
// Serves pre-scraped reviews INSTANTLY from JSON files. No live scraping per visit.
//
// USAGE:
//   /api/reviews?client=colormaster        → serves data/colormaster.json
//   /api/reviews?client=anchor-painting    → serves data/anchor-painting.json
//
// HOW TO ADD A NEW CLIENT:
//   1. Scrape reviews once (via Apify dashboard or the /api/scrape endpoint)
//   2. Save the JSON as data/{client-name}.json in the GitHub repo
//   3. Vercel auto-deploys — done. Instant loading forever.

import { readFileSync } from "fs";
import { join } from "path";

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  // Cache for 1 hour at CDN level — truly instant for repeat visitors
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const { client } = req.query;

  if (!client) {
    return res.status(400).json({
      error: "Missing 'client' parameter",
      usage: "/api/reviews?client=colormaster",
      hint: "The client name must match a JSON file in the data/ folder",
    });
  }

  // Sanitize client name — only allow letters, numbers, dashes
  const safeName = client.replace(/[^a-zA-Z0-9-]/g, "");

  try {
    // Read the cached JSON file
    const filePath = join(process.cwd(), "data", `${safeName}.json`);
    const fileContent = readFileSync(filePath, "utf8");
    const data = JSON.parse(fileContent);

    return res.status(200).json(data);
  } catch (error) {
    return res.status(404).json({
      error: `No reviews found for client '${safeName}'`,
      hint: `Create a file at data/${safeName}.json in your GitHub repo`,
    });
  }
}
