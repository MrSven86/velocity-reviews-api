// Vercel Serverless Function — Review Fetcher
// Dedicated scrapers per platform for reliability.
//
// USAGE:
//   HomeAdvisor: /api/reviews?platform=homeadvisor&url=https://www.homeadvisor.com/rated.ColormasterPainting.50192468.html
//   Google:      /api/reviews?platform=google&query=Color+Masters+Painting+Dallas+TX
//   Yelp:        /api/reviews?platform=yelp&url=https://www.yelp.com/biz/some-business
//   BBB:         /api/reviews?platform=bbb&url=https://www.bbb.org/us/nj/some-business
//   Any site:    /api/reviews?platform=universal&url=https://example.com/reviews

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const { platform = "google", url, query, limit = "10" } = req.query;
  const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN;

  if (!APIFY_API_TOKEN) {
    return res.status(500).json({ error: "APIFY_API_TOKEN not set" });
  }

  try {
    let reviews = [];

    // ==========================================================
    // GOOGLE — dedicated actor, proven reliable
    // ==========================================================
    if (platform === "google") {
      if (!query) return res.status(400).json({ error: "Google requires 'query' param, e.g. ?platform=google&query=Business+Name+City+ST" });

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
    // HOMEADVISOR — Puppeteer scraper with custom extraction
    // ==========================================================
    } else if (platform === "homeadvisor") {
      if (!url) return res.status(400).json({ error: "HomeAdvisor requires 'url' param with the full business page URL" });

      // Make sure URL points to reviews section
      const reviewUrl = url.includes("#reviews") ? url : url.replace(/\.html.*$/, ".html#reviews");

      const actorId = "apify~web-scraper";

      const pageFunction = `
async function pageFunction(context) {
  const { page, request, log } = context;

  // Scroll down multiple times to trigger lazy-loaded reviews
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => window.scrollBy(0, 800));
    await new Promise(r => setTimeout(r, 1500));
  }

  // Additional wait for reviews to render
  await new Promise(r => setTimeout(r, 5000));

  const reviews = await page.evaluate(() => {
    const results = [];

    // ---- METHOD 1: JSON-LD structured data ----
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent);
        const items = data['@graph'] || [data];
        for (const item of items) {
          const revs = item.review || item.reviews || [];
          const arr = Array.isArray(revs) ? revs : [revs];
          for (const r of arr) {
            if (r && (r.reviewBody || r.description)) {
              results.push({
                author: (typeof r.author === 'string' ? r.author : r.author?.name) || '',
                rating: parseFloat(r.reviewRating?.ratingValue || 5),
                text: r.reviewBody || r.description || '',
                date: r.datePublished || r.dateCreated || '',
              });
            }
          }
        }
      } catch (e) {}
    }
    if (results.length > 0) return results;

    // ---- METHOD 2: HomeAdvisor specific selectors ----
    // Try multiple possible review container patterns
    const possibleContainers = [
      // Newer HA markup
      ...document.querySelectorAll('[class*="ReviewCard"], [class*="review-card"], [data-testid*="review"]'),
      // Reviews section items
      ...document.querySelectorAll('.ha-review, .review-item, [class*="ProReview"]'),
      // Generic review-like containers with enough text
      ...document.querySelectorAll('[class*="review"]'),
    ];

    // Deduplicate containers by reference
    const seen = new Set();
    const containers = [];
    for (const el of possibleContainers) {
      if (!seen.has(el)) {
        seen.add(el);
        containers.push(el);
      }
    }

    for (const container of containers) {
      // Skip tiny containers (nav items, headers, etc)
      if (container.textContent.length < 50) continue;
      // Skip if it contains many child review containers (it's a wrapper)
      const childReviews = container.querySelectorAll('[class*="review"]');
      if (childReviews.length > 3) continue;

      // Extract reviewer name - look for common patterns
      let author = '';
      const nameSelectors = [
        '[class*="reviewer"] [class*="name"]',
        '[class*="review-author"]',
        '[class*="ReviewerName"]',
        '[class*="author"]',
        'h4', 'h5',
        '[class*="Name"]',
      ];
      for (const sel of nameSelectors) {
        const el = container.querySelector(sel);
        if (el && el.textContent.trim().length > 1 && el.textContent.trim().length < 50) {
          author = el.textContent.trim();
          break;
        }
      }

      // Extract rating
      let rating = 5;
      const ratingEl = container.querySelector('[class*="rating"], [class*="star"], [aria-label*="star"], [aria-label*="rating"]');
      if (ratingEl) {
        const ariaLabel = ratingEl.getAttribute('aria-label') || '';
        const match = ariaLabel.match(/(\\d+\\.?\\d*)/);
        if (match) rating = parseFloat(match[1]);
        else {
          const textMatch = ratingEl.textContent.match(/(\\d+\\.?\\d*)\\s*(?:out of|of|stars|\\/)/i);
          if (textMatch) rating = parseFloat(textMatch[1]);
        }
        if (rating > 5) rating = 5;
      }

      // Extract review text - find the longest paragraph
      let text = '';
      const textSelectors = [
        '[class*="review-text"]',
        '[class*="ReviewText"]',
        '[class*="review-body"]',
        '[class*="review-content"]',
        '[class*="description"]',
        'p',
      ];
      for (const sel of textSelectors) {
        const els = container.querySelectorAll(sel);
        for (const el of els) {
          const t = el.textContent.trim();
          if (t.length > text.length && t.length > 20) {
            text = t;
          }
        }
      }

      // If we still don't have text, get all text and remove the author/rating parts
      if (!text) {
        text = container.textContent.trim();
        if (author) text = text.replace(author, '').trim();
        // Clean up
        text = text.replace(/^[\\s\\n]+|[\\s\\n]+$/g, '').replace(/\\n{2,}/g, ' ');
      }

      // Skip if text is too short
      if (text.length < 30) continue;

      // Extract date
      let date = '';
      const dateEl = container.querySelector('[class*="date"], time, [datetime]');
      if (dateEl) {
        date = dateEl.getAttribute('datetime') || dateEl.textContent.trim();
      }

      results.push({ author, rating, text, date });
    }

    if (results.length > 0) return results;

    // ---- METHOD 3: Extract ALL text blocks that look like reviews ----
    // Last resort: find any substantial text blocks near star icons
    const allElements = document.querySelectorAll('p, div, span');
    for (const el of allElements) {
      const t = el.textContent.trim();
      if (t.length >= 60 && t.length <= 2000) {
        // Check if nearby elements have star-related content
        const parent = el.parentElement;
        if (parent && parent.innerHTML.includes('star')) {
          results.push({
            author: '',
            rating: 5,
            text: t,
            date: '',
          });
        }
      }
    }

    return results;
  });

  return { url: request.url, reviews };
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

      if (Array.isArray(data) && data.length > 0 && data[0].reviews) {
        const seen = new Set();
        reviews = data[0].reviews
          .filter((r) => {
            const key = r.text.substring(0, 60).toLowerCase().replace(/\s+/g, '');
            if (seen.has(key)) return false;
            seen.add(key);
            return r.text.length >= 30;
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

    // ==========================================================
    // YELP — Puppeteer scraper
    // ==========================================================
    } else if (platform === "yelp") {
      if (!url) return res.status(400).json({ error: "Yelp requires 'url' param" });

      const actorId = "apify~web-scraper";
      const pageFunction = `
async function pageFunction(context) {
  const { page, request } = context;
  await new Promise(r => setTimeout(r, 5000));

  const reviews = await page.evaluate(() => {
    const results = [];
    // Try JSON-LD first
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent);
        const items = data['@graph'] || [data];
        for (const item of items) {
          const revs = item.review || [];
          const arr = Array.isArray(revs) ? revs : [revs];
          for (const r of arr) {
            if (r && r.reviewBody) {
              results.push({
                author: (typeof r.author === 'string' ? r.author : r.author?.name) || 'Anonymous',
                rating: parseFloat(r.reviewRating?.ratingValue || 5),
                text: r.reviewBody,
                date: r.datePublished || '',
              });
            }
          }
        }
      } catch (e) {}
    }
    return results;
  });
  return { url: request.url, reviews };
}
      `;

      const data = await runApifyActor(actorId, {
        startUrls: [{ url }],
        pageFunction,
        proxyConfiguration: { useApifyProxy: true },
        maxRequestsPerCrawl: 1,
      }, APIFY_API_TOKEN);

      if (Array.isArray(data) && data.length > 0 && data[0].reviews) {
        reviews = dedup(data[0].reviews).slice(0, parseInt(limit)).map(r => ({
          ...r, source: "Yelp", profilePhoto: null,
        }));
      }

    // ==========================================================
    // BBB — Puppeteer scraper
    // ==========================================================
    } else if (platform === "bbb") {
      if (!url) return res.status(400).json({ error: "BBB requires 'url' param" });

      const actorId = "apify~web-scraper";
      const pageFunction = `
