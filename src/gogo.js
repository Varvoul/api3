// gogo.js - AniList ONLY (no Jikan) + miruro pipe for streams

const PIPE = "https://www.miruro.to/api/secure/pipe";
const ANILIST = "https://graphql.anilist.co";

const PIPE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Referer": "https://www.miruro.to/",
    "Origin": "https://www.miruro.to",
    "Accept": "application/json, text/plain, */*",
};

// ── AniList queries ───────────────────────────────────────────────────────────

async function al(query, variables = {}) {
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

// Full media fields for anime detail
const FULL_FIELDS = `
    id idMal
    title { romaji english native }
    status source genres episodes seasonYear averageScore
    bannerImage description(asHtml: false)
    coverImage { extraLarge large }
    studios { edges { isMain node { id name } } }
    relations { edges { relationType node { id title { romaji } type } } }
    streamingEpisodes { title thumbnail }
`;

// Short fields for search listings
const LIST_FIELDS = `
    id idMal
    title { romaji english }
    coverImage { large }
    startDate { year }
`;

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

// Try fetching episodes with both AniList ID and MAL ID
async function fetchEpisodesForId(anilistId, malId) {
    const idsToTry = [...new Set([String(anilistId), malId ? String(malId) : null].filter(Boolean))];
    for (const id of idsToTry) {
        try {
            const data = await pipeFetch("episodes", { anilistId: id });
            if (data?.providers && Object.keys(data.providers).length > 0) {
                return { data, usedId: id };
            }
        } catch(_) {}
    }
    return { data: null, usedId: String(anilistId) };
}

function buildEpisodeList(epData, anilistId) {
    const episodes = [];
    const providers_summary = {};
    if (!epData?.providers) return { episodes, providers_summary };
    deepTranslate(epData);
    for (const [provName, provData] of Object.entries(epData.providers)) {
        const eps = provData?.episodes || {};
        providers_summary[provName] = { streamType: provData?.streamType || "hls", categories: [] };
        for (const [cat, epList] of Object.entries(eps)) {
            if (!Array.isArray(epList)) continue;
            if (!providers_summary[provName].categories.includes(cat))
                providers_summary[provName].categories.push(cat);
            for (const ep of epList) {
                episodes.push([String(ep.number ?? ep.id), `${provName}:${anilistId}:${cat}:${ep.id}`]);
            }
        }
    }
    return { episodes, providers_summary };
}

// ── Format helpers ────────────────────────────────────────────────────────────

function fmtMedia(m) {
    return {
        title: m.title?.english || m.title?.romaji || null,
        img: m.coverImage?.large || null,
        id: String(m.id),          // AniList ID always
        malId: m.idMal ? String(m.idMal) : String(m.id),
        anilistId: String(m.id),
        link: `https://www.miruro.to/watch/${m.id}`,
        releaseDate: m.startDate?.year ? String(m.startDate.year) : null,
    };
}

// ── Exported functions ────────────────────────────────────────────────────────

async function getSearch(name, page = 1) {
    // AniList search — returns AniList IDs directly, no conversion needed
    const data = await al(
        `query($s:String,$p:Int){
            Page(page:$p, perPage:20){
                media(search:$s, type:ANIME, sort:SEARCH_MATCH){ ${LIST_FIELDS} }
            }
        }`,
        { s: name, p: parseInt(page) }
    );
    return (data.Page?.media || []).map(fmtMedia);
}

async function getAnime(id) {
    const numId = parseInt(id);

    if (isNaN(numId)) {
        // Name string — search by title
        const data = await al(
            `query($s:String){ Media(search:$s, type:ANIME){ ${FULL_FIELDS} } }`,
            { s: id }
        );
        if (!data.Media) throw new Error("Not found");
        return _buildResponse(data.Media);
    }

    // Try as AniList ID first
    let media = null;
    try {
        const data = await al(
            `query($id:Int){ Media(id:$id, type:ANIME){ ${FULL_FIELDS} } }`,
            { id: numId }
        );
        media = data.Media;
    } catch(_) {}

    // If not found as AniList ID, try as MAL ID
    if (!media) {
        try {
            const data = await al(
                `query($id:Int){ Media(idMal:$id, type:ANIME){ ${FULL_FIELDS} } }`,
                { id: numId }
            );
            media = data.Media;
        } catch(_) {}
    }

    if (!media) throw new Error("Not found");
    return _buildResponse(media);
}

async function _buildResponse(m) {
    const anilistId = m.id;
    const malId = m.idMal;

    const { data: epData, usedId } = await fetchEpisodesForId(anilistId, malId);
    const { episodes, providers_summary } = buildEpisodeList(epData, usedId || anilistId);

    return {
        name: m.title?.english || m.title?.romaji,
        image: m.coverImage?.extraLarge || m.coverImage?.large || null,
        id: String(anilistId),           // ✅ AniList ID
        malId: malId ? String(malId) : String(anilistId),
        genre: (m.genres || []).join(", "),
        type: m.source || null,
        status: m.status || null,
        plot_summary: m.description || null,
        released: m.seasonYear ? String(m.seasonYear) : null,
        episodes,
        total_episodes: m.episodes || episodes.length,
        score: m.averageScore || null,
        providers: providers_summary,
        miruro_url: `https://www.miruro.to/watch/${anilistId}`,
        studios: (m.studios?.edges||[]).filter(e=>e.isMain).map(e=>e.node?.name).filter(Boolean),
        relations: (m.relations?.edges||[]).map(e=>({
            type: e.relationType,
            id: String(e.node?.id),
            title: e.node?.title?.romaji,
            mediaType: e.node?.type,
        })),
        streaming_episodes: m.streamingEpisodes || [],
    };
}

async function getRecentAnime(page = 1) {
    const data = await al(
        `query($p:Int){
            Page(page:$p, perPage:24){
                media(type:ANIME, status:RELEASING, sort:UPDATED_AT_DESC){
                    id idMal title { romaji english }
                    coverImage { large }
                    nextAiringEpisode { episode }
                    episodes
                }
            }
        }`,
        { p: parseInt(page) }
    );
    return (data.Page?.media || []).map(m => ({
        title: m.title?.english || m.title?.romaji || null,
        episode: m.nextAiringEpisode ? `Episode ${m.nextAiringEpisode.episode - 1}` : `Episode ${m.episodes || "?"}`,
        image: m.coverImage?.large || null,
        id: String(m.id),
        malId: m.idMal ? String(m.idMal) : String(m.id),
        miruro_url: `https://www.miruro.to/watch/${m.id}`,
    }));
}

async function getPopularAnime(page = 1, max = 20) {
    const data = await al(
        `query($p:Int,$pp:Int){
            Page(page:$p, perPage:$pp){
                media(type:ANIME, sort:POPULARITY_DESC){
                    id idMal title { romaji english }
                    coverImage { large }
                    startDate { year }
                }
            }
        }`,
        { p: parseInt(page), pp: max }
    );
    return (data.Page?.media || []).map(m => ({
        title: m.title?.english || m.title?.romaji || null,
        releaseDate: m.startDate?.year ? String(m.startDate.year) : null,
        image: m.coverImage?.large || null,
        id: String(m.id),
        malId: m.idMal ? String(m.idMal) : String(m.id),
        miruro_url: `https://www.miruro.to/watch/${m.id}`,
    }));
}

async function getEpisode(id) {
    // Split only on first 3 colons: provider:anilistId:category:episodeId
    // episodeId itself may contain colons
    const p1 = id.indexOf(":");
    const p2 = id.indexOf(":", p1 + 1);
    const p3 = id.indexOf(":", p2 + 1);

    if (p1 < 0 || p2 < 0 || p3 < 0) {
        return {
            error: "Invalid format. Use: provider:anilistId:sub|dub:episodeId",
            tip: "Get episode IDs from /anime/{id} first",
        };
    }

    const provider  = id.slice(0, p1);
    const anilistId = id.slice(p1 + 1, p2);
    const category  = id.slice(p2 + 1, p3);
    const episodeId = id.slice(p3 + 1);   // full episode ID including any colons

    const encId = b64url(episodeId);

    const data = await pipeFetch("sources", {
        episodeId: encId,
        provider,
        category,
        anilistId,
    });

    // Miruro pipe returns data.streams (not data.sources)
    const streams   = data?.streams  || data?.sources || data?.stream || [];
    const subtitles = data?.subtitles || data?.tracks || [];
    const download  = data?.download || null;

    // Normalise stream objects
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
        provider,
        anilistId,
        category,
        episodeId,
        sources,          // normalised stream list
        subtitles,
        download,
        intro:   data?.intro   || null,
        outro:   data?.outro   || null,
        headers: data?.headers || null,
        ...(sources.length === 0 ? { debug_raw: data } : {}),
    };
}

async function GogoDLScrapper(a, b) { return { note: "Use /episode/provider:anilistId:sub|dub:episodeId" }; }
async function getGogoAuthKey() { return ""; }

export { getSearch, getAnime, getRecentAnime, getPopularAnime, getEpisode, GogoDLScrapper, getGogoAuthKey };
