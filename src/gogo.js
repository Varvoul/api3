// gogo.js - Powered by Jikan v4 API (MyAnimeList) + miruro.to watch links
// AniList is unstable - Jikan is the official MAL API, always available

const JIKAN = "https://api.jikan.moe/v4";

async function jikan(path) {
    const res = await fetch(`${JIKAN}${path}`, {
        headers: { "Accept": "application/json" }
    });
    if (!res.ok) throw new Error(`Jikan error: ${res.status}`);
    return res.json();
}

async function getSearch(name, page = 1) {
    const data = await jikan(`/anime?q=${encodeURIComponent(name)}&page=${parseInt(page)}&limit=20&sfw=true`);
    return (data.data || []).map(formatAnime);
}

async function getAnime(id) {
    const numId = parseInt(id);
    if (isNaN(numId)) {
        const r = await getSearch(id);
        if (!r.length) throw new Error("Not found");
        return getAnime(r[0].id);
    }
    const [animeRes, epRes] = await Promise.all([
        jikan(`/anime/${numId}/full`),
        jikan(`/anime/${numId}/episodes?page=1`)
    ]);
    const a = animeRes.data;
    if (!a) throw new Error("Not found");

    const total = a.episodes || 0;
    const episodes = [];
    for (let i = 1; i <= Math.min(total, 500); i++) {
        episodes.push([String(i), `https://www.miruro.to/watch/${numId}?ep=${i}`]);
    }

    return {
        name: a.title_english || a.title || null,
        image: a.images?.jpg?.large_image_url || a.images?.jpg?.image_url || null,
        id: String(numId),
        malId: String(numId),
        genre: (a.genres || []).map(g => g.name).join(", "),
        type: a.type || null,
        status: a.status || null,
        plot_summary: a.synopsis || null,
        released: a.year ? String(a.year) : (a.aired?.from ? a.aired.from.slice(0,4) : null),
        episodes,
        total_episodes: total,
        score: a.score || null,
        miruro_url: `https://www.miruro.to/watch/${numId}`,
        source: "jikan+miruro",
    };
}

async function getRecentAnime(page = 1) {
    const data = await jikan(`/seasons/now?page=${parseInt(page)}&limit=24`);
    return (data.data || []).map(a => ({
        title: a.title_english || a.title || null,
        episode: `Episode ${a.episodes || "?"}`,
        image: a.images?.jpg?.image_url || null,
        id: String(a.mal_id),
        miruro_url: `https://www.miruro.to/watch/${a.mal_id}`,
    }));
}

async function getPopularAnime(page = 1, max = 20) {
    const data = await jikan(`/top/anime?page=${parseInt(page)}&limit=${max}&filter=bypopularity`);
    return (data.data || []).slice(0, max).map(a => ({
        title: a.title_english || a.title || null,
        releaseDate: a.year ? String(a.year) : null,
        image: a.images?.jpg?.image_url || null,
        id: String(a.mal_id),
        miruro_url: `https://www.miruro.to/watch/${a.mal_id}`,
    }));
}

async function getEpisode(id) {
    const parts = id.split("-");
    const epNum = parts[parts.length - 1];
    const malId = parts.slice(0, -1).join("-");
    return {
        malId,
        episode: epNum,
        miruro_watch_url: `https://www.miruro.to/watch/${malId}?ep=${epNum}`,
        embed_url: `https://www.miruro.to/embed/${malId}?ep=${epNum}&autoPlay=true`,
        note: "Open miruro_watch_url to stream with sub/dub. Get episode IDs from /anime/{id}",
    };
}

async function GogoDLScrapper(animeid, cookie) {
    return { note: "Use /episode/{malId}-{epNum} to get miruro.to watch links" };
}

async function getGogoAuthKey() { return ""; }

function formatAnime(a) {
    return {
        title: a.title_english || a.title || null,
        img: a.images?.jpg?.image_url || null,
        id: String(a.mal_id),
        link: `https://www.miruro.to/watch/${a.mal_id}`,
        releaseDate: a.year ? String(a.year) : null,
    };
}

export { getSearch, getAnime, getRecentAnime, getPopularAnime, getEpisode, GogoDLScrapper, getGogoAuthKey };
