// Vercel Serverless Function — Universal Review Fetcher (Apify version)
// Pulls reviews from Google, Yelp, or Facebook via Apify actors.
// Deploy to Vercel just like your Resend contact form.

export default async function handler(req, res) {
  // Allow requests from any Lovable site
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ===== QUERY PARAMETERS =====
  // /api/reviews?platform=google&query=Rick+Wilson+Painting+Dallas+TX&limit=10
  const { platform = "google", query, limit = "10" } = req.query;

  if (!query) {
    return res.status(400).json({
      error: "Missing 'query' parameter. Example: ?query=Rick+Wilson+Painting+Dallas+TX",
    });
  }

  const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN;

  if (!APIFY_API_TOKEN) {
    return res.status(500).json({ error: "APIFY_API_TOKEN not set in environment variables" });
  }

  try {
    let reviews = [];

    if (platform === "google") {
      // ===== GOOGLE REVIEWS via Apify =====
      // Actor: compass/crawler-google-places (most popular Google Reviews scraper)
      const actorId = "compass~crawler-google-places";

      const runResponse = await fetch(
        `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${APIFY_API_TOKEN}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            searchStringsArray: [query],
            maxReviews: parseInt(limit),
            language: "en",
            maxCrawledPlacesPerSearch: 1,
          }),
        }
      );

      const data = await runResponse.json();

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

    } else if (platform === "yelp") {
      // ===== YELP REVIEWS via Apify =====
      const actorId = "yin~yelp-scraper";

      const runResponse = await fetch(
        `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${APIFY_API_TOKEN}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            searchTerms: [query],
            maxReviews: parseInt(limit),
            maxItems: 1,
          }),
        }
      );

      const data = await runResponse.json();

      if (Array.isArray(data) && data.length > 0) {
        const rawReviews = data[0].reviews || data;

        if (Array.isArray(rawReviews)) {
          reviews = rawReviews.slice(0, parseInt(limit)).map((r) => ({
            author: r.userName || r.user?.name || r.author || "Anonymous",
            rating: r.rating || 5,
            text: r.comment || r.text || r.reviewText || "",
            date: r.date || r.localizedDate || "",
            source: "Yelp",
            profilePhoto: r.userAvatarUrl || r.user?.photo || null,
          }));
        }
      }

    } else if (platform === "facebook") {
      // ===== FACEBOOK REVIEWS via Apify =====
      const actorId = "apify~facebook-reviews-scraper";

      const runResponse = await fetch(
        `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${APIFY_API_TOKEN}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            startUrls: [{ url: query }],
            maxReviews: parseInt(limit),
          }),
        }
      );

      const data = await runResponse.json();

      if (Array.isArray(data)) {
        reviews = data.slice(0, parseInt(limit)).map((r) => ({
          author: r.author?.name || r.reviewer || "Anonymous",
          rating: r.rating || (r.recommendation === "positive" ? 5 : 3),
          text: r.text || r.review || "",
          date: r.date || "",
          source: "Facebook",
          profilePhoto: r.author?.profilePhoto || null,
        }));
      }

    } else {
      return res.status(400).json({
        error: `Unknown platform: ${platform}. Use 'google', 'yelp', or 'facebook'.`,
      });
    }

    return res.status(200).json({
      success: true,
      business: query,
      platform,
      count: reviews.length,
      reviews,
    });

  } catch (error) {
    console.error("Review fetch error:", error);
    return res.status(500).json({
      error: "Failed to fetch reviews",
      details: error.message,
    });
  }
}
