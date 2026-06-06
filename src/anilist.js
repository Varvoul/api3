// anilist.js - Rewritten to use Jikan v4 API (AniList is down)
// Same exported function signatures - index.js unchanged

const JIKAN = "https://api.jikan.moe/v4";

async function jikan(path) {
    const res = await fetch(`${JIKAN}${path}`, {
        headers: { "Accept": "application/json" }
    });
    if (!res.ok) throw new Error(`Jikan ${res.status}: ${path}`);
    return res.json();
}

function formatMedia(a) {
    return {
        id: a.mal_id,
        status: a.status || null,
        title: {
            userPreferred: a.title_english || a.title,
            romaji: a.title,
            english: a.title_english || a.title,
            native: a.title_japanese || null,
        },
        bannerImage: null,
        popularity: a.members || 0,
        coverImage: {
            extraLarge: a.images?.jpg?.large_image_url || null,
            large: a.images?.jpg?.large_image_url || null,
            medium: a.images?.jpg?.image_url || null,
            color: null,
        },
        episodes: a.episodes || null,
        format: a.type || null,
        season: a.season || null,
        description: a.synopsis || null,
        seasonYear: a.year || null,
        averageScore: a.score ? Math.round(a.score * 10) : null,
        genres: (a.genres || []).map(g => g.name),
        meanScore: a.score ? Math.round(a.score * 10) : null,
    };
}

async function getAnilistTrending() {
    const data = await jikan("/top/anime?filter=airing&limit=10");
    return { results: (data.data || []).map(formatMedia) };
}

async function getAnilistUpcoming(page) {
    const data = await jikan(`/seasons/upcoming?page=${parseInt(page)}&limit=20`);
    const results = (data.data || []).map(a => ({
        airingAt: null,
        episode: 1,
        media: formatMedia(a),
    }));
    return { results };
}

async function getAnilistSearch(query) {
    const data = await jikan(`/anime?q=${encodeURIComponent(query)}&limit=1&sfw=true`);
    return { results: (data.data || []).map(formatMedia) };
}

async function getAnilistAnime(id) {
    const data = await jikan(`/anime/${parseInt(id)}/full`);
    const a = data.data;
    if (!a) throw new Error("Not found");

    const result = formatMedia(a);
    // Fetch recommendations
    try {
        const recData = await jikan(`/anime/${parseInt(id)}/recommendations`);
        result.recommendations = (recData.data || []).slice(0, 8).map(r => ({
            id: r.entry?.mal_id,
            meanScore: null,
            title: {
                romaji: r.entry?.title,
                english: r.entry?.title,
                native: null,
                userPreferred: r.entry?.title,
            },
            status: null,
            episodes: null,
            coverImage: {
                extraLarge: r.entry?.images?.jpg?.large_image_url || null,
                large: r.entry?.images?.jpg?.image_url || null,
                medium: r.entry?.images?.jpg?.image_url || null,
                color: null,
            },
            bannerImage: null,
            format: null,
        }));
    } catch(e) {
        result.recommendations = [];
    }
    return result;
}

export { getAnilistTrending, getAnilistSearch, getAnilistAnime, getAnilistUpcoming };
