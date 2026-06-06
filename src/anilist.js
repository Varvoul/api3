// anilist.js - AniList primary, Jikan fallback, all IDs are AniList IDs

const ANILIST = "https://graphql.anilist.co";
const JIKAN = "https://api.jikan.moe/v4";

async function anilistQuery(query, variables = {}) {
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

async function jikanFetch(path) {
    const res = await fetch(`${JIKAN}${path}`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Jikan ${res.status}`);
    return res.json();
}

async function malToAnilistMedia(malId) {
    const data = await anilistQuery(
        `query($id:Int){Media(idMal:$id,type:ANIME){id idMal title{romaji english userPreferred}coverImage{extraLarge large medium color}bannerImage format season seasonYear episodes averageScore genres description status startDate{year}}}`,
        { id: parseInt(malId) }
    );
    return data.Media;
}

function fmtJikanToAL(a, alMedia) {
    return {
        id: alMedia?.id || a.mal_id,
        idMal: a.mal_id,
        status: a.status || null,
        title: {
            userPreferred: alMedia?.title?.english || a.title,
            romaji: a.title,
            english: a.title_english || a.title,
            native: a.title_japanese || null,
        },
        bannerImage: alMedia?.bannerImage || null,
        popularity: a.members || 0,
        coverImage: {
            extraLarge: alMedia?.coverImage?.extraLarge || a.images?.jpg?.large_image_url || null,
            large: alMedia?.coverImage?.large || a.images?.jpg?.large_image_url || null,
            medium: alMedia?.coverImage?.medium || a.images?.jpg?.image_url || null,
            color: alMedia?.coverImage?.color || null,
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

const AL_FIELDS = `id idMal status title{userPreferred romaji english native}
    bannerImage popularity coverImage{extraLarge large medium color}
    episodes format season description seasonYear averageScore genres meanScore`;

async function getAnilistTrending() {
    try {
        const data = await anilistQuery(
            `query{Page(page:1,perPage:10){media(sort:[TRENDING_DESC,POPULARITY_DESC],type:ANIME){${AL_FIELDS}}}}`
        );
        return { results: data.Page?.media || [] };
    } catch(e) {
        const data = await jikanFetch("/top/anime?filter=airing&limit=10");
        const results = [];
        for (const a of (data.data || [])) {
            try { results.push(fmtJikanToAL(a, await malToAnilistMedia(a.mal_id))); } catch(_) {}
        }
        return { results };
    }
}

async function getAnilistUpcoming(page) {
    try {
        const data = await anilistQuery(
            `query($p:Int){Page(page:$p,perPage:20){airingSchedules(notYetAired:true){airingAt episode media{${AL_FIELDS}}}}}`,
            { p: parseInt(page) }
        );
        return { results: (data.Page?.airingSchedules || []).map(s => ({ airingAt: s.airingAt, episode: s.episode, media: s.media })) };
    } catch(e) {
        const data = await jikanFetch(`/seasons/upcoming?page=${parseInt(page)}&limit=20`);
        const results = [];
        for (const a of (data.data || [])) {
            try { results.push({ airingAt: null, episode: 1, media: fmtJikanToAL(a, await malToAnilistMedia(a.mal_id)) }); } catch(_) {}
        }
        return { results };
    }
}

async function getAnilistSearch(query) {
    try {
        const data = await anilistQuery(
            `query($s:String){Page(page:1,perPage:1){media(search:$s,type:ANIME,sort:SEARCH_MATCH){${AL_FIELDS}}}}`,
            { s: query }
        );
        return { results: data.Page?.media || [] };
    } catch(e) {
        const data = await jikanFetch(`/anime?q=${encodeURIComponent(query)}&limit=1`);
        const results = [];
        for (const a of (data.data || [])) {
            try { results.push(fmtJikanToAL(a, await malToAnilistMedia(a.mal_id))); } catch(_) {}
        }
        return { results };
    }
}

async function getAnilistAnime(id) {
    try {
        const data = await anilistQuery(
            `query($id:Int){Media(id:$id,type:ANIME){${AL_FIELDS} recommendations{edges{node{id mediaRecommendation{id meanScore title{romaji english native userPreferred}status episodes coverImage{extraLarge large medium color}bannerImage format}}}}}}`,
            { id: parseInt(id) }
        );
        const m = data.Media;
        if (!m) throw new Error("Not found");
        m.recommendations = (m.recommendations?.edges || []).map(e => e.node?.mediaRecommendation).filter(Boolean);
        return m;
    } catch(e) {
        // Fallback: id might be MAL ID, try converting
        const al = await malToAnilistMedia(parseInt(id));
        if (!al) throw new Error("Not found");
        al.recommendations = [];
        return al;
    }
}

export { getAnilistTrending, getAnilistSearch, getAnilistAnime, getAnilistUpcoming };
