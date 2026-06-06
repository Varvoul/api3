// gogo.js - Miruro pipe API for real m3u8/mp4 streams + Jikan for metadata

const PIPE = "https://www.miruro.to/api/secure/pipe";
const JIKAN = "https://api.jikan.moe/v4";

const PIPE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Referer": "https://www.miruro.to/",
    "Origin": "https://www.miruro.to",
};

// ── Pipe helpers ─────────────────────────────────────────────────────────────

function b64urlEncode(str) {
    return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function b64urlDecode(str) {
    str = str.replace(/-/g, "+").replace(/_/g, "/");
    while (str.length % 4) str += "=";
    return atob(str);
}

async function gunzipCF(base64urlData) {
    // CF Workers supports DecompressionStream('gzip')
    const binary = Uint8Array.from(b64urlDecode(base64urlData), c => c.charCodeAt(0));
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    writer.write(binary);
    writer.close();
    const chunks = [];
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
    }
    const total = chunks.reduce((a, c) => a + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return JSON.parse(new TextDecoder().decode(out));
}

function encodePipe(payload) {
    return b64urlEncode(JSON.stringify(payload));
}

async function pipeFetch(path, query) {
    const payload = { path, method: "GET", query, body: null, version: "0.1.0" };
    const encoded = encodePipe(payload);
    const res = await fetch(`${PIPE}?e=${encoded}`, { headers: PIPE_HEADERS });
    if (!res.ok) throw new Error(`Pipe ${res.status} for ${path}`);
    const text = await res.text();
    return gunzipCF(text.trim());
}

function translateId(encodedId) {
    try {
        const decoded = b64urlDecode(encodedId);
        if (decoded.includes(":")) return decoded;
    } catch(_) {}
    return encodedId;
}

function deepTranslate(obj) {
    if (Array.isArray(obj)) {
        for (const item of obj) if (item && typeof item === "object") deepTranslate(item);
    } else if (obj && typeof obj === "object") {
        for (const key in obj) {
            const val = obj[key];
            if (key === "id" && typeof val === "string") obj[key] = translateId(val);
            else if (val && typeof val === "object") deepTranslate(val);
        }
    }
}

// ── Jikan helpers ────────────────────────────────────────────────────────────

async function jikan(path) {
    const res = await fetch(`${JIKAN}${path}`, { headers: { "Accept": "application/json" } });
    if (!res.ok) throw new Error(`Jikan ${res.status}`);
    return res.json();
}

function fmtAnime(a) {
    return {
        title: a.title_english || a.title || null,
        img: a.images?.jpg?.image_url || null,
        id: String(a.mal_id),
        link: `https://www.miruro.to/watch/${a.mal_id}`,
        releaseDate: a.year ? String(a.year) : null,
    };
}

// ── Exported functions ───────────────────────────────────────────────────────

async function getSearch(name, page = 1) {
    const data = await jikan(`/anime?q=${encodeURIComponent(name)}&page=${parseInt(page)}&limit=20&sfw=true`);
    return (data.data || []).map(fmtAnime);
}

async function getAnime(id) {
    const numId = parseInt(id);
    if (isNaN(numId)) {
        const r = await getSearch(id);
        if (!r.length) throw new Error("Not found");
        return getAnime(r[0].id);
    }
    const [animeRes, episodesData] = await Promise.all([
        jikan(`/anime/${numId}/full`),
        pipeFetch("episodes", { anilistId: String(numId) }).catch(() => null),
    ]);
    const a = animeRes.data;
    if (!a) throw new Error("Not found");

    // Build episode list from miruro providers
    let episodes = [];
    if (episodesData?.providers) {
        deepTranslate(episodesData);
        const providers = episodesData.providers;
        for (const [provName, provData] of Object.entries(providers)) {
            const eps = provData?.episodes || {};
            const streamType = provData?.streamType || "hls";
            for (const [category, epList] of Object.entries(eps)) {
                if (!Array.isArray(epList)) continue;
                for (const ep of epList) {
                    episodes.push([
                        String(ep.number || ep.id),
                        `${provName}:${numId}:${category}:${ep.id}`,
                    ]);
                }
            }
        }
    }

    // Fallback: numbered episode list
    if (!episodes.length) {
        const total = a.episodes || 0;
        for (let i = 1; i <= Math.min(total, 500); i++) {
            episodes.push([String(i), `miruro:${numId}:sub:${i}`]);
        }
    }

    return {
        name: a.title_english || a.title,
        image: a.images?.jpg?.large_image_url || null,
        id: String(numId),
        malId: String(numId),
        genre: (a.genres || []).map(g => g.name).join(", "),
        type: a.type || null,
        status: a.status || null,
        plot_summary: a.synopsis || null,
        released: a.year ? String(a.year) : null,
        episodes,
        total_episodes: a.episodes || episodes.length,
        score: a.score || null,
        miruro_url: `https://www.miruro.to/watch/${numId}`,
    };
}

async function getRecentAnime(page = 1) {
    const data = await jikan(`/seasons/now?page=${parseInt(page)}&limit=24`);
    return (data.data || []).map(a => ({
        title: a.title_english || a.title || null,
        episode: `Episode ${a.episodes || "?"}`,
        image: a.images?.jpg?.image_url || null,
        id: String(a.mal_id),
        miruro_url: `https://www.miruro.to/watch/${a.mal_id}`,
    }));
}

async function getPopularAnime(page = 1, max = 20) {
    const data = await jikan(`/top/anime?page=${parseInt(page)}&limit=${max}&filter=bypopularity`);
    return (data.data || []).slice(0, max).map(a => ({
        title: a.title_english || a.title || null,
        releaseDate: a.year ? String(a.year) : null,
        image: a.images?.jpg?.image_url || null,
        id: String(a.mal_id),
        miruro_url: `https://www.miruro.to/watch/${a.mal_id}`,
    }));
}

// getEpisode: fetches REAL m3u8/mp4/embed sources from miruro pipe
// id format: "provider:anilistId:category:episodeId"
// e.g. "zoro:20:sub:some-id-here"
async function getEpisode(id) {
    const parts = id.split(":");
    if (parts.length < 4) {
        return {
            error: "Invalid format. Use: provider:anilistId:sub|dub:episodeId",
            example: "zoro:20:sub:abc123",
            tip: "Get episode IDs from /anime/{id} endpoint first",
        };
    }
    const [provider, anilistId, category, ...epIdParts] = parts;
    const episodeId = epIdParts.join(":");

    const encId = b64urlEncode(episodeId);
    const data = await pipeFetch("sources", {
        episodeId: encId,
        provider,
        category,
        anilistId,
    });

    return {
        provider,
        anilistId,
        category,
        episodeId,
        sources: data?.sources || data?.stream || [],
        subtitles: data?.subtitles || data?.tracks || [],
        intro: data?.intro || null,
        outro: data?.outro || null,
        headers: data?.headers || null,
        raw: data,
    };
}

async function GogoDLScrapper(animeid, cookie) {
    return { note: "Use /episode/provider:anilistId:sub|dub:episodeId for real stream URLs" };
}

async function getGogoAuthKey() { return ""; }

export { getSearch, getAnime, getRecentAnime, getPopularAnime, getEpisode, GogoDLScrapper, getGogoAuthKey };
