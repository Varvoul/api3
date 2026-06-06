// gogo.js - AniList IDs throughout (matches miruro.to)
// AniList for search/metadata, Jikan as fallback, miruro pipe for real streams
// All IDs are AniList IDs to match miruro.to exactly

const PIPE = "https://www.miruro.to/api/secure/pipe";
const ANILIST = "https://graphql.anilist.co";
const JIKAN = "https://api.jikan.moe/v4";

const PIPE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Referer": "https://www.miruro.to/",
    "Origin": "https://www.miruro.to",
};

// ── AniList ──────────────────────────────────────────────────────────────────

async function anilist(query, variables = {}) {
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

const AL_FIELDS = `id idMal title { romaji english }
    coverImage { extraLarge large } bannerImage
    format season seasonYear episodes duration status
    averageScore genres description startDate { year }
    nextAiringEpisode { episode airingAt }`;

// ── Jikan fallback ───────────────────────────────────────────────────────────

async function jikan(path) {
    const res = await fetch(`${JIKAN}${path}`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Jikan ${res.status}`);
    return res.json();
}

// Convert MAL ID → AniList ID using AniList's idMal field
async function malToAnilist(malId) {
    const data = await anilist(
        `query($id:Int){Media(idMal:$id,type:ANIME){id idMal title{romaji english}coverImage{large}startDate{year}}}`,
        { id: parseInt(malId) }
    );
    return data.Media;
}

// ── Pipe helpers ─────────────────────────────────────────────────────────────

function b64url(str) {
    return btoa(unescape(encodeURIComponent(str)))
        .replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
}

function b64urlDec(str) {
    str = str.replace(/-/g,"+").replace(/_/g,"/");
    while (str.length % 4) str += "=";
    return decodeURIComponent(escape(atob(str)));
}

async function gunzipCF(b64data) {
    const binary = Uint8Array.from(
        atob(b64data.replace(/-/g,"+").replace(/_/g,"/")),
        c => c.charCodeAt(0)
    );
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

function translateId(encodedId) {
    try {
        const s = atob(encodedId.replace(/-/g,"+").replace(/_/g,"/"));
        if (s.includes(":")) return s;
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

async function pipeFetch(path, query) {
    const payload = { path, method: "GET", query, body: null, version: "0.1.0" };
    const encoded = b64url(JSON.stringify(payload));
    const res = await fetch(`${PIPE}?e=${encoded}`, { headers: PIPE_HEADERS });
    if (!res.ok) throw new Error(`Pipe ${res.status}`);
    const text = await res.text();
    return gunzipCF(text.trim());
}

// ── Main exports ─────────────────────────────────────────────────────────────

async function getSearch(name, page = 1) {
    // Try AniList first (returns AniList IDs directly)
    try {
        const data = await anilist(
            `query($s:String,$p:Int){Page(page:$p,perPage:20){media(search:$s,type:ANIME,sort:SEARCH_MATCH){${AL_FIELDS}}}}`,
            { s: name, p: parseInt(page) }
        );
        return (data.Page?.media || []).map(a => ({
            title: a.title?.english || a.title?.romaji || null,
            img: a.coverImage?.large || null,
            id: String(a.id),          // AniList ID
            malId: a.idMal ? String(a.idMal) : null,
            link: `https://www.miruro.to/watch/${a.id}`,
            releaseDate: a.startDate?.year ? String(a.startDate.year) : null,
        }));
    } catch(e) {
        // Fallback: Jikan search → convert MAL IDs to AniList IDs
        const data = await jikan(`/anime?q=${encodeURIComponent(name)}&page=${parseInt(page)}&limit=20&sfw=true`);
        const results = [];
        for (const a of (data.data || [])) {
            try {
                const al = await malToAnilist(a.mal_id);
                if (al) results.push({
                    title: al.title?.english || al.title?.romaji || a.title,
                    img: al.coverImage?.large || a.images?.jpg?.image_url || null,
                    id: String(al.id),      // AniList ID
                    malId: String(a.mal_id),
                    link: `https://www.miruro.to/watch/${al.id}`,
                    releaseDate: al.startDate?.year ? String(al.startDate.year) : null,
                });
            } catch(_) {}
        }
        return results;
    }
}

