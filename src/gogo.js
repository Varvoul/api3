// gogo.js - Unified MAL+AniList ID handling + miruro pipe streams
// IDs from search are MAL IDs. /anime/{id} accepts both MAL and AniList IDs.

const PIPE = "https://www.miruro.to/api/secure/pipe";
const JIKAN = "https://api.jikan.moe/v4";
const ANILIST = "https://graphql.anilist.co";

const PIPE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Referer": "https://www.miruro.to/",
    "Origin": "https://www.miruro.to",
    "Accept": "application/json, text/plain, */*",
};

// ── AniList helpers ───────────────────────────────────────────────────────────

async function alQuery(query, variables = {}) {
    const res = await fetch(ANILIST, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`AniList ${res.status}`);
    const json = await res.json();
    if (json.errors) throw new Error(json.errors[0].message);
    return json.data;
}

// MAL ID → AniList ID (best-effort, returns null if AniList is down)
async function malToAL(malId) {
    try {
        const d = await alQuery(`query($id:Int){Media(idMal:$id,type:ANIME){id}}`, { id: parseInt(malId) });
        return d?.Media?.id || null;
    } catch(_) { return null; }
}

// AniList ID → MAL ID (best-effort)
async function alToMAL(alId) {
    try {
        const d = await alQuery(`query($id:Int){Media(id:$id,type:ANIME){idMal}}`, { id: parseInt(alId) });
        return d?.Media?.idMal || null;
    } catch(_) { return null; }
}

// ── Jikan helpers ─────────────────────────────────────────────────────────────

async function jikan(path) {
    const res = await fetch(`${JIKAN}${path}`, { headers: { "Accept": "application/json" } });
    if (!res.ok) throw new Error(`Jikan ${res.status}`);
    return res.json();
}

// ── Pipe helpers ──────────────────────────────────────────────────────────────

function b64url(str) {
    return btoa(unescape(encodeURIComponent(str)))
        .replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
}

