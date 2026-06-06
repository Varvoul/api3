// gogo.js - AniList search by title for correct IDs + Jikan for metadata + miruro pipe for streams

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

// ── AniList: search by title → returns id (AniList ID) + idMal ───────────────

async function alSearchByTitle(title) {
    try {
        const res = await fetch(ANILIST, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify({
                query: `query($s:String){
                    Media(search:$s, type:ANIME){
                        id idMal
                        title { romaji english native }
                        status source genres episodes seasonYear averageScore
                        bannerImage description(asHtml:false)
                        coverImage { extraLarge large }
                        studios { edges { isMain node { id name } } }
                        relations { edges { relationType node { id title { romaji } type } } }
                        streamingEpisodes { title thumbnail }
                    }
                }`,
                variables: { s: title }
            }),
        });
        if (!res.ok) return null;
        const json = await res.json();
        return json?.data?.Media || null;
    } catch(_) { return null; }
}

// AniList: lookup by AniList ID
async function alById(alId) {
    try {
        const res = await fetch(ANILIST, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify({
                query: `query($id:Int){
                    Media(id:$id, type:ANIME){
                        id idMal
                        title { romaji english native }
                        status source genres episodes seasonYear averageScore
                        bannerImage description(asHtml:false)
                        coverImage { extraLarge large }
                    }
                }`,
                variables: { id: parseInt(alId) }
            }),
        });
        if (!res.ok) return null;
        const json = await res.json();
        return json?.data?.Media || null;
    } catch(_) { return null; }
}

// AniList: lookup by MAL ID → get AniList ID
async function alByMalId(malId) {
    try {
        const res = await fetch(ANILIST, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify({
                query: `query($id:Int){ Media(idMal:$id, type:ANIME){ id idMal title { romaji english } coverImage { large } startDate { year } } }`,
                variables: { id: parseInt(malId) }
            }),
        });
        if (!res.ok) return null;
        const json = await res.json();
        return json?.data?.Media || null;
    } catch(_) { return null; }
}

// ── Jikan fallback ────────────────────────────────────────────────────────────

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

// Fetch episodes trying both AniList and MAL IDs
async function fetchEpisodes(anilistId, malId) {
    for (const id of [String(anilistId), malId ? String(malId) : null].filter(Boolean)) {
        try {
            const data = await pipeFetch("episodes", { anilistId: id });
            if (data?.providers && Object.keys(data.providers).length > 0) {
                return { data, usedId: id };
            }
        } catch(_) {}
    }
    return { data: null, usedId: String(anilistId) };
}

// ── Build episode list from pipe response ─────────────────────────────────────

function buildEpisodeList(epData, anilistId) {
    const episodes = [];
    const providers_summary = {};
    if (!epData?.providers) return { episodes, providers_summary };
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
    return { episodes, providers_summary };
}

// ── Exported functions ────────────────────────────────────────────────────────

async function getSearch(name, page = 1) {
    // Use Jikan for search (fast, reliable), then resolve AniList IDs in parallel
    const data = await jikan(`/anime?q=${encodeURIComponent(name)}&page=${parseInt(page)}&limit=20&sfw=true`);
    const items = data.data || [];
    const results = await Promise.all(items.map(async a => {
        const al = await alByMalId(a.mal_id);
        return {
            title: a.title_english || a.title || null,
            img: a.images?.jpg?.image_url || null,
            id: al ? String(al.id) : String(a.mal_id),      // AniList ID
            malId: String(a.mal_id),
            anilistId: al ? String(al.id) : null,
            link: `https://www.miruro.to/watch/${al ? al.id : a.mal_id}`,
            releaseDate: a.year ? String(a.year) : null,
        };
    }));
    return results;
}

async function getAnime(id) {
    const numId = parseInt(id);
    if (isNaN(numId)) {
        // Name string — search by title via AniList
        const alMedia = await alSearchByTitle(id);
        if (!alMedia) throw new Error("Not found");
        return _buildAnimeResponse(alMedia);
    }

    // Try as AniList ID first, then as MAL ID
    let alMedia = await alById(numId);
    if (!alMedia) {
        // Try as MAL ID
        alMedia = await alByMalId(numId);
    }

    if (alMedia) {
        return _buildAnimeResponse(alMedia);
    }

    // Final fallback: pure Jikan, no AniList
    const jRes = await jikan(`/anime/${numId}/full`);
    const jd = jRes.data;
    if (!jd) throw new Error("Not found");
    const { data: epData, usedId } = await fetchEpisodes(numId, null);
    const { episodes, providers_summary } = buildEpisodeList(epData, usedId || numId);
    return {
        name: jd.title_english || jd.title,
        image: jd.images?.jpg?.large_image_url || null,
        id: String(numId),
        malId: String(numId),
        genre: (jd.genres || []).map(g => g.name).join(", "),
        type: jd.type || null,
        status: jd.status || null,
        plot_summary: jd.synopsis || null,
        released: jd.year ? String(jd.year) : null,
        episodes,
        total_episodes: jd.episodes || episodes.length,
        score: jd.score || null,
        providers: providers_summary,
        miruro_url: `https://www.miruro.to/watch/${numId}`,
    };
}

