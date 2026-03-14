// Vercel Serverless Function — Review Fetcher with Debug Mode
//
// NORMAL:  /api/reviews?platform=homeadvisor&url=...&limit=6
// DEBUG:   /api/reviews?platform=homeadvisor&url=...&debug=true
// GOOGLE:  /api/reviews?platform=google&query=Business+Name+City+ST&limit=6

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const { platform = "google", url, query, limit = "10", debug } = req.query;
  const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN;

  if (!APIFY_API_TOKEN) {
    return res.status(500).json({ error: "APIFY_API_TOKEN not set" });
  }

  try {
    let reviews = [];

    // ==========================================================
    // GOOGLE
    // ==========================================================
    if (platform === "google") {
      if (!query) return res.status(400).json({ error: "Google requires 'query' param" });

      const actorId = "compass~crawler-google-places";
      const data = await runApifyActor(actorId, {
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

      const reviewUrl = url.includes("#reviews") ? url : url.replace(/\.html.*$/, ".html#reviews");
      const actorId = "apify~web-scraper";

      const pageFunction = `
async function pageFunction(context) {
  const { page, request, log } = context;

  // Scroll to trigger lazy loads
  for (let i = 0; i < 15; i++) {
    await page.evaluate(() => window.scrollBy(0, 600));
    await new Promise(r => setTimeout(r, 1000));
  }
  await new Promise(r => setTimeout(r, 5000));

  const result = await page.evaluate(() => {
    const debug = {};
    debug.title = document.title;
    debug.url = window.location.href;
    debug.bodyLength = document.body.innerHTML.length;

    // Capture what classes exist on the page
    const allClasses = new Set();
    document.querySelectorAll('*').forEach(el => {
      el.classList.forEach(c => {
        if (c.toLowerCase().includes('review')) allClasses.add(c);
      });
    });
    debug.reviewClasses = [...allClasses].slice(0, 50);

    // Capture JSON-LD data
    const jsonLdData = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
      try {
        const d = JSON.parse(s.textContent);
        jsonLdData.push(JSON.stringify(d).substring(0, 500));
      } catch(e) {}
    });
    debug.jsonLd = jsonLdData;

    // Capture any elements with "review" in class/id
    const reviewEls = document.querySelectorAll('[class*="review"], [class*="Review"], [id*="review"], [id*="Review"]');
    debug.reviewElementCount = reviewEls.length;
    debug.reviewElementSamples = [];
    reviewEls.forEach((el, i) => {
      if (i < 10) {
        debug.reviewElementSamples.push({
          tag: el.tagName,
          class: el.className.substring(0, 100),
          id: el.id,
          textLength: el.textContent.length,
          textPreview: el.textContent.substring(0, 200).trim(),
          childCount: el.children.length,
        });
      }
    });

    // ---- Now try to extract actual reviews ----
    const reviews = [];

    // METHOD 1: JSON-LD
    document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
      try {
        let dataList = JSON.parse(script.textContent);
        if (!Array.isArray(dataList)) dataList = [dataList];
        for (const data of dataList) {
          const items = data['@graph'] ? data['@graph'] : [data];
          for (const item of items) {
            const revs = item.review || item.reviews || [];
            const arr = Array.isArray(revs) ? revs : [revs];
            for (const r of arr) {
              if (r && (r.reviewBody || r.description || r.text)) {
                reviews.push({
                  author: (typeof r.author === 'string' ? r.author : r.author?.name) || '',
                  rating: parseFloat(r.reviewRating?.ratingValue || 5),
                  text: (r.reviewBody || r.description || r.text || '').substring(0, 500),
                  date: r.datePublished || r.dateCreated || '',
                  method: 'jsonld',
                });
              }
            }
          }
        }
      } catch(e) {}
    });

    // METHOD 2: Look for review containers
    if (reviews.length === 0) {
      reviewEls.forEach((container, i) => {
        if (i >= 20) return;
        const text = container.textContent.trim();
        if (text.length >= 50 && text.length < 3000 && container.children.length < 30) {
          // Try to find author within
          let author = '';
          const nameEl = container.querySelector('h4, h5, [class*="name"], [class*="Name"], [class*="author"], [class*="Author"]');
          if (nameEl) author = nameEl.textContent.trim().substring(0, 60);

          // Try to find rating
          let rating = 5;
          const ratingEl = container.querySelector('[aria-label*="star"], [aria-label*="rating"], [class*="rating"], [class*="star"]');
          if (ratingEl) {
            const m = (ratingEl.getAttribute('aria-label') || ratingEl.textContent || '').match(/(\\d+\\.?\\d*)/);
            if (m) rating = Math.min(parseFloat(m[1]), 5);
          }

          // Try to find date
          let date = '';
          const dateEl = container.querySelector('time, [class*="date"], [class*="Date"]');
          if (dateEl) date = (dateEl.getAttribute('datetime') || dateEl.textContent || '').trim().substring(0, 30);

          reviews.push({
            author: author || 'Unknown',
            rating,
            text: text.substring(0, 500),
            date,
            method: 'dom',
          });
        }
      });
    }

    return { debug, reviews };
  });

  return result;
}
      `;

      const data = await runApifyActor(actorId, {
        startUrls: [{ url: reviewUrl }],
        pageFunction: pageFunction,
        proxyConfiguration: { useApifyProxy: true },
        maxRequestsPerCrawl: 1,
        preNavigationHooks: `[
          async ({ page }, goToOptions) => {
            goToOptions.waitUntil = 'networkidle2';
            goToOptions.timeout = 90000;
          }
        ]`,
      }, APIFY_API_TOKEN);

      // If debug mode, return everything
      if (debug) {
        return res.status(200).json({
          raw: data,
          note: "This is debug output. Check raw[0].debug for page info and raw[0].reviews for extracted reviews.",
        });
      }

      // Normal mode - extract reviews
      if (Array.isArray(data) && data.length > 0 && data[0].reviews) {
        const seen = new Set();
        reviews = data[0].reviews
          .filter((r) => {
            const key = (r.text || '').substring(0, 60).toLowerCase().replace(/\s+/g, '');
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return (r.text || '').length >= 30;
          })
          .slice(0, parseInt(limit))
          .map((r) => ({
            author: r.author || "Verified Customer",
            rating: r.rating || 5,
            text: r.text,
            date: r.date || "",
            source: "HomeAdvisor",
            profilePhoto: null,
          }));
      }

    } else {
      return res.status(400).json({ error: `Unknown platform: ${platform}` });
    }

    return res.status(200).json({
      success: true,
      platform,
      url: url || query,
      count: reviews.length,
      reviews,
    });

  } catch (error) {
    console.error("Review fetch error:", error);
    return res.status(500).json({ error: "Failed to fetch reviews", details: error.message });
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
