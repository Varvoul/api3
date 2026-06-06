// gogo.js - Powered by Miruro.to pipe API + AniList
// Episodes & streaming from miruro.to, metadata from AniList GraphQL

const MIRURO_PIPE = "https://www.miruro.to/api/secure/pipe";
const ANILIST_URL = "https://graphql.anilist.co";

const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Referer": "https://www.miruro.to/",
};

// --- Miruro pipe helpers ---
function encodePipe(payload) {
    return btoa(JSON.stringify(payload))
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function decodePipeResponse(text) {
    // Miruro returns gzip+base64url encoded response
    // In Workers we use DecompressionStream
    const b64 = text.trim().replace(/-/g, "+").replace(/_/g, "/");
    const binary = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    writer.write(binary);
    writer.close();
    let chunks = [];
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
    }
    const total = chunks.reduce((a, c) => a + c.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder().decode(result));
}

async function pipeFetch(path, query) {
    const payload = { path, method: "GET", query, body: null, version: "0.1.0" };
    const encoded = encodePipe(payload);
    const res = await fetch(`${MIRURO_PIPE}?e=${encoded}`, { headers: HEADERS });
    if (!res.ok) throw new Error(`Pipe failed: ${res.status}`);
    const text = await res.text();
    return decodePipeResponse(text);
}

// --- AniList helpers ---
async function anilistQuery(query, variables) {
    const res = await fetch(ANILIST_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    return json.data || {};
}

const LIST_FIELDS = `
    id idMal title { romaji english } coverImage { large extraLarge }
    bannerImage format season seasonYear episodes duration status
    averageScore genres startDate { year } nextAiringEpisode { episode airingAt }
`;

// --- Exported functions (same signatures as original gogo.js) ---

async function getSearch(name, page = 1) {
    const gql = `query ($s: String, $p: Int) {
        Page(page: $p, perPage: 20) {
            media(search: $s, type: ANIME, sort: SEARCH_MATCH) { ${LIST_FIELDS} }
        }
    }`;
    const data = await anilistQuery(gql, { s: name, p: parseInt(page) });
    return (data.Page?.media || []).map(a => ({
        title: a.title?.english || a.title?.romaji || null,
        img: a.coverImage?.large || null,
        id: String(a.id),
        link: `https://www.miruro.to/watch/${a.id}`,
        releaseDate: String(a.startDate?.year || ""),
    }));
}

async function getAnime(id) {
    const malId = parseInt(id);
    if (isNaN(malId)) {
        const results = await getSearch(id);
        if (!results.length) throw new Error("Not found");
        return getAnime(results[0].id);
    }
    const gql = `query ($id: Int) {
        Media(id: $id, type: ANIME) {
            ${LIST_FIELDS}
            description synopsis
            recommendations(perPage: 8) {
                nodes { mediaRecommendation { id title { romaji english } coverImage { large } } }
            }
        }
    }`;
    const data = await anilistQuery(gql, { id: malId });
    const a = data.Media;
    if (!a) throw new Error("Not found");

    // Get episodes from miruro pipe
    let episodes = [];
    try {
        const epData = await pipeFetch("episodes", { anilistId: String(malId) });
        const providers = epData.providers || {};
        // Prefer zoro/kiwi provider, get sub episodes
        const providerName = Object.keys(providers)[0];
        if (providerName) {
            const provEps = providers[providerName]?.episodes;
            const epList = provEps?.sub || provEps?.dub || (Array.isArray(provEps) ? provEps : []);
            episodes = epList.map(ep => [String(ep.number || ep.id), `${providerName}:${String(malId)}:sub:${ep.id || ep.number}`]);
        }
    } catch (e) {
        episodes = [];
    }

    return {
        name: a.title?.english || a.title?.romaji,
        image: a.coverImage?.extraLarge || a.coverImage?.large || null,
        id: String(malId),
        genre: (a.genres || []).join(", "),
        type: a.format || null,
        status: a.status || null,
        plot_summary: a.description?.replace(/<[^>]*>/g, "") || null,
        released: String(a.startDate?.year || ""),
        episodes,
        total_episodes: a.episodes || episodes.length,
        score: a.averageScore || null,
        source: "miruro+anilist",
    };
}

async function getRecentAnime(page = 1) {
    const gql = `query ($p: Int) {
        Page(page: $p, perPage: 24) {
            media(type: ANIME, status: RELEASING, sort: UPDATED_AT_DESC) { ${LIST_FIELDS} }
        }
    }`;
    const data = await anilistQuery(gql, { p: parseInt(page) });
    return (data.Page?.media || []).map(a => ({
        title: a.title?.english || a.title?.romaji || null,
        episode: a.nextAiringEpisode ? `Episode ${a.nextAiringEpisode.episode - 1}` : `Episode ${a.episodes || "?"}`,
        image: a.coverImage?.large || null,
        link: `https://www.miruro.to/watch/${a.id}`,
        id: String(a.id),
    }));
}

async function getPopularAnime(page = 1, max = 20) {
    const gql = `query ($p: Int, $pp: Int) {
        Page(page: $p, perPage: $pp) {
            media(type: ANIME, sort: POPULARITY_DESC) { ${LIST_FIELDS} }
        }
    }`;
    const data = await anilistQuery(gql, { p: parseInt(page), pp: max });
    return (data.Page?.media || []).map(a => ({
        title: a.title?.english || a.title?.romaji || null,
        releaseDate: String(a.startDate?.year || ""),
        image: a.coverImage?.large || null,
        link: `https://www.miruro.to/watch/${a.id}`,
        id: String(a.id),
    }));
}

async function getEpisode(episodeSlug) {
    // episodeSlug format: "provider:anilistId:category:episodeId"
    // e.g. "zoro:21:sub:abc123"
    try {
        const parts = episodeSlug.split(":");
        if (parts.length < 4) throw new Error("Invalid episode ID format. Use provider:anilistId:category:episodeId");
        const [provider, anilistId, category, episodeId] = parts;
        const data = await pipeFetch("sources", {
            episodeId: btoa(episodeId).replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,""),
            provider,
            category,
            anilistId,
        });
        return {
            provider,
            anilistId,
            category,
            sources: data.sources || data.stream || data,
        };
    } catch (e) {
        return { error: e.message, note: "Episode ID format: provider:anilistId:sub|dub:episodeId. Get episode IDs from /anime/{anilistId}" };
    }
}

async function GogoDLScrapper(animeid, cookie) {
    return { note: "Use /episode/ endpoint for streaming sources via miruro.to" };
}

async function getGogoAuthKey() { return ""; }

export { getSearch, getAnime, getRecentAnime, getPopularAnime, getEpisode, GogoDLScrapper, getGogoAuthKey };
