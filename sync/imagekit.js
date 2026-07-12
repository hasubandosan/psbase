// sync/imagekit.js — Supabase Storage + CDN трансформации
// Хранит фото в Supabase Storage bucket 'photos'
// Зависит от: CONFIG, getSupabase()

const ImageKit = {

  // ── Сжатие File/Blob → WebP ───────────────────────────────────
  async compress(fileOrBlob, maxWidth = CONFIG.image.maxUploadWidth, quality = CONFIG.image.quality) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(fileOrBlob);
      const img = new Image();
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не удалось загрузить изображение')); };
      img.onload  = () => {
        URL.revokeObjectURL(url);
        const ratio  = Math.min(1, maxWidth / img.width);
        const canvas = document.createElement('canvas');
        canvas.width  = Math.round(img.width  * ratio);
        canvas.height = Math.round(img.height * ratio);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(
          blob => blob ? resolve(blob) : reject(new Error('Canvas toBlob вернул null')),
          'image/webp',
          quality
        );
      };
      img.src = url;
    });
  },

  // ── Сжатие из dataURL → Blob ──────────────────────────────────
  async compressFromDataUrl(dataUrl, maxWidth = CONFIG.image.maxUploadWidth) {
    const res  = await fetch(dataUrl);
    const blob = await res.blob();
    return this.compress(blob, maxWidth);
  },

  // ── Загрузка в Supabase Storage ───────────────────────────────
  // Возвращает публичный URL или кидает ошибку
  async upload(blob, fileName, folder = 'models') {
    const sb   = getSupabase();
    const ext  = 'webp';
    const safe = fileName.replace(/[^a-z0-9]/gi, '_').slice(0, 40);
    // FIX: исправлен template literal
    const path = `${folder}/${Date.now()}_${safe}.${ext}`;

    const { error } = await sb.storage
      .from('photos')
      .upload(path, blob, { contentType: 'image/webp', upsert: true });

    if (error) throw new Error(`Storage upload failed: ${error.message}`);

    const { data } = sb.storage.from('photos').getPublicUrl(path);
    if (!data?.publicUrl) throw new Error('Storage: не удалось получить publicUrl');
    return data.publicUrl;
  },

  // ── Загрузка из File (форма) ──────────────────────────────────
  async uploadFile(file, folder = 'models') {
    const compressed = await this.compress(file);
    const baseName = (file.name || 'photo').replace(/\.[^.]+$/, '');
    return this.upload(compressed, baseName, folder);
  },

  // ── Загрузка из dataURL (миграция старых base64) ──────────────
  async uploadDataUrl(dataUrl, baseName, folder = 'models') {
    if (!dataUrl || !dataUrl.startsWith('data:')) {
      let url = dataUrl.split('?')[0];
      url = url.replace('/storage/v1/render/image/public/', '/storage/v1/object/public/');
      return url;
    }
    try {
      const blob = await this.compressFromDataUrl(dataUrl);
      // FIX: исправлен template literal
      return await this.upload(blob, `${baseName}.webp`, folder);
    } catch (e) {
      console.warn('Storage upload failed, keeping local:', e.message);
      return dataUrl; // fallback — не теряем данные
    }
  },

  // ── URL-трансформации через Supabase Image Transform ─────────
  _tr(url, params) {
    if (!url || url.startsWith('data:')) return url;
    const clean = url.split('?')[0];
    if (!clean.includes('/object/public/')) return clean;
    const renderUrl = clean.replace('/storage/v1/object/public/', '/storage/v1/render/image/public/');
    // FIX: исправлен template literal
    return `${renderUrl}?${params}&format=webp`;
  },

  // FIX: исправлены template literals во всех методах трансформации
  thumb(url)  { return this._tr(url, `width=${CONFIG.image.thumbWidth}&quality=70`); },
  card(url)   { return this._tr(url, `width=${CONFIG.image.cardWidth}&quality=75`); },
  detail(url) { return this._tr(url, 'width=800&quality=80'); },
  bpp(url)    {
    const s = CONFIG.image.bppWidth;
    return this._tr(url, `width=${s}&height=${s}&resize=cover&quality=75`);
  },

  // ── Извлечь path из публичного URL Supabase Storage ──────────
  _pathFromUrl(url) {
    if (!url || url.startsWith('data:')) return null;
    const marker = '/photos/';
    const idx = url.indexOf(marker);
    if (idx === -1) return null;
    return url.slice(idx + marker.length).split('?')[0];
  },

  // ── Удалить список URL из Storage ────────────────────────────
  async deleteUrls(urls = []) {
    const paths = urls.map(u => this._pathFromUrl(u)).filter(Boolean);
    if (!paths.length) return;
    const sb = getSupabase();
    const { error } = await sb.storage.from('photos').remove(paths);
    if (error) console.warn('Storage delete failed:', error.message);
    else console.log('[Storage] Deleted', paths.length, 'files');
  },

  // ── Собрать все URL фото модели ───────────────────────────────
  collectModelUrls(model) {
    const urls = [];
    if (model.main_photo && !model.main_photo.startsWith('data:')) urls.push(model.main_photo);
    Object.values(model.body_part_photos || {}).forEach(u => { if (u && !u.startsWith('data:')) urls.push(u); });
    (model.extra_photos || []).forEach(u => { if (u && !u.startsWith('data:')) urls.push(u); });
    return urls;
  },

  // ── Ленивая миграция base64 → Storage при открытии карточки ──
  async migrateModelPhotos(model) {
    if (!model) return model;
    if (!State.user) return model;

    let changed = false;
    const upd = { ...model };

    if (upd.main_photo?.startsWith('data:')) {
      upd.main_photo = await this.uploadDataUrl(upd.main_photo, `${model.id}-main`, 'models/main');
      changed = true;
    }

    const bpp = { ...(upd.body_part_photos || {}) };
    for (const part of Object.keys(bpp)) {
      if (bpp[part]?.startsWith('data:')) {
        bpp[part] = await this.uploadDataUrl(bpp[part], `${model.id}-${part}`, 'models/bpp');
        changed = true;
      }
    }
    if (changed) upd.body_part_photos = bpp;

    const extras = [...(upd.extra_photos || [])];
    for (let i = 0; i < extras.length; i++) {
      if (extras[i]?.startsWith('data:')) {
        extras[i] = await this.uploadDataUrl(extras[i], `${model.id}-extra${i}`, 'models/extra');
        changed = true;
      }
    }
    if (changed) upd.extra_photos = extras;

    if (changed) {
      await db.models.update(model.id, {
        main_photo:       upd.main_photo,
        body_part_photos: upd.body_part_photos,
        extra_photos:     upd.extra_photos,
        _local_updated:   Date.now(),
      });
      if (window.SyncManager) await SyncManager.enqueue('models', 'upsert', model.id);
    }
    return upd;
  },
};

window.ImageKit = ImageKit;