async function gunzipCF(b64data) {
    const pad = b64data.replace(/-/g,"+").replace(/_/g,"/");
    const binary = Uint8Array.from(atob(pad), c => c.charCodeAt(0));
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
    const total = chunks.reduce((a,c) => a + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return JSON.parse(new TextDecoder().decode(out));
}

function translateId(v) {
    try {
        const s = atob(v.replace(/-/g,"+").replace(/_/g,"/"));
        if (s.includes(":")) return s;
    } catch(_) {}
    return v;
}

function deepTranslate(obj) {
    if (Array.isArray(obj)) {
        for (const i of obj) if (i && typeof i === "object") deepTranslate(i);
    } else if (obj && typeof obj === "object") {
        for (const k in obj) {
            const v = obj[k];
            if (k === "id" && typeof v === "string") obj[k] = translateId(v);
            else if (v && typeof v === "object") deepTranslate(v);
        }
    }
}

async function pipeFetch(path, query) {
    const payload = { path, method: "GET", query, body: null, version: "0.1.0" };
    const encoded = b64url(JSON.stringify(payload));
    const res = await fetch(`${PIPE}?e=${encoded}`, { headers: PIPE_HEADERS });
    if (!res.ok) throw new Error(`Pipe ${res.status}`);
    const text = await res.text();
    return gunzipCF(text.trim());
}

// Fetch episodes from miruro trying both AniList and MAL IDs
async function fetchEpisodes(anilistId, malId) {
    // Try AniList ID first
    try {
        const data = await pipeFetch("episodes", { anilistId: String(anilistId) });
        if (data?.providers && Object.keys(data.providers).length > 0) return data;
    } catch(_) {}
    // Fallback to MAL ID if different
    if (malId && String(malId) !== String(anilistId)) {
        try {
            const data = await pipeFetch("episodes", { anilistId: String(malId) });
            if (data?.providers && Object.keys(data.providers).length > 0) return data;
        } catch(_) {}
    }
    return null;
}

// ── Exported functions ────────────────────────────────────────────────────────

async function getSearch(name, page = 1) {
    // Jikan search - always works, returns MAL IDs
    // Try to get AniList IDs in parallel for miruro compatibility
    const data = await jikan(`/anime?q=${encodeURIComponent(name)}&page=${parseInt(page)}&limit=20&sfw=true`);
    const items = data.data || [];
    const results = await Promise.all(items.map(async a => {
        const alId = await malToAL(a.mal_id); // best-effort
        return {
            title: a.title_english || a.title || null,
            img: a.images?.jpg?.image_url || null,
            id: String(alId || a.mal_id),      // AniList ID preferred, MAL fallback
            malId: String(a.mal_id),
            anilistId: alId ? String(alId) : null,
            link: `https://www.miruro.to/watch/${alId || a.mal_id}`,
            releaseDate: a.year ? String(a.year) : null,
        };
    }));
    return results;
}

async function getAnime(id) {
    if (isNaN(parseInt(id))) {
        // It's a name string - search first
        const r = await getSearch(id);
        if (!r.length) throw new Error("Not found");
        return getAnime(r[0].id);
    }

    const numId = parseInt(id);
    let malId = numId;
    let anilistId = numId;
    let jikanData = null;

    // Strategy: try as MAL ID first (Jikan), then try as AniList ID
    try {
        const res = await jikan(`/anime/${numId}/full`);
        jikanData = res.data;
        malId = jikanData.mal_id;
        // Get AniList ID from MAL ID
        const alId = await malToAL(malId);
        anilistId = alId || malId;
    } catch(e) {
        // numId is likely an AniList ID - get MAL ID from AniList
        const mId = await alToMAL(numId);
        if (mId) {
            malId = mId;
            anilistId = numId;
            try {
                const res = await jikan(`/anime/${malId}/full`);
                jikanData = res.data;
            } catch(_) {}
        }
        if (!jikanData) throw new Error("Not found");
    }

    // Fetch miruro episodes (try both IDs)
    let episodes = [];
    let providers_summary = {};
    const epData = await fetchEpisodes(anilistId, malId);
    if (epData?.providers) {
        deepTranslate(epData);
        for (const [provName, provData] of Object.entries(epData.providers)) {
            const eps = provData?.episodes || {};
            const streamType = provData?.streamType || "hls";
            providers_summary[provName] = { streamType, categories: [] };
            for (const [cat, epList] of Object.entries(eps)) {
                if (!Array.isArray(epList)) continue;
                if (!providers_summary[provName].categories.includes(cat))
                    providers_summary[provName].categories.push(cat);
                for (const ep of epList) {
                    episodes.push([
                        String(ep.number ?? ep.id),
                        `${provName}:${anilistId}:${cat}:${ep.id}`,
                    ]);
                }
            }
        }
    } else {
        providers_summary = { status: "No episodes found from miruro providers" };
    }

    return {
        name: jikanData.title_english || jikanData.title,
        image: jikanData.images?.jpg?.large_image_url || null,
        id: String(anilistId),
        malId: String(malId),
        genre: (jikanData.genres || []).map(g => g.name).join(", "),
        type: jikanData.type || null,
        status: jikanData.status || null,
        plot_summary: jikanData.synopsis || null,
        released: jikanData.year ? String(jikanData.year) : null,
        episodes,
        total_episodes: jikanData.episodes || episodes.length,
        score: jikanData.score || null,
        providers: providers_summary,
        miruro_url: `https://www.miruro.to/watch/${anilistId}`,
    };
}

async function getRecentAnime(page = 1) {
    const data = await jikan(`/seasons/now?page=${parseInt(page)}&limit=24`);
    return Promise.all((data.data || []).map(async a => {
        const alId = await malToAL(a.mal_id);
        return {
            title: a.title_english || a.title || null,
            episode: `Episode ${a.episodes || "?"}`,
            image: a.images?.jpg?.image_url || null,
            id: String(alId || a.mal_id),
            malId: String(a.mal_id),
            miruro_url: `https://www.miruro.to/watch/${alId || a.mal_id}`,
        };
    }));
}

async function getPopularAnime(page = 1, max = 20) {
    const data = await jikan(`/top/anime?page=${parseInt(page)}&limit=${max}&filter=bypopularity`);
    return Promise.all((data.data || []).slice(0, max).map(async a => {
        const alId = await malToAL(a.mal_id);
        return {
            title: a.title_english || a.title || null,
            releaseDate: a.year ? String(a.year) : null,
            image: a.images?.jpg?.image_url || null,
            id: String(alId || a.mal_id),
            malId: String(a.mal_id),
            miruro_url: `https://www.miruro.to/watch/${alId || a.mal_id}`,
        };
    }));
}

async function getEpisode(id) {
    const parts = id.split(":");
    if (parts.length < 4) {
        return {
            error: "Invalid format. Use: provider:anilistId:sub|dub:episodeId",
            tip: "Get episode IDs from /anime/{id} first",
        };
    }
    const [provider, anilistId, category, ...rest] = parts;
    const episodeId = rest.join(":");
    const encId = b64url(episodeId);
    const data = await pipeFetch("sources", {
        episodeId: encId, provider, category, anilistId,
    });
    return {
        provider, anilistId, category, episodeId,
        sources: data?.sources || data?.stream || [],
        subtitles: data?.subtitles || data?.tracks || [],
        intro: data?.intro || null,
        outro: data?.outro || null,
        headers: data?.headers || null,
    };
}

async function GogoDLScrapper(a, b) { return { note: "Use /episode/provider:anilistId:sub|dub:episodeId" }; }
async function getGogoAuthKey() { return ""; }

export { getSearch, getAnime, getRecentAnime, getPopularAnime, getEpisode, GogoDLScrapper, getGogoAuthKey };
