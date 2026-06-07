// gogo.js - Pure AniList GraphQL + miruro pipe

const PIPE = "https://www.miruro.to/api/secure/pipe";
const ANILIST = "https://graphql.anilist.co";

const PIPE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Referer": "https://www.miruro.to/",
    "Origin": "https://www.miruro.to",
    "Accept": "application/json, text/plain, */*",
};

// ── AniList GraphQL ───────────────────────────────────────────────────────────

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

const LIST_FIELDS = `
    id idMal
    title { romaji english native userPreferred }
    coverImage { extraLarge large medium }
    bannerImage
    startDate { year }
    season seasonYear
    format status
    episodes duration
    averageScore meanScore popularity
    genres
    isAdult
    nextAiringEpisode { episode airingAt }
`;

const FULL_FIELDS = `
    id idMal
    title { romaji english native userPreferred }
    coverImage { extraLarge large medium }
    bannerImage
    startDate { year month day }
    endDate { year month day }
    season seasonYear
    format status source
    episodes duration
    averageScore meanScore popularity
    genres tags { name }
    description(asHtml: false)
    studios { edges { isMain node { id name } } }
    relations { edges { relationType node { id title { romaji english } type format } } }
    recommendations(perPage: 10) {
        edges { node { mediaRecommendation {
            id idMal title { romaji english }
            coverImage { large } format episodes averageScore
        }}}
    }
    streamingEpisodes { title thumbnail url site }
    trailer { id site }
    externalLinks { url site }
    isAdult
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

function fmtListItem(m) {
    return {
        id: String(m.id),               // AniList ID
        malId: m.idMal ? String(m.idMal) : String(m.id),
        anilistId: String(m.id),
        title: m.title?.english || m.title?.romaji || m.title?.userPreferred || null,
        title_romaji: m.title?.romaji || null,
        title_english: m.title?.english || null,
        title_native: m.title?.native || null,
        img: m.coverImage?.large || m.coverImage?.medium || null,
        banner: m.bannerImage || null,
        link: `https://www.miruro.to/watch/${m.id}`,
        releaseDate: m.startDate?.year ? String(m.startDate.year) : null,
        season: m.season || null,
        seasonYear: m.seasonYear || null,
        format: m.format || null,
        status: m.status || null,
        episodes: m.episodes || null,
        duration: m.duration || null,
        score: m.averageScore || m.meanScore || null,
        popularity: m.popularity || null,
        genres: m.genres || [],
        isAdult: m.isAdult || false,
        nextAiring: m.nextAiringEpisode || null,
    };
}

// ── Exported functions ────────────────────────────────────────────────────────

// getSearch: extract title from URL slug, query AniList GraphQL, return AniList IDs
async function getSearch(name, page = 1) {
    // name comes from the URL: /search/naruto → name = "naruto"
    // decode any URL encoding and clean up
    const title = decodeURIComponent(name).trim();

    const data = await al(
        `query($search: String, $page: Int, $perPage: Int) {
            Page(page: $page, perPage: $perPage) {
                pageInfo { total currentPage lastPage hasNextPage }
                media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
                    ${LIST_FIELDS}
                }
            }
        }`,
        { search: title, page: parseInt(page), perPage: 20 }
    );

    return (data.Page?.media || []).map(fmtListItem);
}

async function getAnime(id) {
    const numId = parseInt(id);

    if (isNaN(numId)) {
        // Treat as title string
        const data = await al(
            `query($search: String) { Media(search: $search, type: ANIME) { ${FULL_FIELDS} } }`,
            { search: decodeURIComponent(id).trim() }
        );
        if (!data.Media) throw new Error("Not found");
        return _buildAnimeResponse(data.Media);
    }

    // Try as AniList ID first
    let media = null;
    try {
        const data = await al(
            `query($id: Int) { Media(id: $id, type: ANIME) { ${FULL_FIELDS} } }`,
            { id: numId }
        );
        media = data.Media;
    } catch(_) {}

    // Fallback: try as MAL ID
    if (!media) {
        try {
            const data = await al(
                `query($id: Int) { Media(idMal: $id, type: ANIME) { ${FULL_FIELDS} } }`,
                { id: numId }
            );
            media = data.Media;
        } catch(_) {}
    }

    if (!media) throw new Error("Not found");
    return _buildAnimeResponse(media);
}

