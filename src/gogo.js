// gogo.js - AniList GraphQL search + Anivexa for episodes/streams (AniKoto provider)

const ANILIST = "https://graphql.anilist.co";
const ANIVEXA = "https://anivexa.bionmovies47.workers.dev";

// ── AniList GraphQL ────────────────────────────────────────────────────────────

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
    season seasonYear format status
    episodes duration averageScore meanScore popularity
    genres isAdult
    nextAiringEpisode { episode airingAt }
`;

const FULL_FIELDS = `
    id idMal
    title { romaji english native userPreferred }
    coverImage { extraLarge large medium }
    bannerImage
    startDate { year month day }
    endDate { year month day }
    season seasonYear format status source
    episodes duration averageScore meanScore popularity
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

function fmtListItem(m) {
    return {
        id: String(m.id),
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

// ── Anivexa API helpers ───────────────────────────────────────────────────────

async function anivexa(path) {
    const res = await fetch(`${ANIVEXA}${path}`, {
        headers: { "Accept": "application/json" }
    });
    if (!res.ok) throw new Error(`Anivexa ${res.status}`);
    return res.json();
}

// ── Exported functions ────────────────────────────────────────────────────────

async function getSearch(name, page = 1) {
    const title = decodeURIComponent(String(name)).trim();
    const data = await al(
        `query($search: String, $page: Int, $perPage: Int) {
            Page(page: $page, perPage: $perPage) {
                pageInfo { total currentPage lastPage hasNextPage }
                media(search: $search, type: ANIME, sort: SEARCH_MATCH) { ${LIST_FIELDS} }
            }
        }`,
        { search: title, page: parseInt(page), perPage: 20 }
    );
    return (data.Page?.media || []).map(fmtListItem);
}

async function getAnime(id) {
    const numId = parseInt(id);

    // Resolve AniList media
    let media = null;
    if (isNaN(numId)) {
        // Name string
        const data = await al(
            `query($s: String) { Media(search: $s, type: ANIME) { ${FULL_FIELDS} } }`,
            { s: decodeURIComponent(String(id)).trim() }
        );
        media = data.Media;
    } else {
        // Try as AniList ID first
        try {
            const data = await al(`query($id: Int) { Media(id: $id, type: ANIME) { ${FULL_FIELDS} } }`, { id: numId });
            media = data.Media;
        } catch(_) {}
        // Fallback: try as MAL ID
        if (!media) {
            const data = await al(`query($id: Int) { Media(idMal: $id, type: ANIME) { ${FULL_FIELDS} } }`, { id: numId });
            media = data.Media;
        }
    }
    if (!media) throw new Error("Not found");

    const anilistId = media.id;

    // Fetch episodes from Anivexa (AniKoto provider)
    let episodesData = null;
    try {
        episodesData = await anivexa(`/episodes/anikoto/${anilistId}`);
    } catch(_) {}

    const subEps = episodesData?.episodes?.sub || [];
    const dubEps = episodesData?.episodes?.dub || [];

    // Build unified episode list
    const episodes = [];
    for (const ep of subEps) {
        episodes.push([String(ep.number), ep.id, "sub", {
            title: ep.title,
            image: ep.image,
            airDate: ep.airDate,
            filler: ep.filler,
            hasDub: false,
        }]);
    }
    // Mark which episodes have dub
    const dubNums = new Set(dubEps.map(e => e.number));
    for (const ep of episodes) ep[3].hasDub = dubNums.has(parseInt(ep[0]));

    // Add dub-only entries (episodes that have dub but not sub)
    const subNums = new Set(subEps.map(e => e.number));
    for (const ep of dubEps) {
        if (!subNums.has(ep.number)) {
            episodes.push([String(ep.number), ep.id, "dub", {
                title: ep.title,
                image: ep.image,
                airDate: ep.airDate,
                filler: ep.filler,
                hasDub: true,
            }]);
        }
    }
    episodes.sort((a, b) => parseInt(a[0]) - parseInt(b[0]));

    const recs = (media.recommendations?.edges || [])
        .map(e => e.node?.mediaRecommendation).filter(Boolean)
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
        malId: media.idMal ? String(media.idMal) : String(anilistId),
        anilistId: String(anilistId),
        name: media.title?.english || media.title?.romaji || media.title?.userPreferred,
        title_romaji: media.title?.romaji || null,
        title_english: media.title?.english || null,
        title_native: media.title?.native || null,
        image: media.coverImage?.extraLarge || media.coverImage?.large || null,
        banner: media.bannerImage || null,
        format: media.format || null,
        status: media.status || null,
        source: media.source || null,
        season: media.season || null,
        seasonYear: media.seasonYear || null,
        released: media.startDate?.year ? String(media.startDate.year) : null,
        startDate: media.startDate || null,
        endDate: media.endDate || null,
        episodes,
        total_episodes: media.episodes || episodes.length,
        duration: media.duration || null,
        score: media.averageScore || null,
        popularity: media.popularity || null,
        genres: media.genres || [],
        tags: (media.tags || []).map(t => t.name),
        plot_summary: media.description || null,
        studios: (media.studios?.edges||[]).filter(e=>e.isMain).map(e=>e.node?.name).filter(Boolean),
        relations: (media.relations?.edges||[]).map(e=>({
            type: e.relationType,
            id: String(e.node?.id),
            title: e.node?.title?.english || e.node?.title?.romaji,
            mediaType: e.node?.type,
            format: e.node?.format,
        })),
        recommendations: recs,
        streaming_episodes: media.streamingEpisodes || [],
        trailer: media.trailer || null,
        external_links: media.externalLinks || [],
        miruro_url: `https://www.miruro.to/watch/${anilistId}`,
        providers: {
            anikoto: {
                sub: subEps.length,
                dub: dubEps.length,
            }
        },
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

// getEpisode: fetch real streams from Anivexa
// id format: "watch/anikoto/{anilistId}/sub/anikoto-{epNum}"
async function getEpisode(id) {
    // Support the Anivexa episode ID format directly
    if (id.startsWith("watch/anikoto/")) {
        const data = await anivexa(`/${id}`);
        const result = data?.ssub || data?.sdub || data;
        return {
            episodeId: id,
            sources: (result?.streams || []).map(s => ({
                url: s.url || null,
                type: s.type || "hls",
                quality: s.quality || null,
                server: s.server || null,
                referer: s.referer || null,
                isDefault: s.default || false,
                priority: s.priority || 0,
            })),
            subtitles: result?.subtitles || [],
            intro: result?.intro || null,
            outro: result?.outro || null,
            provider: result?.provider || "anikoto",
        };
    }

    // Legacy miruro format: provider:anilistId:sub|dub:episodeId
    const p1 = id.indexOf(":");
    const p2 = id.indexOf(":", p1 + 1);
    const p3 = id.indexOf(":", p2 + 1);
    if (p1 < 0 || p2 < 0 || p3 < 0) return {
        error: "Use episode ID from /anime/{id} response",
        formats: [
            "watch/anikoto/{anilistId}/sub/anikoto-{epNum}",
            "watch/anikoto/{anilistId}/dub/anikoto-{epNum}"
        ]
    };

    const provider = id.slice(0, p1);
    const anilistId = id.slice(p1+1, p2);
    const category = id.slice(p2+1, p3);
    const epNum = id.slice(p3+1).replace("anikoto-","");

    const data = await anivexa(`/watch/anikoto/${anilistId}/${category}/anikoto-${epNum}`);
    const result = data?.ssub || data?.sdub || data;
    return {
        provider, anilistId, category, episode: epNum,
        sources: (result?.streams || []).map(s => ({
            url: s.url || null,
            type: s.type || "hls",
            quality: s.quality || null,
            server: s.server || null,
            referer: s.referer || null,
            isDefault: s.default || false,
        })),
        subtitles: result?.subtitles || [],
        intro: result?.intro || null,
        outro: result?.outro || null,
    };
}

async function GogoDLScrapper(a, b) { return { note: "Use /episode/{episodeId} where episodeId comes from /anime/{id}" }; }
async function getGogoAuthKey() { return ""; }

export { getSearch, getAnime, getRecentAnime, getPopularAnime, getEpisode, GogoDLScrapper, getGogoAuthKey };
