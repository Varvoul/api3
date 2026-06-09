// gogo.js - AniList GraphQL search + Anivexa API for episodes/streams
// Anivexa routes: /episodes/:anilistId, /watch/:provider/:id/sub|dub/:provider-:ep

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

const LIST_FIELDS = `id idMal title{romaji english native userPreferred}
    coverImage{extraLarge large medium} bannerImage
    startDate{year} season seasonYear format status
    episodes duration averageScore meanScore popularity
    genres isAdult nextAiringEpisode{episode airingAt}`;

const FULL_FIELDS = `id idMal title{romaji english native userPreferred}
    coverImage{extraLarge large medium} bannerImage
    startDate{year month day} endDate{year month day}
    season seasonYear format status source
    episodes duration averageScore meanScore popularity
    genres tags{name} description(asHtml:false)
    studios{edges{isMain node{id name}}}
    relations{edges{relationType node{id title{romaji english}type format}}}
    recommendations(perPage:10){edges{node{mediaRecommendation{
        id idMal title{romaji english}coverImage{large}format episodes averageScore
    }}}}
    streamingEpisodes{title thumbnail url site}
    trailer{id site} externalLinks{url site} isAdult`;

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
        link: `https://aniocean.vercel.app/watch/${m.id}`,
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

// ── Anivexa helpers ───────────────────────────────────────────────────────────

async function anivexaGet(path) {
    const res = await fetch(`${ANIVEXA}${path}`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Anivexa ${res.status} for ${path}`);
    return res.json();
}

// ── Exported functions ────────────────────────────────────────────────────────

async function getSearch(name, page = 1) {
    const title = decodeURIComponent(String(name)).trim();
    const data = await al(
        `query($search:String,$page:Int,$perPage:Int){
            Page(page:$page,perPage:$perPage){
                pageInfo{total currentPage lastPage hasNextPage}
                media(search:$search,type:ANIME,sort:SEARCH_MATCH){${LIST_FIELDS}}
            }
        }`,
        { search: title, page: parseInt(page), perPage: 20 }
    );
    return (data.Page?.media || []).map(fmtListItem);
}

async function getAnime(id) {
    const numId = parseInt(id);
    let media = null;

    if (isNaN(numId)) {
        const data = await al(
            `query($s:String){Media(search:$s,type:ANIME){${FULL_FIELDS}}}`,
            { s: decodeURIComponent(String(id)).trim() }
        );
        media = data.Media;
    } else {
        try {
            const data = await al(`query($id:Int){Media(id:$id,type:ANIME){${FULL_FIELDS}}}`, { id: numId });
            media = data.Media;
        } catch(_) {}
        if (!media) {
            const data = await al(`query($id:Int){Media(idMal:$id,type:ANIME){${FULL_FIELDS}}}`, { id: numId });
            media = data.Media;
        }
    }
    if (!media) throw new Error("Not found");

    const anilistId = media.id;

    // Fetch all episodes from Anivexa (aggregates 7 providers)
    let epResponse = null;
    try {
        epResponse = await anivexaGet(`/episodes/${anilistId}`);
    } catch(_) {}

    // Anivexa returns: { providers: { anikoto: { sub: [...], dub: [...] }, allmanga: {...}, ... } }
    const providers_summary = {};
    const episodes = [];

    if (epResponse?.providers) {
        for (const [provName, provData] of Object.entries(epResponse.providers)) {
            providers_summary[provName] = { categories: [] };
            for (const cat of ["sub", "dub"]) {
                const epList = provData[cat] || [];
                if (epList.length === 0) continue;
                providers_summary[provName].categories.push(cat);
                for (const ep of epList) {
                    episodes.push([
                        String(ep.number ?? ep.id),
                        // Anivexa watch URL: /watch/{provider}/{anilistId}/{cat}/{provider}-{epNum}
                        `${provName}:${anilistId}:${cat}:${provName}-${ep.number ?? ep.id}`,
                        {
                            title: ep.title || null,
                            image: ep.image || null,
                            airDate: ep.airDate || null,
                            filler: ep.filler || false,
                        }
                    ]);
                }
            }
        }
        // Sort by episode number
        episodes.sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]));
    }

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
        providers: providers_summary,
    };
}

async function getRecentAnime(page = 1) {
    const data = await al(
        `query($p:Int){Page(page:$p,perPage:24){
            media(type:ANIME,status:RELEASING,sort:UPDATED_AT_DESC){${LIST_FIELDS}}
        }}`,
        { p: parseInt(page) }
    );
    return (data.Page?.media || []).map(fmtListItem);
}

async function getPopularAnime(page = 1, max = 20) {
    const data = await al(
        `query($p:Int,$pp:Int){Page(page:$p,perPage:$pp){
            media(type:ANIME,sort:POPULARITY_DESC){${LIST_FIELDS}}
        }}`,
        { p: parseInt(page), pp: max }
    );
    return (data.Page?.media || []).map(fmtListItem);
}

// getEpisode - episode ID format from /anime response:
// "anikoto:20:sub:anikoto-1"   → GET /watch/anikoto/20/sub/anikoto-1
// "allmanga:20:dub:allmanga-5" → GET /watch/allmanga/20/dub/allmanga-5
async function getEpisode(id) {
    const parts = id.split(":");
    if (parts.length < 4) return {
        error: "Invalid format",
        expected: "provider:anilistId:sub|dub:provider-epNum",
        example: "anikoto:20:sub:anikoto-1",
        tip: "Episode IDs come from /anime/{id} response"
    };

    const [provider, anilistId, category, epSlug] = parts;
    // Anivexa route: /watch/{provider}/{anilistId}/{category}/{epSlug}
    const watchPath = `/watch/${provider}/${anilistId}/${category}/${epSlug}`;

    const data = await anivexaGet(watchPath);

    // Anivexa returns sources/streams depending on provider
    const streams = data?.streams || data?.sources || data?.ssub?.streams || data?.sdub?.streams || [];
    const sources = streams.map(s => ({
        url:      s.url || null,
        type:     s.type || "hls",
        quality:  s.quality || s.resolution || null,
        server:   s.server || s.name || null,
        referer:  s.referer || s.headers?.Referer || null,
        isDefault: s.default || s.isDefault || false,
        priority: s.priority || 0,
        ...(s.headers ? { headers: s.headers } : {}),
    }));

    return {
        provider,
        anilistId,
        category,
        episode: epSlug,
        sources,
        subtitles: data?.subtitles || data?.tracks || data?.captions || [],
        intro: data?.intro || null,
        outro: data?.outro || null,
        download: data?.download || null,
        ...(sources.length === 0 ? { debug_raw: data } : {}),
    };
}

async function GogoDLScrapper(a, b) { return { note: "Use /episode/provider:anilistId:sub|dub:provider-epNum" }; }
async function getGogoAuthKey() { return ""; }

export { getSearch, getAnime, getRecentAnime, getPopularAnime, getEpisode, GogoDLScrapper, getGogoAuthKey };
