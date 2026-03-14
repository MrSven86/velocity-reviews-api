// Vercel Serverless Function — UNIVERSAL Review Fetcher
// Works on ANY review page: HomeAdvisor, Yelp, Google, BBB, Angi, Thumbtack, BuildZoom, etc.
//
// TWO MODES:
//   /api/reviews?url=https://www.homeadvisor.com/rated.ColormasterPainting.50192468.html&limit=10
//   /api/reviews?platform=google&query=Color+Masters+Painting+Dallas+TX&limit=10
//
// Mode 1 (url=) uses a universal page scraper that works on any site.
// Mode 2 (platform=google) uses the dedicated Google Maps actor for best results.

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const { url, platform, query, limit = "10" } = req.query;
  const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN;

  if (!APIFY_API_TOKEN) {
    return res.status(500).json({ error: "APIFY_API_TOKEN not set" });
  }

  if (!url && !query) {
    return res.status(400).json({
      error: "Provide either 'url' (any review page) or 'platform=google&query=business+name'",
      examples: [
        "/api/reviews?url=https://www.homeadvisor.com/rated.ColormasterPainting.50192468.html",
        "/api/reviews?url=https://www.yelp.com/biz/some-business",
        "/api/reviews?url=https://www.bbb.org/us/some-business",
        "/api/reviews?platform=google&query=Color+Masters+Painting+Dallas+TX",
      ],
    });
  }

  try {
    let reviews = [];
    let sourceName = "Reviews";

    // ==========================================================
    // MODE 1: GOOGLE (dedicated actor — best results for Google)
    // ==========================================================
    if (platform === "google" && query) {
      sourceName = "Google";
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

    // ==========================================================
    // MODE 2: UNIVERSAL — any URL, any review site
    // ==========================================================
    } else if (url) {
      // Detect the source name from URL
      if (url.includes("homeadvisor.com")) sourceName = "HomeAdvisor";
      else if (url.includes("yelp.com")) sourceName = "Yelp";
      else if (url.includes("bbb.org")) sourceName = "BBB";
      else if (url.includes("angi.com") || url.includes("angieslist.com")) sourceName = "Angi";
      else if (url.includes("thumbtack.com")) sourceName = "Thumbtack";
      else if (url.includes("buildzoom.com")) sourceName = "BuildZoom";
      else if (url.includes("facebook.com")) sourceName = "Facebook";
      else if (url.includes("trustpilot.com")) sourceName = "Trustpilot";
      else if (url.includes("google.com/maps")) sourceName = "Google";
      else {
        try { sourceName = new URL(url).hostname.replace("www.", ""); } catch (e) {}
      }

      // Use Apify Puppeteer Scraper — visits the page in a real browser
      // and runs our custom extraction code
      const actorId = "apify~web-scraper";

      const pageFunction = `
        async function pageFunction(context) {
          const { page, request, log } = context;

          // Wait for page to fully render
          await new Promise(r => setTimeout(r, 5000));

          const reviews = await page.evaluate(() => {
            const results = [];

            // ============================================
            // METHOD 1: JSON-LD Structured Data (schema.org)
            // Most reliable — many sites embed review data this way
            // ============================================
            const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
            for (const script of jsonLdScripts) {
              try {
                let dataList = JSON.parse(script.textContent);
                if (!Array.isArray(dataList)) dataList = [dataList];

                for (const data of dataList) {
                  // Check @graph arrays
                  const items = data['@graph'] ? data['@graph'] : [data];
                  for (const item of items) {
                    const rawReviews = item.review || item.reviews || [];
                    const reviewArr = Array.isArray(rawReviews) ? rawReviews : [rawReviews];
                    for (const r of reviewArr) {
                      if (r && (r.reviewBody || r.description || r.text)) {
                        results.push({
                          author: (typeof r.author === 'string' ? r.author : r.author?.name) || 'Anonymous',
                          rating: parseFloat(r.reviewRating?.ratingValue || r.rating || 5),
                          text: r.reviewBody || r.description || r.text || '',
                          date: r.datePublished || r.dateCreated || '',
                        });
                      }
                    }
                    // Also check if the item itself IS a review
                    if (item['@type'] === 'Review' && (item.reviewBody || item.description)) {
                      results.push({
                        author: (typeof item.author === 'string' ? item.author : item.author?.name) || 'Anonymous',
                        rating: parseFloat(item.reviewRating?.ratingValue || 5),
                        text: item.reviewBody || item.description || '',
                        date: item.datePublished || '',
                      });
                    }
                  }
                }
              } catch (e) {}
            }

            if (results.length > 0) return results;

            // ============================================
            // METHOD 2: Common review DOM patterns
            // Tries multiple known selector patterns
            // ============================================
            const selectorSets = [
              // HomeAdvisor
              {
                container: '[data-testid="review"], .review-card, .review-item, [class*="review-container"], [class*="ReviewCard"]',
                author: '[class*="reviewer-name"], [class*="review-author"], [class*="author-name"], [data-testid="reviewer-name"]',
                rating: '[class*="rating"] [aria-label], [class*="stars"], [class*="rating-value"]',
                text: '[class*="review-text"], [class*="review-body"], [class*="review-content"], [data-testid="review-text"]',
                date: '[class*="review-date"], [class*="date"], time[datetime]',
              },
              // Yelp
              {
                container: '[class*="review__"] li, [data-review-id], .review',
                author: '[class*="user-passport"] a, .user-name',
                rating: '[class*="star-rating"] [aria-label], .rating-large',
                text: '[class*="comment__"] p, .review-content p',
                date: '[class*="date"], .rating-qualifier',
              },
              // BBB
              {
                container: '.customer-review, [class*="ReviewCard"]',
                author: '.reviewer-name, [class*="review-author"]',
                rating: '.star-rating, [class*="rating"]',
                text: '.review-text, [class*="review-body"]',
                date: '.review-date, [class*="date"]',
              },
              // Generic fallback — broad selectors
              {
                container: '[itemtype*="Review"], [class*="review"]:not(nav):not(header), [class*="testimonial"], [class*="Review"]',
                author: '[itemprop="author"], [class*="author"], [class*="name"]:not(h1):not(h2)',
                rating: '[itemprop="ratingValue"], [class*="rating"], [class*="star"]',
                text: '[itemprop="reviewBody"], [class*="text"], [class*="body"], [class*="content"] p',
                date: '[itemprop="datePublished"], [class*="date"], time',
              },
            ];

            for (const selectors of selectorSets) {
              const containers = document.querySelectorAll(selectors.container);
              if (containers.length === 0) continue;

              containers.forEach(container => {
                const authorEl = container.querySelector(selectors.author);
                const ratingEl = container.querySelector(selectors.rating);
                const textEl = container.querySelector(selectors.text);
                const dateEl = container.querySelector(selectors.date);

                const text = textEl?.textContent?.trim() || '';
                if (text.length < 10) return; // Skip empty/tiny reviews

                // Extract rating from aria-label, text content, or class name
                let rating = 5;
                if (ratingEl) {
                  const ariaLabel = ratingEl.getAttribute('aria-label') || '';
                  const ratingMatch = ariaLabel.match(/(\\d+\\.?\\d*)/);
                  if (ratingMatch) {
                    rating = parseFloat(ratingMatch[1]);
                  } else {
                    const textMatch = ratingEl.textContent.match(/(\\d+\\.?\\d*)/);
                    if (textMatch) rating = parseFloat(textMatch[1]);
                  }
                  // Cap at 5
                  if (rating > 5) rating = 5;
                }

                // Extract date
                let date = '';
                if (dateEl) {
                  date = dateEl.getAttribute('datetime') || dateEl.textContent?.trim() || '';
                }

                results.push({
                  author: authorEl?.textContent?.trim() || 'Verified Customer',
                  rating: rating,
                  text: text,
                  date: date,
                });
              });

              if (results.length > 0) break; // Stop if we found reviews
            }

            return results;
          });

          return { url: request.url, reviews };
        }
      `;

      const runResponse = await fetch(
        `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${APIFY_API_TOKEN}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            startUrls: [{ url: url }],
            pageFunction: pageFunction,
            proxyConfiguration: { useApifyProxy: true },
            maxRequestsPerCrawl: 1,
            preNavigationHooks: `[
              async ({ page }, goToOptions) => {
                goToOptions.waitUntil = 'networkidle2';
                goToOptions.timeout = 60000;
              }
            ]`,
          }),
        }
      );

      const data = await runResponse.json();

      if (Array.isArray(data) && data.length > 0 && data[0].reviews) {
        const seen = new Set();
        reviews = data[0].reviews
          .filter((r) => {
            // Deduplicate by text
            const key = r.text.substring(0, 80).toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .slice(0, parseInt(limit))
          .map((r) => ({
            author: r.author || "Verified Customer",
            rating: r.rating || 5,
            text: r.text || "",
            date: r.date || "",
            source: sourceName,
            profilePhoto: null,
          }));
      }

    } else {
      return res.status(400).json({
        error: "For non-Google platforms, use the 'url' parameter with the full review page URL.",
      });
    }

    return res.status(200).json({
      success: true,
      url: url || query,
      source: sourceName,
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
