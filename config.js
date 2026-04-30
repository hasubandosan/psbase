// config.js — PSBase v5
// ⚠️  Заполните своими ключами

const CONFIG = {
  supabase: {
    url:    'https://hilpfbpvzrpdtgrmiuxh.supabase.co',  // Project Settings → API → Project URL
        anonKey:'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhpbHBmYnB2enJwZHRncm1pdXhoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY3MDI3MzksImV4cCI6MjA5MjI3ODczOX0.LBI2jox2NSUM-al3EVAghPrDUa_L16sSljE4YbdRWNM',           // Project Settings → API → anon public
  },
    image: {
        maxUploadWidth: 1000, // Уменьшаем с 1200 до 1000. Для мобилок и веба этого за глаза.
        quality: 0.75,        // Снижаем с 0.82 до 0.75. Визуально разница мала, но вес упадет сильно.
        thumbWidth: 200,      // Делаем превью поменьше
        cardWidth: 500,       // Оптимально для карточек
        bppWidth: 300,
    }
};
    