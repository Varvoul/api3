// gogo.js - Jikan for metadata (always works) + miruro pipe for streams
// AniList used ONLY for ID lookup (with graceful fallback to MAL ID)

const PIPE = "https://www.miruro.to/api/secure/pipe";
const JIKAN = "https://api.jikan.moe/v4";
const ANILIST = "https://graphql.anilist.co";

const PIPE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Referer": "https://www.miruro.to/",
    "Origin": "https://www.miruro.to",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
};

// ── Jikan ────────────────────────────────────────────────────────────────────

async function jikan(path) {
    const res = await fetch(`${JIKAN}${path}`, {
        headers: { "Accept": "application/json", "User-Agent": "AnimeDexAPI/1.0" }
    });
    if (!res.ok) throw new Error(`Jikan ${res.status}`);
    return res.json();
}

// ── AniList ID lookup (best-effort, fallback to MAL ID) ──────────────────────

async function getAnilistId(malId) {
    try {
        const res = await fetch(ANILIST, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify({
                query: `query($id:Int){Media(idMal:$id,type:ANIME){id}}`,
                variables: { id: parseInt(malId) }
            }),
        });
        if (!res.ok) return null;
        const json = await res.json();
        return json?.data?.Media?.id || null;
    } catch(_) {
        return null;
    }
}

// ── Pipe helpers ─────────────────────────────────────────────────────────────

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

// ── Formatters ───────────────────────────────────────────────────────────────

function fmtAnime(a, anilistId) {
    return {
        title: a.title_english || a.title || null,
        img: a.images?.jpg?.image_url || null,
        id: anilistId ? String(anilistId) : String(a.mal_id),
        malId: String(a.mal_id),
        link: `https://www.miruro.to/watch/${anilistId || a.mal_id}`,
        releaseDate: a.year ? String(a.year) : null,
    };
}

// ── Exported functions ───────────────────────────────────────────────────────

async function getSearch(name, page = 1) {
    const data = await jikan(`/anime?q=${encodeURIComponent(name)}&page=${parseInt(page)}&limit=20&sfw=true`);
    const items = data.data || [];
    // Resolve AniList IDs in parallel (best-effort)
    const results = await Promise.all(items.map(async a => {
        const anilistId = await getAnilistId(a.mal_id);
        return fmtAnime(a, anilistId);
    }));
    return results;
}

async function getAnime(id) {
    // id could be AniList ID, MAL ID, or anime name
    const numId = parseInt(id);

    if (isNaN(numId)) {
        // It's a name — search first
        const r = await getSearch(id);
        if (!r.length) throw new Error("Not found");
        return getAnime(r[0].id);
    }

    // Fetch Jikan data using MAL ID
    // First try as MAL ID directly
    let jikanData = null;
    let malId = numId;

    try {
        const res = await jikan(`/anime/${numId}/full`);
        jikanData = res.data;
        malId = jikanData.mal_id;
    } catch(e) {
        // numId might be an AniList ID - try to find MAL ID via AniList
        try {
            const alRes = await fetch(ANILIST, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    query: `query($id:Int){Media(id:$id,type:ANIME){id idMal title{romaji}}}`,
                    variables: { id: numId }
                })
            });
            const alJson = await alRes.json();
            malId = alJson?.data?.Media?.idMal;
            if (malId) {
                const res2 = await jikan(`/anime/${malId}/full`);
                jikanData = res2.data;
            }
        } catch(_) {}
    }

    if (!jikanData) throw new Error("Not found");

    // Get AniList ID for miruro pipe
    const anilistId = await getAnilistId(malId) || malId;

    // Fetch miruro episodes using AniList ID
    let episodes = [];
    let providers_summary = {};
    try {
        const epData = await pipeFetch("episodes", { anilistId: String(anilistId) });
        deepTranslate(epData);
        for (const [provName, provData] of Object.entries(epData.providers || {})) {
            const eps = provData?.episodes || {};
            const streamType = provData?.streamType || "hls";
            providers_summary[provName] = { streamType, categories: [] };
            for (const [cat, epList] of Object.entries(eps)) {
                if (!Array.isArray(epList)) continue;
                providers_summary[provName].categories.push(cat);
                for (const ep of epList) {
                    episodes.push([
                        String(ep.number ?? ep.id),
                        `${provName}:${anilistId}:${cat}:${ep.id}`,
                    ]);
                }
            }
        }
    } catch(e) {
        // Episodes unavailable - return anime info without episodes
        providers_summary = { note: `Episode fetch failed: ${e.message}` };
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
        const aid = await getAnilistId(a.mal_id);
        return {
            title: a.title_english || a.title || null,
            episode: `Episode ${a.episodes || "?"}`,
            image: a.images?.jpg?.image_url || null,
            id: String(aid || a.mal_id),
            malId: String(a.mal_id),
            miruro_url: `https://www.miruro.to/watch/${aid || a.mal_id}`,
        };
    }));
}

async function getPopularAnime(page = 1, max = 20) {
    const data = await jikan(`/top/anime?page=${parseInt(page)}&limit=${max}&filter=bypopularity`);
    return Promise.all((data.data || []).slice(0, max).map(async a => {
        const aid = await getAnilistId(a.mal_id);
        return {
            title: a.title_english || a.title || null,
            releaseDate: a.year ? String(a.year) : null,
            image: a.images?.jpg?.image_url || null,
            id: String(aid || a.mal_id),
            malId: String(a.mal_id),
            miruro_url: `https://www.miruro.to/watch/${aid || a.mal_id}`,
        };
    }));
}

async function getEpisode(id) {
    // id format: "provider:anilistId:sub|dub:episodeId"
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
    };
}

async function GogoDLScrapper(a, b) {
    return { note: "Use /episode/provider:anilistId:sub|dub:episodeId" };
}
async function getGogoAuthKey() { return ""; }

export { getSearch, getAnime, getRecentAnime, getPopularAnime, getEpisode, GogoDLScrapper, getGogoAuthKey };
