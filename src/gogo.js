// gogo.js - Rewritten to use Jikan v4 API (MyAnimeList)
// Gogoanime blocks Cloudflare Worker IPs, so we use Jikan instead

const JIKAN = "https://api.jikan.moe/v4";

async function getSearch(name, page = 1) {
    const res = await fetch(`${JIKAN}/anime?q=${encodeURIComponent(name)}&page=${page}&limit=20&sfw=true`);
    const json = await res.json();
    if (!json.data) return [];
    return json.data.map(a => ({
        title: a.title || null,
        img: a.images?.jpg?.image_url || null,
        id: String(a.mal_id),
        link: a.url || null,
        releaseDate: a.year ? String(a.year) : (a.aired?.from ? a.aired.from.slice(0,4) : null),
    }));
}

async function getAnime(id) {
    // id can be a mal_id number or a name string - handle both
    let malId = parseInt(id);
    if (isNaN(malId)) {
        // it's a name, search first
        const results = await getSearch(id);
        if (!results.length) throw new Error("Not found");
        malId = parseInt(results[0].id);
    }

    const [animeRes, episodesRes] = await Promise.all([
        fetch(`${JIKAN}/anime/${malId}/full`),
        fetch(`${JIKAN}/anime/${malId}/episodes?page=1`)
    ]);
    const animeJson = await animeRes.json();
    const episodesJson = await episodesRes.json();

    if (!animeJson.data) throw new Error("Not found");
    const a = animeJson.data;

    // Build episodes list - same format as original [[epNum, epId], ...]
    const episodes = (episodesJson.data || []).map(ep => [
        String(ep.mal_id),
        `${a.title?.toLowerCase().replace(/[^a-z0-9]+/g,"-")}-episode-${ep.mal_id}`
    ]);

    return {
        name: a.title,
        image: a.images?.jpg?.large_image_url || a.images?.jpg?.image_url || null,
        id: String(malId),
        genre: a.genres?.map(g => g.name).join(", ") || null,
        type: a.type || null,
        status: a.status || null,
        plot_summary: a.synopsis || null,
        released: a.year ? String(a.year) : null,
        episodes,
        total_episodes: a.episodes || episodes.length,
        score: a.score || null,
        mal_url: a.url || null,
    };
}

async function getRecentAnime(page = 1) {
    // Use currently airing anime as "recent"
    const res = await fetch(`${JIKAN}/seasons/now?page=${page}&limit=24`);
    const json = await res.json();
    if (!json.data) return [];
    return json.data.map(a => ({
        title: a.title || null,
        episode: a.episodes ? `Episode ${a.episodes}` : "Ongoing",
        image: a.images?.jpg?.image_url || null,
        link: a.url || null,
        id: String(a.mal_id),
    }));
}

async function getPopularAnime(page = 1, max = 20) {
    const res = await fetch(`${JIKAN}/top/anime?page=${page}&limit=${max}&filter=bypopularity`);
    const json = await res.json();
    if (!json.data) return [];
    return json.data.slice(0, max).map(a => ({
        title: a.title || null,
        releaseDate: a.year ? String(a.year) : null,
        image: a.images?.jpg?.image_url || null,
        link: a.url || null,
        id: String(a.mal_id),
    }));
}

async function getEpisode(id) {
    // id format: "anime-name-episode-N" or just return stream info
    // Since we can't scrape gogoanime, return structured data with streaming links
    let epNum = 1;
    const match = id.match(/episode-(\d+)$/);
    if (match) epNum = parseInt(match[1]);

    // Extract anime name part
    const animeName = id.replace(/-episode-\d+$/, "").replace(/-/g, " ");

    return {
        name: `${animeName} Episode ${epNum}`,
        episodes: null,
        stream: null,
        note: "Direct streaming unavailable - gogoanime blocks server requests. Use /anime/{id} to get MAL data.",
        servers: {},
    };
}

async function GogoDLScrapper(animeid, cookie) {
    return { note: "Download scraping unavailable - gogoanime blocks server requests." };
}

async function getGogoAuthKey() {
    return "";
}

export {
    getSearch,
    getAnime,
    getRecentAnime,
    getPopularAnime,
    getEpisode,
    GogoDLScrapper,
    getGogoAuthKey,
};
