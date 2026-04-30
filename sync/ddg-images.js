// sync/ddg-images.js — DuckDuckGo Image Search (неофициальный)
// Работает через Supabase Edge Function как прокси (обход CORS)
// Зависит от: CONFIG, getSupabase()

const DDGImages = {

  // ── Поиск через Edge Function ─────────────────────────────────
  // Supabase Edge Function нужна чтобы обойти CORS
  async search(query, limit = 12) {
    try {
      const sb = getSupabase();
      const { data, error } = await sb.functions.invoke('ddg-images', {
        body: { query, limit }
      });
      if (error) throw error;
      return data?.results || [];
    } catch (e) {
      console.warn('[DDG] Edge Function failed, trying direct:', e.message);
      // Fallback: пробуем напрямую (работает не везде из-за CORS)
      return this._searchDirect(query, limit);
    }
  },

  // ── Прямой запрос (fallback, может не работать из-за CORS) ────
  async _searchDirect(query, limit = 12) {
    // DDG требует сначала получить vqd-токен
    const initResp = await fetch(
      `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const initHtml = await initResp.text();
    const vqdMatch = initHtml.match(/vqd=['"]([^'"]+)['"]/);
    if (!vqdMatch) throw new Error('DDG: не удалось получить vqd токен');

    const vqd = vqdMatch[1];
    const url = `https://duckduckgo.com/i.js?q=${encodeURIComponent(query)}&vqd=${vqd}&o=json&p=1`;
    const resp = await fetch(url);
    const json = await resp.json();
    return (json.results || []).slice(0, limit).map(r => ({
      thumb: r.thumbnail,
      full:  r.image,
      title: r.title,
      width: r.width,
      height: r.height,
    }));
  },
};
