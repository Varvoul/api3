// gogo.js
// Search: Jikan (always works from CF Workers)
// Metadata + episodes: miruro pipe (works with MAL ID for most anime)
// AniList: single query per anime for ID mapping (not 20 parallel calls)

const PIPE = "https://www.miruro.to/api/secure/pipe";
const JIKAN = "https://api.jikan.moe/v4";
const ANILIST = "https://graphql.anilist.co";

const PIPE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Referer": "https://www.miruro.to/",
    "Origin": "https://www.miruro.to",
    "Accept": "application/json, text/plain, */*",
};

// ── AniList single lookup (best-effort, falls back gracefully) ────────────────

async function alByMalId(malId) {
    try {
        const res = await fetch(ANILIST, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify({
                query: `query($id:Int){Media(idMal:$id,type:ANIME){id idMal}}`,
                variables: { id: parseInt(malId) }
            }),
        });
        if (!res.ok) return null;
        const json = await res.json();
        return json?.data?.Media || null;
    } catch(_) { return null; }
}

async function alByTitle(title) {
    try {
        const res = await fetch(ANILIST, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify({
                query: `query($s:String){Media(search:$s,type:ANIME){id idMal title{romaji english}coverImage{large}startDate{year}genres episodes status averageScore description(asHtml:false)}}`,
                variables: { s: title }
            }),
        });
        if (!res.ok) return null;
        const json = await res.json();
        return json?.data?.Media || null;
    } catch(_) { return null; }
}

// ── Jikan ─────────────────────────────────────────────────────────────────────

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

async function fetchEpisodes(anilistId, malId) {
    const ids = [...new Set([String(anilistId), malId ? String(malId) : null].filter(Boolean))];
    for (const id of ids) {
        try {
            const data = await pipeFetch("episodes", { anilistId: id });
            if (data?.providers && Object.keys(data.providers).length > 0)
                return { data, usedId: id };
        } catch(_) {}
    }
    return { data: null, usedId: String(anilistId) };
}

function buildEpisodes(epData, anilistId) {
    const episodes = [], providers = {};
    if (!epData?.providers) return { episodes, providers };
    deepTranslate(epData);
    for (const [prov, pd] of Object.entries(epData.providers)) {
        const eps = pd?.episodes || {};
        providers[prov] = { streamType: pd?.streamType || "hls", categories: [] };
        for (const [cat, list] of Object.entries(eps)) {
            if (!Array.isArray(list)) continue;
            if (!providers[prov].categories.includes(cat)) providers[prov].categories.push(cat);
            for (const ep of list)
                episodes.push([String(ep.number ?? ep.id), `${prov}:${anilistId}:${cat}:${ep.id}`]);
        }
    }
    return { episodes, providers };
}

// ── Exported functions ────────────────────────────────────────────────────────

async function getSearch(name, page = 1) {
    // Jikan search — always works from CF Workers
    const data = await jikan(`/anime?q=${encodeURIComponent(name)}&page=${parseInt(page)}&limit=20&sfw=true`);
    return (data.data || []).map(a => ({
        title: a.title_english || a.title || null,
        img: a.images?.jpg?.image_url || null,
        // Use MAL ID as id (same as AniList for most classic anime)
        // For your website, use /anime/{malId} to get full details with correct AniList ID
        id: String(a.mal_id),
        malId: String(a.mal_id),
        link: `https://www.miruro.to/watch/${a.mal_id}`,
        releaseDate: a.year ? String(a.year) : null,
        type: a.type || null,
        episodes: a.episodes || null,
        score: a.score || null,
        status: a.status || null,
    }));
}

async function getAnime(id) {
    const numId = parseInt(id);
    if (isNaN(numId)) {
        // Name — try AniList first, fallback to Jikan search
        const alMedia = await alByTitle(id);
        if (alMedia) return _buildFromAL(alMedia);
        const r = await getSearch(id);
        if (!r.length) throw new Error("Not found");
        return getAnime(r[0].id);
    }

    // Try AniList lookup by MAL ID to get correct AniList ID
    const alMedia = await alByMalId(numId);
    const anilistId = alMedia?.id || numId;
    const malId = alMedia?.idMal || numId;

    if (alMedia) return _buildFromAL(alMedia, numId);

    // AniList blocked — use Jikan only
    const j = await jikan(`/anime/${numId}/full`);
    const jd = j.data;
    if (!jd) throw new Error("Not found");
    const { data: epData, usedId } = await fetchEpisodes(numId, null);
    const { episodes, providers } = buildEpisodes(epData, usedId || numId);
    return {
        name: jd.title_english || jd.title,
        image: jd.images?.jpg?.large_image_url || null,
        id: String(numId),
        malId: String(numId),
        genre: (jd.genres||[]).map(g=>g.name).join(", "),
        type: jd.type || null,
        status: jd.status || null,
        plot_summary: jd.synopsis || null,
        released: jd.year ? String(jd.year) : null,
        episodes,
        total_episodes: jd.episodes || episodes.length,
        score: jd.score || null,
        providers,
        miruro_url: `https://www.miruro.to/watch/${numId}`,
    };
}