async function getAnime(id) {
    // id should be AniList ID; if it looks like a name, search first
    let anilistId = parseInt(id);
    if (isNaN(anilistId)) {
        const r = await getSearch(id);
        if (!r.length) throw new Error("Not found");
        anilistId = parseInt(r[0].id);
    }

    // Fetch AniList metadata + miruro episodes in parallel
    const [alData, episodesData] = await Promise.all([
        anilist(
            `query($id:Int){Media(id:$id,type:ANIME){${AL_FIELDS} synopsis}}`,
            { id: anilistId }
        ),
        pipeFetch("episodes", { anilistId: String(anilistId) }).catch(() => null),
    ]);

    const a = alData.Media;
    if (!a) throw new Error("Not found");

    // Build episode list from all miruro providers with sub/dub
    const episodes = [];
    const providers_summary = {};
    if (episodesData?.providers) {
        deepTranslate(episodesData);
        for (const [provName, provData] of Object.entries(episodesData.providers)) {
            const eps = provData?.episodes || {};
            const streamType = provData?.streamType || "hls";
            providers_summary[provName] = { streamType, categories: [] };
            for (const [category, epList] of Object.entries(eps)) {
                if (!Array.isArray(epList)) continue;
                providers_summary[provName].categories.push(category);
                for (const ep of epList) {
                    episodes.push([
                        String(ep.number ?? ep.id),
                        `${provName}:${anilistId}:${category}:${ep.id}`,
                    ]);
                }
            }
        }
    }

    return {
        name: a.title?.english || a.title?.romaji,
        image: a.coverImage?.extraLarge || a.coverImage?.large || null,
        id: String(anilistId),
        malId: a.idMal ? String(a.idMal) : null,
        genre: (a.genres || []).join(", "),
        type: a.format || null,
        status: a.status || null,
        plot_summary: (a.synopsis || a.description || "").replace(/<[^>]*>/g, ""),
        released: a.startDate?.year ? String(a.startDate.year) : null,
        episodes,
        total_episodes: a.episodes || episodes.length,
        score: a.averageScore || null,
        providers: providers_summary,
        miruro_url: `https://www.miruro.to/watch/${anilistId}`,
        source: "anilist+miruro",
    };
}

async function getRecentAnime(page = 1) {
    try {
        const data = await anilist(
            `query($p:Int){Page(page:$p,perPage:24){media(type:ANIME,status:RELEASING,sort:UPDATED_AT_DESC){${AL_FIELDS}}}}`,
            { p: parseInt(page) }
        );
        return (data.Page?.media || []).map(a => ({
            title: a.title?.english || a.title?.romaji || null,
            episode: a.nextAiringEpisode ? `Episode ${a.nextAiringEpisode.episode - 1}` : `Episode ${a.episodes || "?"}`,
            image: a.coverImage?.large || null,
            id: String(a.id),
            miruro_url: `https://www.miruro.to/watch/${a.id}`,
        }));
    } catch(e) {
        const data = await jikan(`/seasons/now?page=${parseInt(page)}&limit=24`);
        const results = [];
        for (const a of (data.data || [])) {
            try {
                const al = await malToAnilist(a.mal_id);
                if (al) results.push({
                    title: al.title?.english || al.title?.romaji,
                    episode: `Episode ${a.episodes || "?"}`,
                    image: al.coverImage?.large || a.images?.jpg?.image_url,
                    id: String(al.id),
                    miruro_url: `https://www.miruro.to/watch/${al.id}`,
                });
            } catch(_) {}
        }
        return results;
    }
}

async function getPopularAnime(page = 1, max = 20) {
    try {
        const data = await anilist(
            `query($p:Int,$pp:Int){Page(page:$p,perPage:$pp){media(type:ANIME,sort:POPULARITY_DESC){${AL_FIELDS}}}}`,
            { p: parseInt(page), pp: max }
        );
        return (data.Page?.media || []).map(a => ({
            title: a.title?.english || a.title?.romaji || null,
            releaseDate: a.startDate?.year ? String(a.startDate.year) : null,
            image: a.coverImage?.large || null,
            id: String(a.id),
            miruro_url: `https://www.miruro.to/watch/${a.id}`,
        }));
    } catch(e) {
        const data = await jikan(`/top/anime?page=${parseInt(page)}&limit=${max}&filter=bypopularity`);
        const results = [];
        for (const a of (data.data || [])) {
            try {
                const al = await malToAnilist(a.mal_id);
                if (al) results.push({
                    title: al.title?.english || al.title?.romaji,
                    releaseDate: al.startDate?.year ? String(al.startDate.year) : null,
                    image: al.coverImage?.large,
                    id: String(al.id),
                    miruro_url: `https://www.miruro.to/watch/${al.id}`,
                });
            } catch(_) {}
        }
        return results;
    }
}

async function getEpisode(id) {
    // id format: "provider:anilistId:sub|dub:episodeId"
    const parts = id.split(":");
    if (parts.length < 4) {
        return {
            error: "Invalid format. Use: provider:anilistId:sub|dub:episodeId",
            tip: "Get episode IDs from /anime/{anilistId} first",
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