async function pageFunction(context) {
  const { page, request } = context;
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollBy(0, 600));
    await new Promise(r => setTimeout(r, 1500));
  }
  await new Promise(r => setTimeout(r, 3000));

  const reviews = await page.evaluate(() => {
    const results = [];
    const containers = document.querySelectorAll('.customer-review, [class*="ReviewCard"], [class*="review-item"]');
    containers.forEach(c => {
      const text = (c.querySelector('[class*="review-text"], [class*="body"], p') || {}).textContent?.trim() || '';
      if (text.length < 20) return;
      const author = (c.querySelector('[class*="reviewer"], [class*="name"], h4') || {}).textContent?.trim() || '';
      const dateEl = c.querySelector('[class*="date"], time');
      const date = dateEl ? (dateEl.getAttribute('datetime') || dateEl.textContent.trim()) : '';
      let rating = 5;
      const ratingEl = c.querySelector('[class*="rating"], [class*="star"]');
      if (ratingEl) {
        const m = (ratingEl.getAttribute('aria-label') || ratingEl.textContent).match(/(\\d+\\.?\\d*)/);
        if (m) rating = Math.min(parseFloat(m[1]), 5);
      }
      results.push({ author, rating, text, date });
    });
    return results;
  });
  return { url: request.url, reviews };
}
      `;

      const data = await runApifyActor(actorId, {
        startUrls: [{ url }],
        pageFunction,
        proxyConfiguration: { useApifyProxy: true },
        maxRequestsPerCrawl: 1,
      }, APIFY_API_TOKEN);

      if (Array.isArray(data) && data.length > 0 && data[0].reviews) {
        reviews = dedup(data[0].reviews).slice(0, parseInt(limit)).map(r => ({
          ...r, source: "BBB", profilePhoto: null,
        }));
      }

    } else {
      return res.status(400).json({
        error: `Unknown platform: ${platform}. Supported: google, homeadvisor, yelp, bbb`,
      });
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

// ---- Helper: Run an Apify actor and return dataset items ----
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

// ---- Helper: Deduplicate reviews by text ----
function dedup(reviews) {
  const seen = new Set();
  return reviews.filter((r) => {
    const key = (r.text || '').substring(0, 60).toLowerCase().replace(/\s+/g, '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
