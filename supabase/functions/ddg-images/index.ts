// supabase/functions/ddg-images/index.ts
// Использует Serper.dev — Google Images без фильтрации
// Регистрация: https://serper.dev (2500 запросов бесплатно)
// Деплой: supabase functions deploy ddg-images --no-verify-jwt
// Ключ добавить: supabase secrets set SERPER_API_KEY=ваш_ключ

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const { query, limit = 24 } = await req.json();
    if (!query) return new Response(
      JSON.stringify({ error: 'query required', results: [] }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );

    const apiKey = Deno.env.get('a2ddd029fd421a5002abf937b874831b69baede0');
    if (!apiKey) throw new Error('SERPER_API_KEY не задан в secrets');

    const resp = await fetch('https://google.serper.dev/images', {
      method: 'POST',
      headers: {
        'X-API-KEY':    apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        q:    query,
        num:  limit,
        safe: 'off',   // отключаем SafeSearch
        gl:   'us',    // регион
        hl:   'en',    // язык
      }),
    });

    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Serper error ${resp.status}: ${txt}`);
    }

    const data = await resp.json();

    // Serper возвращает images[]
    const results = (data.images || []).slice(0, limit).map((img: any) => ({
      thumb: img.thumbnailUrl || img.imageUrl,
      full:  img.imageUrl,
      title: img.title || '',
    })).filter((r: any) => r.full);

    console.log(`[Serper] "${query}" → ${results.length} images`);

    return new Response(JSON.stringify({ results }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });

  } catch (e) {
    console.error('[ERROR]', e.message);
    return new Response(
      JSON.stringify({ error: e.message, results: [] }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }
});