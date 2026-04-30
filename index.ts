// supabase/functions/ddg-images/index.ts
// Деплой: supabase functions deploy ddg-images
// Или через Dashboard: Edge Functions → New Function

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const { query, limit = 12 } = await req.json();
    if (!query) return new Response(JSON.stringify({ error: 'query required' }), { status: 400 });

    // Шаг 1: получаем vqd токен
    const initResp = await fetch(
      `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PSBase/1.0)' } }
    );
    const html = await initResp.text();
    const vqdMatch = html.match(/vqd=['"]([^'"]+)['"]/);
    if (!vqdMatch) throw new Error('Could not extract vqd token');

    // Шаг 2: запрашиваем картинки
    const vqd = vqdMatch[1];
    const imgResp = await fetch(
      `https://duckduckgo.com/i.js?q=${encodeURIComponent(query)}&vqd=${encodeURIComponent(vqd)}&o=json&p=1&f=,,,,,`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PSBase/1.0)', 'Referer': 'https://duckduckgo.com/' } }
    );
    const json = await imgResp.json();

    const results = (json.results || []).slice(0, limit).map((r: any) => ({
      thumb:  r.thumbnail,
      full:   r.image,
      title:  r.title,
      width:  r.width,
      height: r.height,
    }));

    return new Response(JSON.stringify({ results }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message, results: [] }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
});
