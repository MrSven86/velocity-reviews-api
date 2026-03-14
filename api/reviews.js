// REVIEWS ENDPOINT — serves cached reviews from Vercel KV
// Instant loading, zero cost per visitor.
//
// Usage: /api/reviews?client=colormaster

import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const { client } = req.query;

  if (!client) {
    // List all available clients
    try {
      const keys = await kv.keys("reviews:*");
      const clients = keys.map((k) => k.replace("reviews:", ""));
      return res.status(200).json({
        message: "Provide a 'client' parameter",
        usage: "/api/reviews?client=colormaster",
        availableClients: clients,
      });
    } catch (e) {
      return res.status(400).json({
        error: "Missing 'client' parameter",
        usage: "/api/reviews?client=colormaster",
      });
    }
  }

  const safeName = client.replace(/[^a-zA-Z0-9-]/g, "").toLowerCase();

  try {
    const data = await kv.get(`reviews:${safeName}`);

    if (!data) {
      return res.status(404).json({
        error: `No reviews found for '${safeName}'`,
        hint: `Scrape first: /api/scrape?platform=google&query=Business+Name+City&client=${safeName}`,
      });
    }

    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: "Failed to read reviews", details: error.message });
  }
}
