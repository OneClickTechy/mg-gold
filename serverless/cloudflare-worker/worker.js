/**
 * MG Gold Mart - Gold Rate API Worker
 * 
 * Features:
 * 1. Primary: Coimbatore Jewellers Association published rates
 * 2. Alternate: The Jewellers and Diamond Traders Association published rates
 * 3. Cloudflare Edge Caching (5 minutes)
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json; charset=utf-8'
};

function parseCjaRate(html, purity) {
  const heading = new RegExp(
    `<h4[^>]*>\\s*${purity}\\s*kt\\s+Gold\\s+Rate\\s*<\\/h4>[\\s\\S]*?<span[^>]*class=["'][^"']*\\brate-price\\b[^"']*["'][^>]*>\\s*(?:₹|&#8377;|&\\#8377;)?\\s*([\\d,]+(?:\\.\\d+)?)\\s*<\\/span>`,
    'i'
  );
  const match = html.match(heading);
  if (!match) return null;

  const rate = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

async function fetchFromCja() {
  try {
    const res = await fetch('https://coimbatorejewellery.org/', {
      headers: { 'User-Agent': 'MGGoldMart Gold Rate/1.0' },
      cf: { cacheTtl: 300 }
    });
    if (!res.ok) {
      console.warn('CJA rate page request failed:', res.status);
      return null;
    }

    const html = await res.text();
    const rate22k = parseCjaRate(html, 22);
    const rate18k = parseCjaRate(html, 18);
    if (!rate22k || !rate18k) {
      console.warn('CJA rate page did not contain valid 22K and 18K rates');
      return null;
    }

    const updateTime = html.match(
      /<p[^>]*class=["'][^"']*\bUpdatetime\b[^"']*["'][^>]*>\s*Update Time:\s*([^<]+)</i
    )?.[1]?.trim();

    return {
      source: 'Coimbatore Jewellers Association (CJA)',
      apiType: 'Published CJA rate page',
      sourceUpdatedAt: updateTime || null,
      rates: {
        '24k': Math.round(rate22k * (24 / 22)),
        '22k': rate22k,
        '18k': rate18k
      }
    };
  } catch (err) {
    console.warn('CJA rate page request error:', err.message);
    return null;
  }
}

function parseMjdtaRate(html, purity) {
  const ratePattern = new RegExp(
    `\\$\\(['"]#goldrate_${purity}ct['"]\\)\\.html\\(\\s*['"]([\\d,]+(?:\\.\\d+)?)['"]\\s*\\)`,
    'i'
  );
  const match = html.match(ratePattern);
  if (!match) return null;

  const rate = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

async function fetchFromMjdta() {
  try {
    const res = await fetch('https://thejewellersassociation.org/', {
      headers: { 'User-Agent': 'MGGoldMart Gold Rate/1.0' },
      cf: { cacheTtl: 300 }
    });
    if (!res.ok) {
      console.warn('MJDTA rate page request failed:', res.status);
      return null;
    }

    const html = await res.text();
    const rate22k = parseMjdtaRate(html, 22);
    const rate18k = parseMjdtaRate(html, 18);
    if (!rate22k || !rate18k) {
      console.warn('MJDTA rate page did not contain valid 22K and 18K rates');
      return null;
    }

    const updateTime = html.match(
      /#updatetime['"]\)\.html\(\s*['"]([^'"]+)['"]\s*\)/i
    )?.[1]?.trim();

    return {
      source: 'The Jewellers and Diamond Traders Association (MJDTA)',
      apiType: 'Published MJDTA rate page',
      sourceUpdatedAt: updateTime || null,
      rates: {
        '24k': Math.round(rate22k * (24 / 22)),
        '22k': rate22k,
        '18k': rate18k
      }
    };
  } catch (err) {
    console.warn('MJDTA rate page request error:', err.message);
    return null;
  }
}

const worker = {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const cache = typeof caches !== 'undefined' ? caches.default : null;
    const cacheUrl = new URL(url);
    cacheUrl.searchParams.set('cacheVersion', 'association-v2');
    const cacheKey = new Request(cacheUrl.toString(), request);

    if (cache) {
      let cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) {
        const headers = new Headers(cachedResponse.headers);
        headers.set('X-Rate-Cache', 'HIT');
        return new Response(cachedResponse.body, {
          status: cachedResponse.status,
          headers
        });
      }
    }

    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istDate = new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + istOffset);

    const year = istDate.getFullYear();
    const monthIndex = istDate.getMonth();
    const day = istDate.getDate();

    const monthNames = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
    ];
    const formattedDate = `${day} ${monthNames[monthIndex]} ${year}`;
    const isoDate = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    const apiData = await fetchFromCja() || await fetchFromMjdta();
    if (!apiData) {
      const unavailablePayload = {
        success: false,
        status: 'UNAVAILABLE',
        message: 'Gold rates could not be retrieved from either association source.'
      };
      return new Response(JSON.stringify(unavailablePayload), {
        status: 503,
        headers: {
          ...CORS_HEADERS,
          'Cache-Control': 'no-store',
          'X-Rate-Cache': 'MISS'
        }
      });
    }

    const payload = {
      success: true,
      status: 'LIVE',
      isRealLiveFetch: true,
      fetchMethod: apiData.apiType,
      apiType: apiData.apiType,
      market: 'Coimbatore Bullion Index',
      location: 'Coimbatore, Tamil Nadu',
      currency: 'INR',
      unit: 'gram',
      updatedDate: isoDate,
      formattedDate: formattedDate,
      timestamp: istDate.toISOString(),
      sourceUpdatedAt: apiData.sourceUpdatedAt,
      rates: apiData.rates,
      source: apiData.source,
      cacheTtlSeconds: 300
    };

    const responseHeaders = {
      ...CORS_HEADERS,
      'Cache-Control': 'public, max-age=300, s-maxage=300',
      'X-Rate-Cache': 'MISS',
      'X-Api-Type': apiData.apiType
    };

    const response = new Response(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: responseHeaders
    });

    if (cache && ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }
    return response;
  }
};

export default worker;
