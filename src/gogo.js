// gogo.js - Uses AniList API for all data + miruro.to watch links
// No scraping, no gzip decode issues - 100% reliable

const ANILIST_URL = "https://graphql.anilist.co";

async function anilist(query, variables = {}) {
    const res = await fetch(ANILIST_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    if (json.errors) throw new Error(json.errors[0].message);
    return json.data;
}

const FIELDS = `id idMal title { romaji english native }
    coverImage { extraLarge large } bannerImage format season seasonYear
    episodes duration status averageScore genres description
    startDate { year } nextAiringEpisode { episode airingAt }`;

async function getSearch(name, page = 1) {
    const data = await anilist(
        `query($s:String,$p:Int){Page(page:$p,perPage:20){media(search:$s,type:ANIME,sort:SEARCH_MATCH){${FIELDS}}}}`,
        { s: name, p: parseInt(page) }
    );
    return (data.Page?.media || []).map(formatAnime);
}

async function getAnime(id) {
    const numId = parseInt(id);
    if (isNaN(numId)) {
        const r = await getSearch(id);
        if (!r.length) throw new Error("Not found");
        return getAnime(r[0].id);
    }
    const data = await anilist(
        `query($id:Int){Media(id:$id,type:ANIME){${FIELDS}
            recommendations{edges{node{mediaRecommendation{id title{romaji english}coverImage{large}}}}}
        }}`,
        { id: numId }
    );
    const a = data.Media;
    if (!a) throw new Error("Not found");

    // Build episode list with miruro watch links
    const total = a.episodes || 0;
    const episodes = [];
    for (let i = 1; i <= Math.min(total, 1000); i++) {
        episodes.push([String(i), `https://www.miruro.to/watch/${numId}?ep=${i}`]);
    }

    return {
        name: a.title?.english || a.title?.romaji,
        image: a.coverImage?.extraLarge || a.coverImage?.large || null,
        id: String(numId),
        malId: a.idMal ? String(a.idMal) : null,
        genre: (a.genres || []).join(", "),
        type: a.format || null,
        status: a.status || null,
        plot_summary: (a.description || "").replace(/<[^>]*>/g, ""),
        released: String(a.startDate?.year || ""),
        episodes,
        total_episodes: total,
        score: a.averageScore || null,
        miruro_url: `https://www.miruro.to/watch/${numId}`,
        source: "anilist+miruro",
        recommendations: (a.recommendations?.edges || [])
            .map(e => e.node?.mediaRecommendation)
            .filter(Boolean)
            .map(r => ({
                id: String(r.id),
                title: r.title?.english || r.title?.romaji,
                image: r.coverImage?.large,
                miruro_url: `https://www.miruro.to/watch/${r.id}`,
            })),
    };
}

async function getRecentAnime(page = 1) {
    const data = await anilist(
        `query($p:Int){Page(page:$p,perPage:24){media(type:ANIME,status:RELEASING,sort:UPDATED_AT_DESC){${FIELDS}}}}`,
        { p: parseInt(page) }
    );
    return (data.Page?.media || []).map(a => ({
        title: a.title?.english || a.title?.romaji || null,
        episode: a.nextAiringEpisode
            ? `Episode ${a.nextAiringEpisode.episode - 1}`
            : `Episode ${a.episodes || "?"}`,
        image: a.coverImage?.large || null,
        id: String(a.id),
        miruro_url: `https://www.miruro.to/watch/${a.id}`,
    }));
}

async function getPopularAnime(page = 1, max = 20) {
    const data = await anilist(
        `query($p:Int,$pp:Int){Page(page:$p,perPage:$pp){media(type:ANIME,sort:POPULARITY_DESC){${FIELDS}}}}`,
        { p: parseInt(page), pp: max }
    );
    return (data.Page?.media || []).map(a => ({
        title: a.title?.english || a.title?.romaji || null,
        releaseDate: String(a.startDate?.year || ""),
        image: a.coverImage?.large || null,
        id: String(a.id),
        miruro_url: `https://www.miruro.to/watch/${a.id}`,
    }));
}

async function getEpisode(id) {
    // id = "anilistId-epNum" e.g. "20-1" for Naruto ep 1
    // Returns miruro embed URL for the episode
    const parts = id.split("-");
    const epNum = parts[parts.length - 1];
    const anilistId = parts.slice(0, -1).join("-");
    const miruroUrl = `https://www.miruro.to/watch/${anilistId}?ep=${epNum}`;
    return {
        anilistId,
        episode: epNum,
        miruro_watch_url: miruroUrl,
        embed_url: `https://www.miruro.to/embed/${anilistId}?ep=${epNum}&autoPlay=true`,
        note: "Open miruro_watch_url in browser to stream with sub/dub options",
    };
}

async function GogoDLScrapper(animeid, cookie) {
    return { note: "Use /episode/{anilistId}-{epNum} to get miruro.to watch links" };
}

async function getGogoAuthKey() { return ""; }

function formatAnime(a) {
    return {
        title: a.title?.english || a.title?.romaji || null,
        img: a.coverImage?.large || null,
        id: String(a.id),
        link: `https://www.miruro.to/watch/${a.id}`,
        releaseDate: String(a.startDate?.year || ""),
    };
}

export { getSearch, getAnime, getRecentAnime, getPopularAnime, getEpisode, GogoDLScrapper, getGogoAuthKey };