async function _buildFromAL(alMedia, malIdOverride) {
    const anilistId = alMedia.id;
    const malId = alMedia.idMal || malIdOverride;
    const { data: epData, usedId } = await fetchEpisodes(anilistId, malId);
    const { episodes, providers } = buildEpisodes(epData, usedId || anilistId);

    // Enrich with Jikan if we have malId
    let jd = null;
    if (malId) {
        try { jd = (await jikan(`/anime/${malId}/full`)).data; } catch(_) {}
    }

    return {
        name: alMedia.title?.english || alMedia.title?.romaji || jd?.title_english || jd?.title,
        image: alMedia.coverImage?.large || jd?.images?.jpg?.large_image_url || null,
        id: String(anilistId),
        malId: malId ? String(malId) : String(anilistId),
        genre: alMedia.genres ? alMedia.genres.join(", ") : (jd?.genres||[]).map(g=>g.name).join(", "),
        type: jd?.type || null,
        status: alMedia.status || jd?.status || null,
        plot_summary: alMedia.description || jd?.synopsis || null,
        released: alMedia.startDate?.year ? String(alMedia.startDate.year) : (jd?.year ? String(jd.year) : null),
        episodes,
        total_episodes: alMedia.episodes || jd?.episodes || episodes.length,
        score: alMedia.averageScore || (jd?.score ? Math.round(jd.score*10) : null),
        providers,
        miruro_url: `https://www.miruro.to/watch/${anilistId}`,
    };
}

async function getRecentAnime(page = 1) {
    const data = await jikan(`/seasons/now?page=${parseInt(page)}&limit=24`);
    return (data.data || []).map(a => ({
        title: a.title_english || a.title || null,
        episode: `Episode ${a.episodes || "?"}`,
        image: a.images?.jpg?.image_url || null,
        id: String(a.mal_id),
        malId: String(a.mal_id),
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
        malId: String(a.mal_id),
        miruro_url: `https://www.miruro.to/watch/${a.mal_id}`,
    }));
}

async function getEpisode(id) {
    const p1 = id.indexOf(":");
    const p2 = id.indexOf(":", p1 + 1);
    const p3 = id.indexOf(":", p2 + 1);
    if (p1 < 0 || p2 < 0 || p3 < 0) return {
        error: "Invalid format. Use: provider:anilistId:sub|dub:episodeId",
        tip: "Get episode IDs from /anime/{id} first",
    };
    const provider  = id.slice(0, p1);
    const anilistId = id.slice(p1+1, p2);
    const category  = id.slice(p2+1, p3);
    const episodeId = id.slice(p3+1);
    const data = await pipeFetch("sources", {
        episodeId: b64url(episodeId), provider, category, anilistId,
    });
    const streams = data?.streams || data?.sources || data?.stream || [];
    const sources = streams.map(s => ({
        url:      s.url || null,
        type:     s.type || "hls",
        quality:  s.quality || null,
        codec:    s.codec || null,
        audio:    s.audio || s.server || null,
        referer:  s.referer || null,
        isActive: s.isActive !== undefined ? s.isActive : true,
        ...(s.resolution ? { resolution: s.resolution } : {}),
    }));
    return {
        provider, anilistId, category, episodeId,
        sources,
        subtitles: data?.subtitles || data?.tracks || [],
        download: data?.download || null,
        intro: data?.intro || null,
        outro: data?.outro || null,
        headers: data?.headers || null,
        ...(sources.length === 0 ? { debug_raw: data } : {}),
    };
}

async function GogoDLScrapper(a, b) { return { note: "Use /episode/provider:id:sub|dub:episodeId" }; }
async function getGogoAuthKey() { return ""; }

export { getSearch, getAnime, getRecentAnime, getPopularAnime, getEpisode, GogoDLScrapper, getGogoAuthKey };
