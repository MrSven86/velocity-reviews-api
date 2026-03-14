// SCRAPE ENDPOINT — scrapes reviews ONCE and saves them to Vercel KV
// Only used by YOU, not by visitors.
//
// Usage:
//   /api/scrape?platform=google&query=Color+Masters+Painting+Dallas+TX&client=colormaster&limit=10
//   /api/scrape?platform=homeadvisor&url=https://www.homeadvisor.com/rated.ColormasterPainting.50192468.html&client=colormaster&limit=10
//   /api/scrape?platform=yelp&query=Color+Masters+Painting+Long+Branch+NJ&client=colormaster&limit=10

import { kv } from "@vercel/kv";

export const maxDuration = 120; // Allow up to 2 minutes for scraping

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const { platform = "google", url, query, client, limit = "10" } = req.query;
  const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN;

  if (!APIFY_API_TOKEN) return res.status(500).json({ error: "APIFY_API_TOKEN not set" });
  if (!client) return res.status(400).json({ error: "Missing 'client' param. Example: &client=colormaster" });

  const safeName = client.replace(/[^a-zA-Z0-9-]/g, "").toLowerCase();

  try {
    let reviews = [];
    let source = platform;

    // ==========================================================
    // GOOGLE
    // ==========================================================
    if (platform === "google") {
      if (!query) return res.status(400).json({ error: "Google requires 'query' param" });
      source = "Google";

      const data = await runApifyActor("compass~crawler-google-places", {
        searchStringsArray: [query],
        maxReviews: parseInt(limit),
        language: "en",
        maxCrawledPlacesPerSearch: 1,
      }, APIFY_API_TOKEN);

      if (Array.isArray(data) && data.length > 0 && data[0].reviews) {
        reviews = data[0].reviews.slice(0, parseInt(limit)).map((r) => ({
          author: r.name || r.author || "Anonymous",
          rating: r.stars || r.rating || 5,
          text: r.text || r.reviewText || "",
          date: r.publishedAtDate || r.date || "",
          source: "Google",
          profilePhoto: r.reviewerPhotoUrl || r.profilePhoto || null,
        }));
      }

    // ==========================================================
    // HOMEADVISOR
    // ==========================================================
    } else if (platform === "homeadvisor") {
      if (!url) return res.status(400).json({ error: "HomeAdvisor requires 'url' param" });
      source = "HomeAdvisor";

      const data = await runApifyActor("alizarin_refrigerator-owner~homeadvisor-scraper", {
        startUrls: [{ url }],
      }, APIFY_API_TOKEN);

      if (Array.isArray(data) && data.length > 0) {
        const business = data[0];
        const rawReviews = business.reviews || business.reviewsData || data;

        if (Array.isArray(rawReviews)) {
          const seen = new Set();
          reviews = rawReviews
            .filter((r) => {
              const text = r.text || r.reviewText || r.comment || r.body || "";
              const key = text.substring(0, 60).toLowerCase();
              if (!key || seen.has(key)) return false;
              seen.add(key);
              return text.length >= 20;
            })
            .slice(0, parseInt(limit))
            .map((r) => ({
              author: r.author || r.reviewerName || r.name || "Homeowner",
              rating: r.rating || r.stars || r.reviewRating || 5,
              text: r.text || r.reviewText || r.comment || r.body || "",
              date: r.date || r.reviewDate || "",
              source: "HomeAdvisor",
              profilePhoto: null,
            }));
        }
      }

    // ==========================================================
    // YELP
    // ==========================================================
    } else if (platform === "yelp") {
      if (!url && !query) return res.status(400).json({ error: "Yelp requires 'url' or 'query'" });
      source = "Yelp";

      const data = await runApifyActor("yin~yelp-scraper", {
        searchTerms: [query || url],
        maxReviews: parseInt(limit),
        maxItems: 1,
      }, APIFY_API_TOKEN);

      if (Array.isArray(data) && data.length > 0) {
        const rawReviews = data[0].reviews || data;
        if (Array.isArray(rawReviews)) {
          reviews = rawReviews.slice(0, parseInt(limit)).map((r) => ({
            author: r.userName || r.user?.name || r.author || "Anonymous",
            rating: r.rating || 5,
            text: r.comment || r.text || r.reviewText || "",
            date: r.date || r.localizedDate || "",
            source: "Yelp",
            profilePhoto: r.userAvatarUrl || null,
          }));
        }
      }

    } else {
      return res.status(400).json({ error: `Unknown platform: ${platform}. Use: google, homeadvisor, yelp` });
    }

    // Save to Vercel KV
    const output = {
      success: true,
      source,
      client: safeName,
      count: reviews.length,
      scrapedAt: new Date().toISOString(),
      reviews,
    };

    await kv.set(`reviews:${safeName}`, output);

    return res.status(200).json({
      ...output,
      message: `Saved ${reviews.length} reviews for '${safeName}'. Now available at /api/reviews?client=${safeName}`,
    });

  } catch (error) {
    console.error("Scrape error:", error);
    return res.status(500).json({ error: "Scrape failed", details: error.message });
  }
}

async function runApifyActor(actorId, input, token) {
  const response = await fetch(
    `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${token}&timeout=120`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }
  );
  return response.json();
}
