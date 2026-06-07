// anilist.js - AniList ONLY, no Jikan

const ANILIST = "https://graphql.anilist.co";

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

const MEDIA_FIELDS = `id idMal status title{userPreferred romaji english native}
    bannerImage popularity coverImage{extraLarge large medium color}
    episodes format season description(asHtml:false) seasonYear
    averageScore genres meanScore startDate{year}
    nextAiringEpisode{episode airingAt}`;

async function getAnilistTrending() {
    const data = await al(
        `query{Page(page:1,perPage:10){media(sort:[TRENDING_DESC,POPULARITY_DESC],type:ANIME){${MEDIA_FIELDS}}}}`
    );
    return { results: data.Page?.media || [] };
}

async function getAnilistUpcoming(page) {
    const data = await al(
        `query($p:Int){Page(page:$p,perPage:20){airingSchedules(notYetAired:true){airingAt episode media{${MEDIA_FIELDS}}}}}`,
        { p: parseInt(page) }
    );
    return { results: (data.Page?.airingSchedules||[]).map(s=>({airingAt:s.airingAt,episode:s.episode,media:s.media})) };
}

async function getAnilistSearch(query) {
    const data = await al(
        `query($s:String){Page(page:1,perPage:1){media(search:$s,type:ANIME,sort:SEARCH_MATCH){${MEDIA_FIELDS}}}}`,
        { s: query }
    );
    return { results: data.Page?.media || [] };
}

async function getAnilistAnime(id) {
    const numId = parseInt(id);
    // Try as AniList ID, fallback to MAL ID
    let media = null;
    try {
        const d = await al(`query($id:Int){Media(id:$id,type:ANIME){${MEDIA_FIELDS}
            recommendations{edges{node{id mediaRecommendation{id meanScore title{romaji english native userPreferred}
            status episodes coverImage{extraLarge large medium color}bannerImage format}}}}}}`,
            { id: numId });
        media = d.Media;
    } catch(_) {}

    if (!media) {
        const d = await al(`query($id:Int){Media(idMal:$id,type:ANIME){${MEDIA_FIELDS}
            recommendations{edges{node{id mediaRecommendation{id meanScore title{romaji english native userPreferred}
            status episodes coverImage{extraLarge large medium color}bannerImage format}}}}}}`,
            { id: numId });
        media = d.Media;
    }

    if (!media) throw new Error("Not found");
    media.recommendations = (media.recommendations?.edges||[]).map(e=>e.node?.mediaRecommendation).filter(Boolean);
    return media;
}

export { getAnilistTrending, getAnilistSearch, getAnilistAnime, getAnilistUpcoming };
