// anilist.js - AniList with Jikan fallback (AniList blocks CF Worker IPs sometimes)

const ANILIST = "https://graphql.anilist.co";
const JIKAN = "https://api.jikan.moe/v4";

async function alQuery(query, variables = {}) {
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

async function jikan(path) {
    const res = await fetch(`${JIKAN}${path}`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Jikan ${res.status}`);
    return res.json();
}

function jikanToALFormat(a) {
    return {
        id: a.mal_id,
        idMal: a.mal_id,
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
        startDate: { year: a.year || null },
        nextAiringEpisode: null,
    };
}

const AL_FIELDS = `id idMal status title{userPreferred romaji english native}
    bannerImage popularity coverImage{extraLarge large medium color}
    episodes format season description(asHtml:false) seasonYear
    averageScore genres meanScore startDate{year}
    nextAiringEpisode{episode airingAt}`;

async function getAnilistTrending() {
    try {
        const data = await alQuery(
            `query{Page(page:1,perPage:10){media(sort:[TRENDING_DESC,POPULARITY_DESC],type:ANIME){${AL_FIELDS}}}}`
        );
        return { results: data.Page?.media || [] };
    } catch(_) {
        const data = await jikan("/top/anime?filter=airing&limit=10");
        return { results: (data.data || []).map(jikanToALFormat) };
    }
}

async function getAnilistUpcoming(page) {
    try {
        const data = await alQuery(
            `query($p:Int){Page(page:$p,perPage:20){airingSchedules(notYetAired:true){airingAt episode media{${AL_FIELDS}}}}}`,
            { p: parseInt(page) }
        );
        return { results: (data.Page?.airingSchedules||[]).map(s=>({airingAt:s.airingAt,episode:s.episode,media:s.media})) };
    } catch(_) {
        const data = await jikan(`/seasons/upcoming?page=${parseInt(page)}&limit=20`);
        return { results: (data.data || []).map(a => ({ airingAt: null, episode: 1, media: jikanToALFormat(a) })) };
    }
}

async function getAnilistSearch(query) {
    try {
        const data = await alQuery(
            `query($s:String){Page(page:1,perPage:1){media(search:$s,type:ANIME,sort:SEARCH_MATCH){${AL_FIELDS}}}}`,
            { s: query }
        );
        return { results: data.Page?.media || [] };
    } catch(_) {
        const data = await jikan(`/anime?q=${encodeURIComponent(query)}&limit=1`);
        return { results: (data.data || []).map(jikanToALFormat) };
    }
}

async function getAnilistAnime(id) {
    const numId = parseInt(id);
    // Try as AniList ID
    try {
        const data = await alQuery(
            `query($id:Int){Media(id:$id,type:ANIME){${AL_FIELDS}
                recommendations{edges{node{id mediaRecommendation{id meanScore title{romaji english native userPreferred}
                status episodes coverImage{extraLarge large medium color}bannerImage format}}}}}}`,
            { id: numId }
        );
        const m = data.Media;
        if (m) {
            m.recommendations = (m.recommendations?.edges||[]).map(e=>e.node?.mediaRecommendation).filter(Boolean);
            return m;
        }
    } catch(_) {}
    // Try as MAL ID
    try {
        const data = await alQuery(
            `query($id:Int){Media(idMal:$id,type:ANIME){${AL_FIELDS}
                recommendations{edges{node{id mediaRecommendation{id meanScore title{romaji english native userPreferred}
                status episodes coverImage{extraLarge large medium color}bannerImage format}}}}}}`,
            { id: numId }
        );
        const m = data.Media;
        if (m) {
            m.recommendations = (m.recommendations?.edges||[]).map(e=>e.node?.mediaRecommendation).filter(Boolean);
            return m;
        }
    } catch(_) {}
    // Jikan fallback
    const j = await jikan(`/anime/${numId}/full`);
    const m = jikanToALFormat(j.data);
    m.recommendations = [];
    return m;
}

export { getAnilistTrending, getAnilistSearch, getAnilistAnime, getAnilistUpcoming };