async function _buildAnimeResponse(alMedia) {
    const anilistId = alMedia.id;
    const malId = alMedia.idMal;

    // Get Jikan data for richer metadata (score, synopsis etc)
    let jikanData = null;
    if (malId) {
        try {
            const j = await jikan(`/anime/${malId}/full`);
            jikanData = j.data;
        } catch(_) {}
    }

    // Fetch miruro episodes
    const { data: epData, usedId } = await fetchEpisodes(anilistId, malId);
    const { episodes, providers_summary } = buildEpisodeList(epData, usedId || anilistId);

    return {
        name: alMedia.title?.english || alMedia.title?.romaji || jikanData?.title_english || jikanData?.title,
        image: alMedia.coverImage?.extraLarge || alMedia.coverImage?.large || jikanData?.images?.jpg?.large_image_url || null,
        id: String(anilistId),         // ✅ Always AniList ID
        malId: malId ? String(malId) : null,
        genre: alMedia.genres ? alMedia.genres.join(", ") : (jikanData?.genres||[]).map(g=>g.name).join(", "),
        type: jikanData?.type || alMedia.source || null,
        status: alMedia.status || jikanData?.status || null,
        plot_summary: alMedia.description || jikanData?.synopsis || null,
        released: alMedia.seasonYear ? String(alMedia.seasonYear) : (jikanData?.year ? String(jikanData.year) : null),
        episodes,
        total_episodes: alMedia.episodes || jikanData?.episodes || episodes.length,
        score: alMedia.averageScore || (jikanData?.score ? Math.round(jikanData.score * 10) : null),
        providers: providers_summary,
        miruro_url: `https://www.miruro.to/watch/${anilistId}`,
        studios: (alMedia.studios?.edges || []).filter(e => e.isMain).map(e => e.node?.name).filter(Boolean),
        relations: (alMedia.relations?.edges || []).map(e => ({
            type: e.relationType,
            id: String(e.node?.id),
            title: e.node?.title?.romaji,
            mediaType: e.node?.type,
        })),
        streaming_episodes: alMedia.streamingEpisodes || [],
    };
}

async function getRecentAnime(page = 1) {
    const data = await jikan(`/seasons/now?page=${parseInt(page)}&limit=24`);
    return Promise.all((data.data || []).map(async a => {
        const al = await alByMalId(a.mal_id);
        return {
            title: a.title_english || a.title || null,
            episode: `Episode ${a.episodes || "?"}`,
            image: a.images?.jpg?.image_url || null,
            id: al ? String(al.id) : String(a.mal_id),
            malId: String(a.mal_id),
            miruro_url: `https://www.miruro.to/watch/${al ? al.id : a.mal_id}`,
        };
    }));
}

async function getPopularAnime(page = 1, max = 20) {
    const data = await jikan(`/top/anime?page=${parseInt(page)}&limit=${max}&filter=bypopularity`);
    return Promise.all((data.data || []).slice(0, max).map(async a => {
        const al = await alByMalId(a.mal_id);
        return {
            title: a.title_english || a.title || null,
            releaseDate: a.year ? String(a.year) : null,
            image: a.images?.jpg?.image_url || null,
            id: al ? String(al.id) : String(a.mal_id),
            malId: String(a.mal_id),
            miruro_url: `https://www.miruro.to/watch/${al ? al.id : a.mal_id}`,
        };
    }));
}

async function getEpisode(id) {
    // id format: "provider:anilistId:sub|dub:episodeId"
    // episodeId can contain colons (e.g. "animepahe:1571:15779:8")
    const firstColon = id.indexOf(":");
    const secondColon = id.indexOf(":", firstColon + 1);
    const thirdColon = id.indexOf(":", secondColon + 1);

    if (firstColon === -1 || secondColon === -1 || thirdColon === -1) {
        return {
            error: "Invalid format. Use: provider:anilistId:sub|dub:episodeId",
            tip: "Get episode IDs from /anime/{id} first",
        };
    }

    const provider = id.slice(0, firstColon);
    const anilistId = id.slice(firstColon + 1, secondColon);
    const category = id.slice(secondColon + 1, thirdColon);
    const episodeId = id.slice(thirdColon + 1);   // everything after 3rd colon

    // The episodeId must be base64url encoded for the pipe
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
        raw: (data?.sources?.length === 0 && !data?.stream) ? data : undefined,
    };
}

async function GogoDLScrapper(a, b) { return { note: "Use /episode/provider:anilistId:sub|dub:episodeId" }; }
async function getGogoAuthKey() { return ""; }

export { getSearch, getAnime, getRecentAnime, getPopularAnime, getEpisode, GogoDLScrapper, getGogoAuthKey };