async function _buildAnimeResponse(m) {
    const anilistId = m.id;
    const malId = m.idMal;

    const { data: epData, usedId } = await fetchEpisodes(anilistId, malId);
    const { episodes, providers } = buildEpisodes(epData, usedId || anilistId);

    const recs = (m.recommendations?.edges || [])
        .map(e => e.node?.mediaRecommendation)
        .filter(Boolean)
        .map(r => ({
            id: String(r.id),
            malId: r.idMal ? String(r.idMal) : String(r.id),
            title: r.title?.english || r.title?.romaji,
            img: r.coverImage?.large,
            format: r.format,
            episodes: r.episodes,
            score: r.averageScore,
        }));

    return {
        id: String(anilistId),
        malId: malId ? String(malId) : String(anilistId),
        anilistId: String(anilistId),
        name: m.title?.english || m.title?.romaji || m.title?.userPreferred,
        title_romaji: m.title?.romaji || null,
        title_english: m.title?.english || null,
        title_native: m.title?.native || null,
        image: m.coverImage?.extraLarge || m.coverImage?.large || null,
        banner: m.bannerImage || null,
        format: m.format || null,
        status: m.status || null,
        source: m.source || null,
        season: m.season || null,
        seasonYear: m.seasonYear || null,
        released: m.startDate?.year ? String(m.startDate.year) : null,
        startDate: m.startDate || null,
        endDate: m.endDate || null,
        episodes,
        total_episodes: m.episodes || episodes.length,
        duration: m.duration || null,
        score: m.averageScore || null,
        meanScore: m.meanScore || null,
        popularity: m.popularity || null,
        genres: m.genres || [],
        tags: (m.tags || []).map(t => t.name),
        plot_summary: m.description || null,
        studios: (m.studios?.edges||[]).filter(e=>e.isMain).map(e=>e.node?.name).filter(Boolean),
        relations: (m.relations?.edges||[]).map(e=>({
            type: e.relationType,
            id: String(e.node?.id),
            title: e.node?.title?.english || e.node?.title?.romaji,
            mediaType: e.node?.type,
            format: e.node?.format,
        })),
        recommendations: recs,
        streaming_episodes: m.streamingEpisodes || [],
        trailer: m.trailer || null,
        external_links: m.externalLinks || [],
        providers,
        miruro_url: `https://www.miruro.to/watch/${anilistId}`,
    };
}

async function getRecentAnime(page = 1) {
    const data = await al(
        `query($p: Int) {
            Page(page: $p, perPage: 24) {
                media(type: ANIME, status: RELEASING, sort: UPDATED_AT_DESC) { ${LIST_FIELDS} }
            }
        }`,
        { p: parseInt(page) }
    );
    return (data.Page?.media || []).map(fmtListItem);
}

async function getPopularAnime(page = 1, max = 20) {
    const data = await al(
        `query($p: Int, $pp: Int) {
            Page(page: $p, perPage: $pp) {
                media(type: ANIME, sort: POPULARITY_DESC) { ${LIST_FIELDS} }
            }
        }`,
        { p: parseInt(page), pp: max }
    );
    return (data.Page?.media || []).map(fmtListItem);
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

async function GogoDLScrapper(a, b) { return { note: "Use /episode/provider:anilistId:sub|dub:episodeId" }; }
async function getGogoAuthKey() { return ""; }

export { getSearch, getAnime, getRecentAnime, getPopularAnime, getEpisode, GogoDLScrapper, getGogoAuthKey };
