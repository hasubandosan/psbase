// app.js — PSBase v5
'use strict';

// ── State ──────────────────────────────────────────────────────────
const State = {
  view: 'home', detailId: null, editingId: null,
  filters: { q:'', favorites:false, country:'', sort:'date_added_desc', overallMin:0, overallMax:9999 },
  gridColumns: parseInt(localStorage.getItem('psbase-grid-columns'), 10) || 2,
  user: null,
  // Пагинация
  page: { current: 0, pageSize: 20, total: 0, allList: [], observer: null },
  _modelCastingId: null,
  _modelCastingPicks: {}, // slotKey -> { url, thumb, type:'url'|'upload' }
};

// ── Model Casting config ──────────────────────────────────────────
const CASTING_SLOTS = [
  { key: 'main',      label: '📷 Основное фото', aspect: NaN },
  { key: 'face',      label: '😶 Лицо',          aspect: 1   },
  { key: 'shoulders', label: '💪 Плечи',         aspect: 1   },
  { key: 'waist',     label: '⌛ Талия',          aspect: 1   },
  { key: 'hips',      label: '🍑 Бёдра',         aspect: 1   },
  { key: 'figure',    label: '👤 Фигура',         aspect: NaN },
];

const DEFAULT_CASTING_KW = {
  main:      'анфас',
  face:      'лицо крупный план',
  shoulders: 'плечи декольте',
  waist:     'талия',
  hips:      'бёдра',
  figure:    'фигура полный рост',
};

function loadCastingKw()  {
  try { return JSON.parse(localStorage.getItem('psbase-casting-kw') || 'null') || { ...DEFAULT_CASTING_KW }; }
  catch { return { ...DEFAULT_CASTING_KW }; }
}

function saveCastingKw(kw) { localStorage.setItem('psbase-casting-kw', JSON.stringify(kw)); }


// ── Toast ──────────────────────────────────────────────────────────
function toast(msg, type='info', ms=2800) {
  const icons = {success:'✓',error:'✕',info:'●'};
  const c = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${icons[type]}</span><span>${msg}</span>`;
  c.appendChild(el);
  setTimeout(()=>{ el.style.opacity='0'; setTimeout(()=>el.remove(),300); }, ms);
}

// ── Modal ──────────────────────────────────────────────────────────
function modal(html, onOk) {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal">${html}</div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', e=>{ if(e.target===ov) ov.remove(); });
  ov.querySelectorAll('[data-cancel]').forEach(b=>b.addEventListener('click',()=>ov.remove()));
  if (onOk) { const ok=ov.querySelector('[data-ok]'); if(ok) ok.addEventListener('click',()=>{ onOk(ov); ov.remove(); }); }
  return ov;
}

// ── Router ─────────────────────────────────────────────────────────
function nav(view, params={}) {
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
  const el = document.getElementById('view-'+view);
  if (el) el.classList.add('active');
  const nb = document.querySelector(`[data-nav="${view}"]`);
  if (nb) nb.classList.add('active');
  if (params.id!=null) State.detailId = params.id;
  State.view = view;
  ({
    home:      renderHome,
    search:    renderSearch,
    favorites: renderFavorites,
    stats:     renderStats,
    settings:  renderSettings,
    detail:    ()=>renderDetail(State.detailId),
    add:       ()=>renderAddEdit(null),
    edit:      ()=>renderAddEdit(State.editingId),
    bans:      renderBans,
    tags:      renderTagMgr,
    casting:   renderCasting,
    'model-casting': () => renderModelCasting(State._modelCastingId)
  })[view]?.();
  window.scrollTo(0,0);
}

function topBar(html) { document.getElementById('top-bar').innerHTML = html; }

// ── Sync indicator in topbar ───────────────────────────────────────
async function updateSyncIndicator() {
  const el = document.getElementById('sync-dot');
  if (!el) return;
  const sbConfigured = CONFIG.supabase.url !== 'https://YOURPROJECT.supabase.co';
  if (!sbConfigured) { el.style.display='none'; return; }
  if (!navigator.onLine) { el.className='sync-dot offline'; el.title='Офлайн'; return; }
  if (!State.user) { el.className='sync-dot noauth'; el.title='Нажмите чтобы войти'; return; }
  const pending = window.SyncManager ? await SyncManager.pendingCount() : 0;
  el.className = pending>0 ? 'sync-dot pending' : 'sync-dot ok';
  el.title = pending>0 ? `Ожидает синхронизации: ${pending}` : 'Синхронизировано ✓';
}

// ── Utility ────────────────────────────────────────────────────────
const debounce = (fn,ms) => { let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; };
function escHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

async function fileToBlob(file) { return file; } // File уже Blob

async function resizeImageDataUrl(src, maxW=800) {
  return new Promise(res=>{
    const img=new Image();
    img.onload=()=>{
      const ratio=Math.min(1,maxW/img.width);
      const c=document.createElement('canvas');
      c.width=Math.round(img.width*ratio); c.height=Math.round(img.height*ratio);
      c.getContext('2d').drawImage(img,0,0,c.width,c.height);
      res(c.toDataURL('image/jpeg',0.82));
    };
    img.src=src;
  });
}

async function fileToDataUrl(file) {
  return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=rej; r.readAsDataURL(file); });
}

// Загрузка фото: если Supabase настроен и авторизован — в Storage, иначе DataURL (локально)
async function handlePhotoFile(file) {
  const sbConfigured = CONFIG.supabase.url !== 'https://YOURPROJECT.supabase.co';
  if (!sbConfigured || !navigator.onLine || !window.ImageKit) {
    return resizeImageDataUrl(await fileToDataUrl(file));
  }

  // State.user может быть null из-за race condition при старте —
  // перепроверяем напрямую через Supabase SDK
  let user = State.user;
  if (!user) {
    try {
      const { data } = await getSupabase().auth.getSession();
      user = data?.session?.user ?? null;
      console.log('[Auth] getSession result:', user?.email ?? 'null');
      if (user) State.user = user;
    } catch(e) {
      console.error('[Auth] getSession failed:', e.message);
    }
  }

  if (!user) {
    console.warn('[Storage] Still no user after getSession — saving locally');
    return resizeImageDataUrl(await fileToDataUrl(file));
  }

  try {
    const url = await ImageKit.uploadFile(file);
    console.log('[Storage] Uploaded:', url);
    return url;
  } catch(e) {
    console.error('[Storage] Upload failed:', e.message);
    toast(`Фото: ${e.message}`, 'error', 4000);
    return resizeImageDataUrl(await fileToDataUrl(file));
  }
}

// ── Cropper ────────────────────────────────────────────────────────
function openCropper(src, onDone, aspectRatio=NaN) {
  const div = document.createElement('div');
  div.className = 'crop-modal';
  div.innerHTML = `<div class="crop-container"><img id="crop-img" src="${src}" style="max-width:100%;display:block"></div>
    <div class="crop-actions">
      <button class="btn btn-ghost" id="crop-cancel">Отмена</button>
      <button class="btn btn-ghost" id="crop-skip">Продолжить без изменений</button>
      <button class="btn btn-gold" id="crop-ok">✂ Обрезать</button>
    </div>`;
  document.body.appendChild(div);
  let cropper=null;

  const img = div.querySelector('#crop-img');
  const initCropper = () => {
    if (window.Cropper && !cropper) {
      cropper = new Cropper(img, {
        aspectRatio,
        viewMode: 1,
        autoCropArea: 1.0, // full frame по умолчанию
        movable: true,
        zoomable: true,
        background: false,
        guides: true
      });
    }
  };

  if (img.complete) {
    initCropper();
  } else {
    img.onload = initCropper;
  }

  div.querySelector('#crop-cancel').onclick = ()=>div.remove();
  
  // "Продолжить без изменений" — используем фото как есть, не загружаем в Storage
  div.querySelector('#crop-skip').onclick = async ()=>{
    if (cropper) cropper.destroy();
    div.remove();
    onDone(src); // передаём исходный URL без изменений
  };
  
  div.querySelector('#crop-ok').onclick = async ()=>{
    if (cropper) {
      const canvas = cropper.getCroppedCanvas({maxWidth:800,maxHeight:1200});
      cropper.destroy();
      // DataURL → file → upload
      canvas.toBlob(async blob => {
        // Обрезанная версия — новый файл, помечаем как 'upload'
        const url = await handlePhotoFile(new File([blob], 'crop.webp', {type:'image/webp'}));
        onDone(url, 'upload');
      }, 'image/webp', 0.85);
    }
    div.remove();
  };
}

// ── Auth screen ────────────────────────────────────────────────────
function renderAuth() {
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.querySelector('.bottom-nav').style.display='none';
  document.getElementById('top-bar').innerHTML = `<span class="logo">PSBase</span>`;
  const v = document.getElementById('view-home');
  v.classList.add('active');
  v.innerHTML = `
    <div class="auth-screen">
      <div class="auth-logo">✦ PSBase</div>
      <div class="auth-card">
        <div class="form-section-title" style="border:none;padding:0;margin-bottom:16px">Войти в аккаунт</div>
        <div class="form-group"><label class="form-label">Email</label><input class="form-input" type="email" id="auth-email" placeholder="you@example.com" autocomplete="email"></div>
        <div class="form-group"><label class="form-label">Пароль</label><input class="form-input" type="password" id="auth-pass" placeholder="••••••••" autocomplete="current-password"></div>
        <button class="btn btn-gold" style="width:100%;height:48px;margin-top:4px" onclick="doSignIn()">Войти</button>
        <div class="auth-divider">или</div>
        <button class="btn btn-ghost" style="width:100%;height:44px" onclick="doSignUp()">Создать аккаунт</button>
        <button class="btn btn-ghost" style="width:100%;height:44px;margin-top:8px;color:var(--text3);font-size:12px" onclick="continueOffline()">Продолжить офлайн (без синхронизации)</button>
      </div>
    </div>`;
}

async function doSignIn() {
  const email=document.getElementById('auth-email')?.value.trim();
  const pass=document.getElementById('auth-pass')?.value;
  if (!email||!pass) { toast('Введите email и пароль','error'); return; }
  try {
    const user = await Auth.signIn(email,pass);
    await onUserSignedIn(user);
  } catch(e) { toast('Ошибка входа: '+e.message,'error'); }
}

async function doSignUp() {
  const email=document.getElementById('auth-email')?.value.trim();
  const pass=document.getElementById('auth-pass')?.value;
  if (!email||!pass) { toast('Введите email и пароль','error'); return; }
  if (pass.length<6) { toast('Пароль минимум 6 символов','error'); return; }
  try {
    await Auth.signUp(email,pass);
    toast('Аккаунт создан! Войдите.','success');
  } catch(e) { toast('Ошибка регистрации: '+e.message,'error'); }
}

async function continueOffline() {
  document.querySelector('.bottom-nav').style.display='';
  // await seedDemoData();
  nav('home');
}

async function onUserSignedIn(user) {
  State.user = user;
  SyncManager._userId = user.id;

  document.querySelector('.bottom-nav').style.display = '';

  // listeners
  if (!SyncManager._listenersStarted) {
    SyncManager.startListeners();
    SyncManager._listenersStarted = true;
  }

  toast('Добро пожаловать!', 'success', 2000);

  nav('home');
  updateSyncIndicator();

  // 🔥 НОВАЯ ЛОГИКА СИНХРОНИЗАЦИИ
  if (navigator.onLine) {
    try {
      // 1. Сначала отправляем локальные изменения
      await SyncManager.flush();

      // 2. Потом тянем ВСЁ с сервера (важно!)
      const pulled = await SyncManager.pull(true);

      if (pulled > 0) {
        toast(`Синхронизировано: ${pulled}`, 'success', 2500);
        if (State.view === 'home') reloadGrid();
      }

    } catch (e) {
      console.error('[Sync error]', e);
      toast('Ошибка синхронизации', 'error');
    }

    updateSyncIndicator();
  }
}

// ── HOME ───────────────────────────────────────────────────────────
async function renderHome() {
  topBar(`
    <span class="logo">PSBase</span>
    <div class="top-actions">
      <div class="sync-dot ok" id="sync-dot" title="Синхронизировано" onclick="manualSync()"></div>
      <button class="btn-icon" onclick="nav('casting')" title="Кастинг">🎬</button>
      <button class="btn-icon" onclick="nav('tags')" title="Теги">🏷️</button>
      <button class="btn-icon" onclick="nav('bans')" title="Бан-лист">🚫</button>
    </div>`);
  updateSyncIndicator();
  const v = document.getElementById('view-home');
  v.innerHTML = `
    <div class="search-bar">
      <span class="si">🔍</span>
      <input id="hs" type="text" placeholder="Поиск по имени или псевдониму..." value="${State.filters.q}">
      <button class="sc" onclick="hsClear()">✕</button>
    </div>
    <div class="filter-row" id="country-chips"></div>
    <div class="toolbar">
      <select class="sort-select" id="sort-sel" onchange="applySort(this.value)">
        <option value="date_added_desc">Новые</option>
        <option value="overall_desc">Overall ↓</option>
        <option value="overall_asc">Overall ↑</option>
        <option value="potential_desc">Потенциал ↓</option>
        <option value="name_asc">Имя А-Я</option>
        <option value="drops_desc">Drops ↓</option>
      </select>
      <select class="sort-select" id="cols-sel" onchange="applyColumns(this.value)" title="Число колонок">
        <option value="2">2 столбца</option>
        <option value="3">3 столбца</option>
        <option value="4">4 столбца</option>
        <option value="5">5 столбцов</option>
      </select>
      <button class="filter-chip${State.filters.favorites?' active':''}" onclick="toggleFavF()">★ Любимчики</button>
    </div>
    <div class="models-grid" id="mg"></div>
    <div id="mg-empty"></div>
    <button class="btn-fab" onclick="nav('add')">+</button>`;
  document.getElementById('sort-sel').value = State.filters.sort;
  document.getElementById('cols-sel').value = State.gridColumns;
  document.getElementById('hs').addEventListener('input', debounce(e=>{ State.filters.q=e.target.value; reloadGrid(); },280));
  await buildCountryChips();
  await reloadGrid();
}

async function manualSync() {
  if (!State.user) { toast('Войдите для синхронизации','info'); return; }
  if (!navigator.onLine) { toast('Нет соединения','error'); return; }
  const dot = document.getElementById('sync-dot');
  if (dot) dot.className='sync-dot pending';
  const result = await SyncManager.sync();
  if (result.error) { toast('Ошибка синхронизации: '+result.error,'error'); }
  else { toast(result.pulled>0?`Синхронизировано, получено ${result.pulled}`:'Всё актуально','success',2000); }
  updateSyncIndicator();
  if (State.view==='home') reloadGrid();
}

function hsClear() { State.filters.q=''; const el=document.getElementById('hs'); if(el) el.value=''; State.page.current=0; reloadGrid(); }
function toggleFavF() { State.filters.favorites=!State.filters.favorites; State.page.current=0; renderHome(); }
function applySort(v) { State.filters.sort=v; State.page.current=0; reloadGrid(); }
function applyColumns(v) { State.gridColumns = Math.max(2, Math.min(5, Number(v) || 2)); localStorage.setItem('psbase-grid-columns', State.gridColumns); State.page.current=0; reloadGrid(); }
function applyGridColumns(el) { if (!el) return; el.style.gridTemplateColumns = `repeat(${State.gridColumns}, 1fr)`; }

async function buildCountryChips() {
  const all = await Models.getAll();
  const cs = [...new Set(all.map(m=>m.country).filter(Boolean))];
  const row = document.getElementById('country-chips');
  if (!row) return;
  row.innerHTML = cs.map(c=>`<button class="filter-chip${State.filters.country===c?' active':''}" onclick="setCountryF('${c.replace(/'/g,"\\'")}')">${c}</button>`).join('');
}

function setCountryF(c) { State.filters.country=State.filters.country===c?'':c; State.page.current=0; renderHome(); }

// ── Pagination helpers ─────────────────────────────────────────────
function _filterAndSort(all) {
  const f = State.filters;
  let list = [...all];
  if (f.q) { const q=f.q.toLowerCase(); list=list.filter(m=>m.name.toLowerCase().includes(q)||(m.aliases||'').toLowerCase().includes(q)); }
  if (f.country)   list=list.filter(m=>m.country===f.country);
  if (f.favorites) list=list.filter(m=>m.is_favorite);
  const s=f.sort;
  if      (s==='overall_desc')   list.sort((a,b)=>(b.overall||0)-(a.overall||0));
  else if (s==='overall_asc')    list.sort((a,b)=>(a.overall||0)-(b.overall||0));
  else if (s==='potential_desc') list.sort((a,b)=>(b.potential||0)-(a.potential||0));
  else if (s==='name_asc')       list.sort((a,b)=>a.name.localeCompare(b.name));
  else if (s==='drops_desc')     list.sort((a,b)=>(b.drops||0)-(a.drops||0));
  else                           list.sort((a,b)=>(b.date_added||0)-(a.date_added||0));
  return list;
}

function _appendPage() {
  const p = State.page;
  const mg = document.getElementById('mg');
  if (!mg) return;

  const start = p.current * p.pageSize;
  const slice = p.allList.slice(start, start + p.pageSize);
  if (!slice.length) return;

  const s30O = new Set(p.allList.slice(0,30).map(m=>m.id)); // allList уже отсортирован по overall если нужно
  // Для top-30 берём глобально по overall
  const s30Oreal = new Set([...p.allList].sort((a,b)=>(b.overall||0)-(a.overall||0)).slice(0,30).map(m=>m.id));
  const s30Preal = new Set([...p.allList].sort((a,b)=>(b.potential||0)-(a.potential||0)).slice(0,30).map(m=>m.id));

  const frag = document.createDocumentFragment();
  slice.forEach(m => frag.appendChild(modelCard(m, s30Oreal, s30Preal)));
  mg.appendChild(frag);

  p.current++;

  // Обновить / убрать sentinel
  _updateSentinel();
}

function _updateSentinel() {
  const p = State.page;
  const hasMore = p.current * p.pageSize < p.allList.length;

  let sentinel = document.getElementById('pg-sentinel');
  if (!hasMore) {
    if (sentinel) sentinel.remove();
    if (p.observer) { p.observer.disconnect(); p.observer = null; }

    // Показываем итоговый счётчик
    const me = document.getElementById('mg-empty');
    if (me && p.allList.length > 0) {
      me.innerHTML = `<div class="pg-count">${p.allList.length} моделей</div>`;
    }
    return;
  }

  if (!sentinel) {
    sentinel = document.createElement('div');
    sentinel.id = 'pg-sentinel';
    sentinel.className = 'pg-sentinel';
    sentinel.innerHTML = '<div class="spinner"></div>';
    document.getElementById('view-home').appendChild(sentinel);
  }

  // IntersectionObserver — подгружаем когда sentinel виден
  if (!p.observer) {
    p.observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) _appendPage();
    }, { rootMargin: '200px' });
    p.observer.observe(sentinel);
  }
}

async function reloadGrid() {
  const mg = document.getElementById('mg');
  const me = document.getElementById('mg-empty');
  if (!mg) return;

  applyGridColumns(mg);

  // Отключаем старый observer
  if (State.page.observer) { State.page.observer.disconnect(); State.page.observer = null; }
  const oldSentinel = document.getElementById('pg-sentinel');
  if (oldSentinel) oldSentinel.remove();

  mg.innerHTML = '<div class="loading"><div class="spinner"></div></div>';

  const all = await Models.getAll();
  const list = _filterAndSort(all);

  mg.innerHTML = '';

  if (!list.length) {
    if (me) me.innerHTML = `<div class="empty-state"><div class="es-icon">✦</div><div class="es-title">Коллекция пуста</div><div class="es-text">Нажмите + чтобы добавить первую модель</div></div>`;
    return;
  }
  if (me) me.innerHTML = '';

  // Инициализируем пагинацию
  State.page.allList = list;
  State.page.current = 0;

  // Рисуем первую страницу сразу
  _appendPage();
}

function scoreValueClass(v) { if(!v||v<30)return 'rank-red'; if(v<55)return 'rank-yellow'; if(v<75)return 'rank-green'; return 'rank-gold'; }

function modelCard(m, s30O, s30P) {
  const inTop30O=s30O?.has(m.id), inTop30P=s30P?.has(m.id);
  const oCls=inTop30O?'rank-gold':scoreValueClass(m.overall);
  const pCls=inTop30P?'rank-gold':scoreValueClass(m.potential);
  const photoSrc = window.ImageKit ? ImageKit.thumb(m.main_photo) : m.main_photo;
  
  // Определяем badge источника фото
  let sourceBadge = '';
  if (m.main_photo) {
    if (m.main_photo.startsWith('http') && !m.main_photo.includes('/storage/v1/object/public/')) {
      sourceBadge = `<span class="photo-source-badge url" style="top:8px;left:8px">🔗 URL</span>`;
    } else {
      sourceBadge = `<span class="photo-source-badge upload" style="top:8px;left:8px">📦 Бакет</span>`;
    }
  }

  const el=document.createElement('div');
  el.className=`model-card${m.is_favorite?' is-favorite':''}${inTop30O?' card-top30':''}`;
  el.innerHTML=`
    <div class="model-card-photo" style="position:relative">
      ${sourceBadge}
      ${photoSrc?`<img src="${photoSrc}" alt="${escHtml(m.name)}" loading="lazy">`:`<div class="ph">👤</div>`}
    </div>
    <div class="model-card-body">
      <div class="model-card-name">${escHtml(m.name)}</div>
      <div class="model-card-scores">
        <div class="score-badge overall ${oCls}"><span class="lbl">Overall</span><span class="val">${m.overall||0}</span></div>
        <div class="score-badge potential ${pCls}"><span class="lbl">Потенциал</span><span class="val">${m.potential||0}</span></div>
      </div>
      <div class="model-card-sub">${escHtml(m.country||'')}${m.drops?` · 🔥${m.drops}`:''}</div>
    </div>`;
  el.onclick=()=>nav('detail',{id:m.id});
  return el;
}

// ── SEARCH ─────────────────────────────────────────────────────────
async function renderSearch() {
  topBar(`<span class="top-title">Поиск</span>`);
  const v=document.getElementById('view-search');
  v.innerHTML=`<div class="search-bar"><span class="si">🔍</span><input id="si" type="text" placeholder="Имя, псевдоним, страна..." autofocus><button class="sc" onclick="document.getElementById('si').value='';sRes([])">✕</button></div><div id="sres"></div>`;
  document.getElementById('si').addEventListener('input',debounce(async e=>{ const q=e.target.value.trim(); if(!q){sRes([]);return;} sRes(await Models.search(q)); },220));
}
function sRes(list) {
  const c=document.getElementById('sres'); if(!c) return;
  if (!list.length) { c.innerHTML=`<div class="empty-state"><div class="es-icon">🔍</div><div class="es-title">Ничего не найдено</div></div>`; return; }
  const g=document.createElement('div'); g.className='models-grid';
  applyGridColumns(g);
  list.forEach(m=>g.appendChild(modelCard(m,null,null)));
  c.innerHTML=''; c.appendChild(g);
}

// ── FAVORITES ──────────────────────────────────────────────────────
async function renderFavorites() {
  topBar(`<span class="top-title">★ Любимчики</span>`);
  const v=document.getElementById('view-favorites');
  const favs=(await Models.getAll()).filter(m=>m.is_favorite).sort((a,b)=>(b.overall||0)-(a.overall||0));
  if (!favs.length) { v.innerHTML=`<div class="empty-state"><div class="es-icon">★</div><div class="es-title">Нет любимчиков</div></div>`; return; }
  const g=document.createElement('div'); g.className='models-grid';
  applyGridColumns(g);
  favs.forEach(m=>g.appendChild(modelCard(m,null,null)));
  v.innerHTML=''; v.appendChild(g);
}

// ── DETAIL ─────────────────────────────────────────────────────────
async function renderDetail(id) {
  if (!id) { nav('home'); return; }
  const v=document.getElementById('view-detail');
  v.innerHTML='<div class="loading" style="padding:120px 0"><div class="spinner"></div></div>';
  let m = await Models.getById(id);
  if (!m) { nav('home'); return; }

  // Ленивая миграция base64 → Supabase Storage при открытии
  if (window.ImageKit && State.user && navigator.onLine) {
    m = await ImageKit.migrateModelPhotos(m);
  }

  const allModels=await Models.getAll(), similar=Models.getSimilar(m,allModels,6);
  const tags=m.tags?.length?(await db.tags.bulkGet(m.tags)).filter(Boolean):[];
  const BP=['face','shoulders','waist','hips','figure'];
  const BPL={face:'Лицо',shoulders:'Плечи',waist:'Талия',hips:'Бёдра',figure:'Фигура'};
  const RF={face:'face_rate',shoulders:'shoulders_rate',waist:'waist_rate',hips:'hips_rate',figure:'figure_rate'};
  const bpp=m.body_part_photos||{}, links=m.links||[], extra=m.extra_photos||[];

  topBar(`
    <button class="btn-icon" onclick="nav('home')" style="font-size:18px">←</button>
    <span class="top-title" style="font-size:15px">${escHtml(m.name)}</span>
    <div class="top-actions"><button class="btn-icon" onclick="editModel(${id})">✏️</button></div>`);

  const heroSrc = window.ImageKit ? ImageKit.detail(m.main_photo) : m.main_photo;

  v.innerHTML=`
    <div class="detail-hero">
      ${heroSrc?`<img class="detail-hero-img" src="${heroSrc}" alt="${escHtml(m.name)}">`:`<div class="detail-hero-ph">👤</div>`}
      <div class="detail-hero-overlay">
        <div class="detail-name">${escHtml(m.name)}</div>
        ${m.aliases?`<div class="aliases-text">${escHtml(m.aliases)}</div>`:''}
        <div class="detail-sub">${[escHtml(m.country||''),m.age!=null?(m.date_of_death?'умерла в '+m.age+' лет':m.age+' лет'):''].filter(Boolean).join(' · ')}</div>
        ${m.date_of_death?`<div class="deceased-badge">✝ ${m.date_of_death}</div>`:''}
        <div class="detail-scores-row">
          <div class="ds overall"><span class="dl">Overall</span><span class="dv">${m.overall||0}</span></div>
          <div class="ds potential"><span class="dl">Потенциал</span><span class="dv">${m.potential||0}</span></div>
          <div class="ds drops-ds"><span class="dl">Drops</span><span class="dv" id="dc">${m.drops||0}</span></div>
        </div>
      </div>
      <div class="detail-float-actions">
        <button class="fav-btn ${m.is_favorite?'fav-active':''}" id="fav-btn" onclick="toggleFav(${id})">${m.is_favorite?'★':'☆'}</button>
      </div>
    </div>
    <div class="detail-inner">
      <div class="drops-row">
        <span style="font-size:1.2rem">🔥</span>
        <span class="drops-lbl">Просмотров контента</span>
        <span class="drops-count" id="dc-badge">${m.drops||0}</span>
        <div class="drops-btns">
          <button class="drop-btn minus" onclick="changeDrop(${id},-1)">−</button>
          <button class="drop-btn plus"  onclick="changeDrop(${id},+1)">+</button>
        </div>
      </div>
      ${tags.length?`<div class="tags-display">${tags.map(t=>`<span class="tag-pill">${escHtml(t.icon||'')} ${escHtml(t.name)}</span>`).join('')}</div>`:''}
      <div class="info-grid">
        ${m.date_of_birth?`<div class="info-cell"><div class="ic-l">Дата рождения</div><div class="ic-v">${m.date_of_birth}</div></div>`:''}
        ${m.age!=null?`<div class="info-cell"><div class="ic-l">${m.date_of_death?'Возраст на момент смерти':'Возраст'}</div><div class="ic-v">${m.age} лет</div></div>`:''}
        ${m.height?`<div class="info-cell"><div class="ic-l">Рост</div><div class="ic-v">${m.height} см</div></div>`:''}
        ${m.weight?`<div class="info-cell"><div class="ic-l">Вес</div><div class="ic-v">${m.weight} кг</div></div>`:''}
        ${m.shoulder_size?`<div class="info-cell"><div class="ic-l">Плечи</div><div class="ic-v">${m.shoulder_size}</div></div>`:''}
      </div>
      <div class="sec-title" style="display:flex;align-items:center;justify-content:space-between">
  <span>Оценки</span>
  <button class="btn btn-ghost" style="height:32px;font-size:12px;padding:0 12px"
          onclick="openModelCasting(${id})">🎬 Кастинг фото</button>
</div>
      <div class="bparts-detail">
        ${BP.map(p=>{
          const bppSrc=window.ImageKit?ImageKit.bpp(bpp[p]):bpp[p];
          return `<div class="bpd-item">
            <div class="bpd-photo"${bppSrc?` onclick="viewImg('${bpp[p]||''}')" style="cursor:pointer"`:''}>
              ${bppSrc?`<img src="${bppSrc}" alt="${BPL[p]}">`:'📷'}
            </div>
            <div class="bpd-lbl">${BPL[p]}</div>
            <div class="bpd-rate ${rateClass(m[RF[p]])}">${m[RF[p]]||'—'}</div>
            <div class="bpd-label-tag">${rateLabelFor(p,m[RF[p]])}</div>
          </div>`;
        }).join('')}
      </div>
      ${extra.length?`<div class="sec-title">Доп. фото</div>
        <div class="extra-photos-strip">
          ${extra.map(src=>{const ts=window.ImageKit?ImageKit.thumb(src):src; return `<div class="ep-item" onclick="viewImg('${src}')"><img src="${ts}"></div>`;}).join('')}
        </div><div style="margin-bottom:16px"></div>`:''}
      ${links.length?`<div class="sec-title">Ссылки</div><div class="detail-links">
        ${links.map(l=>`<a class="detail-link-item" href="${escHtml(l.url)}" target="_blank" rel="noopener">
          <span style="font-size:1.2rem">🔗</span>
          <div><div class="dli-title">${escHtml(l.title||'Ссылка')}</div><div class="dli-url">${escHtml(l.url)}</div></div>
        </a>`).join('')}
      </div>`:''}
      ${similar.length?`<div class="sec-title">Похожие модели</div>
        <div class="similar-row">
          ${similar.map(s=>{const ts=window.ImageKit?ImageKit.thumb(s.main_photo):s.main_photo; return `<div class="sim-card" onclick="nav('detail',{id:${s.id}})">
            <div class="sim-card-photo">${ts?`<img src="${ts}" alt="${escHtml(s.name)}" loading="lazy">`:`<div class="sph">👤</div>`}</div>
            <div class="sim-card-body"><div class="sim-name">${escHtml(s.name)}</div><div class="sim-score">${s.overall||0}</div></div>
          </div>`;}).join('')}
        </div><div style="margin-bottom:18px"></div>`:''}
      <div style="display:flex;gap:10px">
        <button class="btn btn-primary" style="flex:1;height:46px" onclick="editModel(${id})">✏️ Редактировать</button>
        <button class="btn btn-ghost" style="height:46px;padding:0 14px" onclick="nav('casting')" title="Очередь кастинга">📋</button>
        <button class="btn btn-danger" style="height:46px;padding:0 14px" onclick="deleteModel(${id})">🗑</button>
      </div>
    </div>`;
}

function rateClass(v) { if(!v)return''; if(v<3)return'rate-bad'; if(v<6)return'rate-ok'; if(v<8)return'rate-good'; return'rate-top'; }
function rateLabelFor(part,val) { if(!val)return''; const f=RATING_LEVELS[part]?.find(l=>l.value===val); return f?f.label:''; }

function viewImg(src) {
  const ov=document.createElement('div');
  ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:400;display:flex;align-items:center;justify-content:center;padding:20px';
  ov.innerHTML=`<img src="${src}" style="max-width:100%;max-height:90vh;border-radius:12px;object-fit:contain">`;
  ov.onclick=()=>ov.remove();
  document.body.appendChild(ov);
}

async function toggleFav(id) {
  const isFav=await Models.toggleFavorite(id);
  const btn=document.getElementById('fav-btn');
  if(btn){btn.className=`fav-btn ${isFav?'fav-active':''}`;btn.textContent=isFav?'★':'☆';}
  toast(isFav?'Добавлено в любимчики':'Убрано из любимчиков','info');
}

async function changeDrop(id,delta) {
  const next=await Models.changeDrop(id,delta);
  ['dc','dc-badge'].forEach(eid=>{ const el=document.getElementById(eid); if(!el)return; el.textContent=next; el.style.color=delta>0?'var(--gold)':'var(--red)'; setTimeout(()=>el.style.color='',500); });
}

function editModel(id) { State.editingId=id; nav('edit'); }

async function deleteModel(id) {
  modal(`<div class="modal-title">Удалить модель?</div>
    <p style="color:var(--text2);font-size:14px;line-height:1.6">Все данные модели будут удалены. Необратимо.</p>
    <div class="modal-actions"><button class="btn btn-ghost" data-cancel>Отмена</button><button class="btn btn-danger" data-ok>Удалить</button></div>`,
    async()=>{ await Models.delete(id); toast('Модель удалена','info'); nav('home'); });
}

// ── ADD / EDIT ──────────────────────────────────────────────────────
let _formLinks=[], _formExtra=[], _cachedWeights=null;

async function _initFormState(id) {
  _cachedWeights = await Settings.get();
  if (id) { const m=await Models.getById(id); _formLinks=[...(m?.links||[])]; _formExtra=[...(m?.extra_photos||[])]; }
  else { _formLinks=[]; _formExtra=[]; }
}

async function renderAddEdit(id) {
  await _initFormState(id);
  const isEdit=!!id, m=isEdit?await Models.getById(id):null;
  const allTags=await Tags.getAll();
  const v=document.getElementById(isEdit?'view-edit':'view-add');
  const bpp=m?.body_part_photos||{};
  const BP=['face','shoulders','waist','hips','figure'];
  const BPL={face:'Лицо',shoulders:'Плечи',waist:'Талия',hips:'Бёдра',figure:'Фигура'};
  const RF={face:'face_rate',shoulders:'shoulders_rate',waist:'waist_rate',hips:'hips_rate',figure:'figure_rate'};

  topBar(`<button class="btn-icon" onclick="nav('${isEdit?'detail':'home'}')" style="font-size:18px">←</button>
    <span class="top-title">${isEdit?'Редактировать':'Новая модель'}</span>`);

  function ratingBlock(part) {
    const val=m?.[RF[part]]||0, levels=RATING_LEVELS[part];
    const min=levels[0].value, max=levels[levels.length-1].value;
    const photo=bpp[part]||'';
    const photoSrc=window.ImageKit?ImageKit.bpp(photo):photo;
    return `<div class="rating-section slider-rating" id="rsec-${part}">
      <div class="sr-row">
        <div class="sr-photo-wrap">
          <div class="sr-photo" id="srp-${part}">
            <input type="file" accept="image/*" class="bpp-file sr-file-inp" data-part="${part}">
            ${photoSrc?`<img src="${photoSrc}" alt="${BPL[part]}" onclick="viewImg('${photo}')">`:`<div class="bph">📷</div>`}
          </div>
          <div class="sr-photo-actions">
            <button type="button" class="sr-photo-action-btn url-btn" onclick="promptPhotoUrl('bpp','${part}')" title="Вставить URL">🔗</button>
            ${photo?`<button type="button" class="sr-photo-action-btn crop-btn" onclick="cropBpp('${part}')" title="Обрезать">✂</button>`:''}
          </div>
        </div>
        <div class="sr-controls">
          <div class="rating-section-header">
            <span class="rating-section-label">${BPL[part]}</span>
            <span class="rating-section-value" id="rv-${part}">${val||0}</span>
          </div>
          <input class="rate-slider" type="range" id="rs-${part}" min="${min}" max="${max}" step="0.5" value="${val||min}" data-part="${part}" oninput="slideRate(this,'${part}')">
          <div class="sr-labels">
            ${levels.map(l=>`<span class="sr-label-tick" data-val="${l.value}">${l.label}<br><small>${l.value}</small></span>`).join('')}
          </div>
        </div>
      </div>
    </div>`;
  }

  // Предзаполнение из кастинга
  const prefill = State._castingPrefill || null;
  if (prefill && !id) { State._castingPrefill = null; } // сбрасываем после использования

  v.innerHTML=`
    <div class="form-section">
      <div class="form-section-title">📸 Главное фото</div>
      <div class="photo-wrap" id="main-photo-wrap">
        <div class="photo-upload" id="main-upload">
          <input type="file" id="main-file" accept="image/*">
          <div class="photo-upload-box" id="main-box">
            ${m?.main_photo
              ?`<img class="photo-preview" id="main-img" src="${window.ImageKit?ImageKit.card(m.main_photo):m.main_photo}">`
              :`<div class="photo-ph"><div class="ph-icon">📷</div><div class="ph-txt">Нажмите для выбора</div></div>`}
          </div>
        </div>
        <div class="main-photo-actions">
          <button type="button" class="main-action-btn url-btn" onclick="promptPhotoUrl('main')" title="Вставить URL">🔗</button>
          ${m?.main_photo?`<button type="button" class="main-action-btn crop-btn" onclick="cropMain()" title="Кадрировать">✂</button>`:''}
        </div>
      </div>
    </div>
    <div class="form-section">
      <div class="form-section-title">✦ Основная информация</div>
      <div class="form-group"><label class="form-label">Имя *</label><input class="form-input" id="f-name" value="${escHtml(m?.name||prefill?.name||'')}" placeholder="Имя или псевдоним"></div>
      <div class="form-group"><label class="form-label">Псевдонимы (через запятую)</label><input class="form-input" id="f-aliases" value="${escHtml(m?.aliases||'')}" placeholder="Псевдоним 1, Псевдоним 2"></div>
      <div class="form-group"><label class="form-label">Страна</label>
        <select class="form-input" id="f-country">
          <option value="">— Выберите —</option>
          ${COUNTRIES.map(c=>`<option value="${c.name}"${m?.country===c.name?' selected':''}>${c.name}</option>`).join('')}
        </select>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Дата рождения</label><input class="form-input" type="date" id="f-dob" value="${m?.date_of_birth||''}"></div>
        <div class="form-group"><label class="form-label">Дата смерти</label><input class="form-input" type="date" id="f-dod" value="${m?.date_of_death||''}"></div>
      </div>
      <div class="form-row3">
        <div class="form-group"><label class="form-label">Рост (см)</label><input class="form-input" type="number" id="f-height" value="${m?.height||''}" placeholder="170"></div>
        <div class="form-group"><label class="form-label">Вес (кг)</label><input class="form-input" type="number" id="f-weight" value="${m?.weight||''}" placeholder="55"></div>
        <div class="form-group"><label class="form-label">Плечи</label><input class="form-input" type="number" id="f-sh" value="${m?.shoulder_size||''}" placeholder="38"></div>
      </div>
    </div>
    <div class="form-section">
      <div class="form-section-title">⭐ Оценки</div>
      <div class="live-preview-row" id="live-preview">
        <div class="lp-item"><span class="lp-lbl">Overall</span><span class="lp-val" id="lp-overall">—</span></div>
        <div class="lp-item"><span class="lp-lbl">Потенциал</span><span class="lp-val lp-pot" id="lp-potential">—</span></div>
      </div>
      ${BP.map(p=>ratingBlock(p)).join('')}
    </div>
    <div class="form-section">
      <div class="form-section-title">➕ Доп. фото</div>
      <div class="extra-photos-strip" id="extra-strip">
        ${_formExtra.map((src,i)=>{const ts=window.ImageKit?ImageKit.thumb(src):src; return `<div class="ep-item ep-remove" onclick="removeExtra(${i})"><img src="${ts}"><span class="ep-del">✕</span></div>`;}).join('')}
        <div class="ep-add"><input type="file" accept="image/*" id="extra-file" multiple><span>+</span></div>
      </div>
    </div>
    <div class="form-section">
      <div class="form-section-title">🏷️ Теги</div>
      ${allTags.length
        ?`<div class="tags-selector" id="tags-sel">
          ${allTags.map(t=>`<div class="tag-opt${m?.tags?.includes(t.id)?' selected':''}" data-id="${t.id}" data-weight="${t.weight||1}" onclick="this.classList.toggle('selected');liveCalcPreview()">${escHtml(t.icon||'')} ${escHtml(t.name)}</div>`).join('')}
         </div>`
        :`<span style="color:var(--text3);font-size:13px">Нет тегов. <a href="#" onclick="nav('tags')" style="color:var(--accent-light)">Создать теги</a></span>`}
    </div>
    <div class="form-section">
      <div class="form-section-title">🔗 Ссылки</div>
      <div id="links-list"></div>
      <button class="btn btn-ghost" style="width:100%;margin-top:4px" onclick="addLink()">+ Добавить ссылку</button>
    </div>
    <div style="display:flex;gap:12px;padding-bottom:8px">
      <button class="btn btn-ghost" style="flex:1;height:48px" onclick="nav('${isEdit?'detail':'home'}')">Отмена</button>
      <button class="btn btn-gold" style="flex:2;height:48px" id="save-btn" onclick="saveModel(${isEdit?id:'null'})">
        ${isEdit?'💾 Сохранить':'✦ Добавить модель'}
      </button>
    </div>`;

  refreshLinksUI();
  liveCalcPreview();

  // Если пришли из кастинга — устанавливаем имя и фото
  if (!id && prefill?.photo) {
    setMainPhoto(prefill.photo);
  }

  // Main photo input — сначала crop, потом загрузка
  document.getElementById('main-file').addEventListener('change', async e=>{
    const file=e.target.files[0]; if(!file) return;
    const btn=document.getElementById('save-btn');
    if(btn) { btn.disabled=true; btn.textContent='⏳ Загрузка...'; }
    // Показываем превью локально для crop
    const dataUrl = await fileToDataUrl(file);
    openCropper(dataUrl, async (croppedSrc, source) => {
      if (source === 'upload') {
        // Была обрезка — уже загружено в Storage внутри openCropper
        setMainPhoto(croppedSrc, 'upload');
      } else {
        // Продолжить без изменений — загружаем оригинал
        const url = await handlePhotoFile(file);
        setMainPhoto(url, 'upload');
      }
      if(btn) { btn.disabled=false; btn.textContent=isEdit?'💾 Сохранить':'✦ Добавить модель'; }
    });
  });

  // Body part file inputs — сначала crop, потом загрузка
  v.querySelectorAll('.sr-file-inp').forEach(inp=>{
    inp.addEventListener('change', async e=>{
      const part=e.target.dataset.part, file=e.target.files[0]; if(!file) return;
      // Показываем превью локально для crop
      const dataUrl = await fileToDataUrl(file);
      openCropper(dataUrl, async (croppedSrc, source) => {
        if (source === 'upload') {
          // Была обрезка — уже загружено в Storage внутри openCropper
          setBppPhoto(part, croppedSrc, 'upload');
        } else {
          // Продолжить без изменений — загружаем оригинал
          const url = await handlePhotoFile(file);
          setBppPhoto(part, url, 'upload');
        }
      }, 1); // 1:1 aspect ratio для частей тела
    });
  });

  // Extra photos
  document.getElementById('extra-file').addEventListener('change', async e=>{
    for (const file of e.target.files) {
      const url = await handlePhotoFile(file);
      _formExtra.push(url);
    }
    refreshExtraStrip();
  });

  // Init slider fills
  BP.forEach(p=>{
    const sl=document.getElementById('rs-'+p); if(!sl) return;
    const levels=RATING_LEVELS[p], min=levels[0].value, max=levels[levels.length-1].value;
    const pct=((parseFloat(sl.value)-min)/(max-min))*100;
    sl.style.setProperty('--pct',pct+'%');
  });
}

// ── Form helpers ────────────────────────────────────────────────────
function addLink() { _formLinks.push({title:'',url:''}); refreshLinksUI(); }
function removeLink(i) {
  _formLinks.forEach((l,idx)=>{ const t=document.getElementById(`lt-${idx}`),u=document.getElementById(`lu-${idx}`); if(t)l.title=t.value; if(u)l.url=u.value; });
  _formLinks.splice(i,1); refreshLinksUI();
}
function refreshLinksUI() {
  const c=document.getElementById('links-list'); if(!c) return;
  c.innerHTML=_formLinks.map((l,i)=>`
    <div class="link-row-inputs" id="lr-${i}">
      <input class="form-input" style="height:38px" placeholder="Название" id="lt-${i}" value="${escHtml(l.title||'')}">
      <input class="form-input" style="height:38px" placeholder="URL" id="lu-${i}" value="${escHtml(l.url||'')}">
      <button class="btn btn-danger" style="height:38px;padding:0 10px;flex-shrink:0" onclick="removeLink(${i})">✕</button>
    </div>`).join('');
}
function removeExtra(i) { _formExtra.splice(i,1); refreshExtraStrip(); }
function refreshExtraStrip() {
  const strip=document.getElementById('extra-strip'); if(!strip) return;
  strip.innerHTML=_formExtra.map((src,i)=>{ const ts=window.ImageKit?ImageKit.thumb(src):src; return `<div class="ep-item ep-remove" onclick="removeExtra(${i})"><img src="${ts}"><span class="ep-del">✕</span></div>`; }).join('');
  const add=document.createElement('div'); add.className='ep-add';
  add.innerHTML=`<input type="file" accept="image/*" id="extra-file" multiple><span>+</span>`;
  const urlBtn=document.createElement('button'); urlBtn.type='button'; urlBtn.className='btn btn-ghost'; urlBtn.style='height:32px;padding:0 10px;font-size:12px;margin-left:6px;flex-shrink:0'; urlBtn.textContent='🔗 URL'; urlBtn.onclick=()=>promptPhotoUrl('extra');
  strip.appendChild(urlBtn);
  strip.appendChild(add);
  document.getElementById('extra-file').addEventListener('change',async e=>{
    for(const file of e.target.files){ const url=await handlePhotoFile(file); _formExtra.push(url); }
    refreshExtraStrip();
  });
}
// ── Photo URL input ────────────────────────────────────────────────
// Позволяет вставить прямой URL вместо загрузки файла
// target: 'main' | 'bpp' | 'extra'
// part: только для bpp — 'face'|'shoulders' и т.д.
function promptPhotoUrl(target, part) {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `
    <div class="modal" style="max-width:420px">
      <div class="modal-title">🔗 Вставить URL фото</div>
      <div class="form-group" style="margin-top:12px">
        <input class="form-input" id="photo-url-inp" placeholder="https://..." style="height:44px" autocomplete="off">
      </div>
      <div id="photo-url-preview" style="height:120px;background:var(--bg2,#1a1a1a);border-radius:8px;margin:10px 0;display:flex;align-items:center;justify-content:center;overflow:hidden;color:var(--text3,#555);font-size:13px">
        Превью появится здесь
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="purl-cancel">Отмена</button>
        <button class="btn btn-gold" id="purl-ok" disabled>Применить</button>
      </div>
    </div>`;
  document.body.appendChild(ov);

  const inp = ov.querySelector('#photo-url-inp');
  const preview = ov.querySelector('#photo-url-preview');
  const okBtn = ov.querySelector('#purl-ok');

  // Живое превью при вводе
  let previewTimer;
  inp.addEventListener('input', () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      const url = inp.value.trim();
      if (!url || !url.startsWith('http')) {
        preview.innerHTML = 'Введите корректный URL';
        okBtn.disabled = true;
        return;
      }
      preview.innerHTML = `<img src="${url}" style="max-width:100%;max-height:120px;object-fit:contain;border-radius:6px" onerror="this.parentElement.innerHTML='❌ Не удалось загрузить изображение';document.querySelector('#purl-ok').disabled=true" onload="document.querySelector('#purl-ok').disabled=false">`;
    }, 400);
  });

  ov.querySelector('#purl-cancel').onclick = () => ov.remove();

  okBtn.onclick = () => {
    const url = inp.value.trim();
    if (!url) return;
    ov.remove();
    // Показываем crop окно с загруженным по URL изображением
    if (target === 'main') {
      openCropper(url, (croppedSrc, source) => {
        if (source === 'upload') {
          // Была обрезка — используем обрезанную версию (уже в Storage)
          setMainPhoto(croppedSrc, 'upload');
        } else {
          // Продолжить без изменений — используем URL как есть
          setMainPhoto(url, 'url');
        }
      });
    } else if (target === 'bpp' && part) {
      openCropper(url, (croppedSrc, source) => {
        if (source === 'upload') {
          setBppPhoto(part, croppedSrc, 'upload');
        } else {
          setBppPhoto(part, url, 'url');
        }
      }, 1);
    } else if (target === 'extra') {
      _formExtra.push(url);
      refreshExtraStrip();
    }
  };

  // Вставить по Enter
  inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !okBtn.disabled) okBtn.click(); });

  setTimeout(() => inp.focus(), 50);
}

// ── Photo source tracking ────────────────────────────────────────
// Храним источник фото в State._photoMeta
// { main_photo: 'url'|'upload'|'', body_part_photos: {face:'url',...}, extra_photos: ['url',...] }
State._photoMeta = null;

function _getPhotoMeta() {
  if (!State._photoMeta) State._photoMeta = { main_photo: '', body_part_photos: {}, extra_photos: [] };
  return State._photoMeta;
}

function _setPhotoSource(target, source, part) {
  const meta = _getPhotoMeta();
  if (target === 'main') {
    meta.main_photo = source;
  } else if (target === 'bpp' && part) {
    meta.body_part_photos[part] = source;
  } else if (target === 'extra') {
    meta.extra_photos.push(source);
  }
}

function _updatePhotoSourceBadge(target, part) {
  const meta = _getPhotoMeta();
  let source = '';
  if (target === 'main') source = meta.main_photo;
  else if (target === 'bpp' && part) source = meta.body_part_photos[part] || '';

  // Ищем существующий badge или создаём
  const container = target === 'main' 
    ? document.getElementById('main-photo-wrap')
    : document.querySelector(`#srp-${part}`)?.parentElement;
  if (!container) return;

  let badge = container.querySelector('.photo-source-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'photo-source-badge';
    container.style.position = 'relative';
    container.appendChild(badge);
  }

  if (source === 'url') {
    badge.textContent = '🔗 URL';
    badge.style.cssText = 'position:absolute;top:6px;left:6px;z-index:10;font-size:10px;background:rgba(0,0,0,0.7);color:#8cf;padding:2px 6px;border-radius:4px;border:1px solid rgba(136,192,255,0.3);pointer-events:none';
  } else if (source === 'upload') {
    badge.textContent = '📦 Бакет';
    badge.style.cssText = 'position:absolute;top:6px;left:6px;z-index:10;font-size:10px;background:rgba(0,0,0,0.7);color:#8c8;padding:2px 6px;border-radius:4px;border:1px solid rgba(136,200,136,0.3);pointer-events:none';
  } else {
    badge.style.display = 'none';
  }
}

function setMainPhoto(src, source) {
  const box=document.getElementById('main-box');
  if(box) box.innerHTML=`<img class="photo-preview" id="main-img" src="${src}">`;
  if (source) _setPhotoSource('main', source);
  else {
    // Определяем источник автоматически
    const meta = _getPhotoMeta();
    if (src.startsWith('http') && !src.includes('/storage/v1/object/public/')) {
      meta.main_photo = 'url';
    } else if (src && src !== '') {
      meta.main_photo = 'upload';
    }
  }
  _updatePhotoSourceBadge('main');
  const wrap=document.getElementById('main-photo-wrap');
  if(wrap){
    const act=wrap.querySelector('.main-photo-actions');
    if(act){
      let cb=act.querySelector('.crop-btn');
      if(!cb){
        cb=document.createElement('button');
        cb.type='button';
        cb.className='main-action-btn crop-btn';
        cb.textContent='✂';
        cb.title='Кадрировать';
        act.appendChild(cb);
      }
      cb.onclick=cropMain;
    }
  }
}
function cropMain() { const img=document.getElementById('main-img'); if(!img) return; openCropper(img.src,src=>setMainPhoto(src,'upload')); }
function setBppPhoto(part,src, source) {
  const srp=document.getElementById(`srp-${part}`); if(!srp) return;
  const existing=srp.querySelector('img');
  if(existing){existing.src=src;existing.onclick=()=>viewImg(src);}
  else{const bph=srp.querySelector('.bph');if(bph)bph.remove();const img=document.createElement('img');img.src=src;img.alt=part;img.onclick=()=>viewImg(src);srp.appendChild(img);}
  if (source) _setPhotoSource('bpp', source, part);
  else {
    const meta = _getPhotoMeta();
    if (src.startsWith('http') && !src.includes('/storage/v1/object/public/')) {
      meta.body_part_photos[part] = 'url';
    } else if (src && src !== '') {
      meta.body_part_photos[part] = 'upload';
    }
  }
  _updatePhotoSourceBadge('bpp', part);
  const wrap=srp.parentElement;
  if(wrap){
    const act=wrap.querySelector('.sr-photo-actions');
    if(act){
      let cb=act.querySelector('.crop-btn');
      if(!cb){
        cb=document.createElement('button');
        cb.type='button';
        cb.className='sr-photo-action-btn crop-btn';
        cb.textContent='✂';
        cb.title='Обрезать';
        act.appendChild(cb);
      }
      cb.onclick=()=>cropBpp(part);
    }
  }
}
function cropBpp(part) { const srp=document.getElementById(`srp-${part}`); if(!srp) return; const img=srp.querySelector('img'); if(!img) return; openCropper(img.src,src=>setBppPhoto(part,src,'upload'),1); }

function slideRate(input,part) {
  const val=parseFloat(input.value), disp=document.getElementById('rv-'+part);
  if(disp) disp.textContent=val;
  const levels=RATING_LEVELS[part], min=levels[0].value, max=levels[levels.length-1].value;
  input.style.setProperty('--pct',((val-min)/(max-min))*100+'%');
  liveCalcPreview();
}

function liveCalcPreview() {
  const BP=['face','shoulders','waist','hips','figure'];
  const RF={face:'face_rate',shoulders:'shoulders_rate',waist:'waist_rate',hips:'hips_rate',figure:'figure_rate'};
  const ratings={};
  BP.forEach(p=>{ const v=document.getElementById('rs-'+p)?.value; ratings[RF[p]]=v?parseFloat(v):0; });
  const w=_cachedWeights||DEFAULT_WEIGHTS;
  let overall=calcOverallSync(ratings,w);
  document.querySelectorAll('.tag-opt.selected').forEach(el=>{ overall*=parseFloat(el.dataset.weight||'1'); });
  overall=Math.round(overall*100)/100;
  const dob=document.getElementById('f-dob')?.value||null, dod=document.getElementById('f-dod')?.value||null;
  const age=dod?calcAgeAtDeath(dob,dod):calcAge(dob);
  const pot=Math.round(overall*calcAgeK(age)*100)/100;
  const elo=document.getElementById('lp-overall'), elp=document.getElementById('lp-potential');
  if(elo) elo.textContent=overall||'—';
  if(elp) elp.textContent=(pot&&pot!==overall)?pot:(pot||'—');
}

async function collectRatings() {
  const BP=['face','shoulders','waist','hips','figure'];
  const RF={face:'face_rate',shoulders:'shoulders_rate',waist:'waist_rate',hips:'hips_rate',figure:'figure_rate'};
  const out={};
  BP.forEach(p=>{ const v=document.getElementById('rs-'+p)?.value; out[RF[p]]=v?parseFloat(v):0; });
  return out;
}

async function saveModel(id) {
  const name=document.getElementById('f-name')?.value.trim();
  if(!name){toast('Введите имя','error');return;}
  const btn=document.getElementById('save-btn');
  if(btn){btn.disabled=true;btn.textContent='⏳ Сохранение...';}

  try {
    const ratings=await collectRatings();
    const BP=['face','shoulders','waist','hips','figure'];
    const bpp={};
    BP.forEach(p=>{ const img=document.querySelector(`#srp-${p} img`); if(img) bpp[p]=img.src; });

    const collectedLinks=[];
    _formLinks.forEach((_,i)=>{ const t=document.getElementById(`lt-${i}`)?.value.trim(), u=document.getElementById(`lu-${i}`)?.value.trim(); if(u) collectedLinks.push({title:t||u,url:u}); });

    const selTags=[...document.querySelectorAll('.tag-opt.selected')].map(el=>parseInt(el.dataset.id));
    const mainImg=document.getElementById('main-img');

    const data={
      name,
      aliases:       document.getElementById('f-aliases')?.value.trim()||'',
      country:       document.getElementById('f-country')?.value.trim()||'',
      date_of_birth: document.getElementById('f-dob')?.value||null,
      date_of_death: document.getElementById('f-dod')?.value||null,
      height:        parseFloat(document.getElementById('f-height')?.value)||null,
      weight:        parseFloat(document.getElementById('f-weight')?.value)||null,
      shoulder_size: parseFloat(document.getElementById('f-sh')?.value)||null,
      main_photo:    mainImg?.src||'',
      body_part_photos:bpp, extra_photos:_formExtra, links:collectedLinks, tags:selTags,
      is_favorite:   id?(await Models.getById(id))?.is_favorite||false:false,
      drops:         id?(await Models.getById(id))?.drops||0:0,
      ...ratings
    };

    if(id){
      await Models.update(id,data);
      toast('Сохранено ✓','success');
      State.detailId=id;
      nav('detail');
    } else {
      const nid = await Models.add(data);
      toast('Модель добавлена ✦','success');
      // Если пришли из кастинга — помечаем запись как добавленную
      const pf = State._castingPrefill;
      if (pf?.castingId != null) {
        State._castingPrefill = null;
        await CastingDB.setStatus(pf.castingId, 'added');
      }
      State.detailId = nid;
      nav('detail');
    }
  } catch(e) {
    if(e.message?.startsWith('DUPLICATE')) toast('Дублирующееся имя — проверьте псевдонимы','error');
    else toast('Ошибка: '+e.message,'error');
  } finally {
    if(btn){btn.disabled=false;btn.textContent=id?'💾 Сохранить':'✦ Добавить модель';}
    updateSyncIndicator();
  }
}

// ── TAGS ───────────────────────────────────────────────────────────
async function renderTagMgr() {
  topBar(`<button class="btn-icon" onclick="nav('home')" style="font-size:18px">←</button>
    <span class="top-title">Теги</span>
    <div class="top-actions"><button class="btn btn-primary" style="height:36px" onclick="openTagModal()">+ Тег</button></div>`);
  const v=document.getElementById('view-tags'), tags=await Tags.getAll();
  if(!tags.length){v.innerHTML=`<div class="empty-state"><div class="es-icon">🏷️</div><div class="es-title">Нет тегов</div><div class="es-text">Теги влияют на расчёт Overall через коэффициент-множитель</div></div>`;return;}
  v.innerHTML=`<p style="color:var(--text3);font-size:12px;margin-bottom:14px">Коэффициент тега умножается на итоговый Overall (>1 повышает, &lt;1 снижает).</p>
    ${tags.map(t=>`<div class="tag-list-item">
      <span class="tli-icon">${escHtml(t.icon||'🏷️')}</span>
      <div class="tli-info"><div class="tli-name">${escHtml(t.name)}</div><div class="tli-weight">Коэф. ×${t.weight}</div></div>
      <button class="btn btn-ghost" style="height:32px;padding:0 10px;font-size:12px" onclick="openTagModal(${t.id})">✏️</button>
      <button class="btn btn-danger" style="height:32px;padding:0 10px;font-size:12px" onclick="deleteTag(${t.id})">🗑</button>
    </div>`).join('')}`;
}
async function openTagModal(id=null) {
  const t=id?await db.tags.get(id):null;
  modal(`<div class="modal-title">${id?'Редактировать тег':'Новый тег'}</div>
    <div class="form-group"><label class="form-label">Эмодзи</label><input class="form-input" id="ti" value="${escHtml(t?.icon||'🏷️')}"></div>
    <div class="form-group"><label class="form-label">Название *</label><input class="form-input" id="tn" value="${escHtml(t?.name||'')}" placeholder="Название"></div>
    <div class="form-group"><label class="form-label">Коэффициент (1.0 = нейтральный)</label><input class="form-input" type="number" id="tw" step="0.01" min="0.1" max="5" value="${t?.weight||1.0}"></div>
    <div class="modal-actions"><button class="btn btn-ghost" data-cancel>Отмена</button><button class="btn btn-gold" data-ok>Сохранить</button></div>`,
    async(ov)=>{ const name=ov.querySelector('#tn').value.trim(); if(!name){toast('Введите название','error');return;} const icon=ov.querySelector('#ti').value.trim()||'🏷️', weight=parseFloat(ov.querySelector('#tw').value)||1.0; if(id)await Tags.update(id,{icon,name,weight});else await Tags.add({icon,name,weight}); await Models.recalcAll(); toast(id?'Тег обновлён':'Тег создан','success'); renderTagMgr(); });
}
async function deleteTag(id) {
  modal(`<div class="modal-title">Удалить тег?</div><p style="color:var(--text2);font-size:14px">Тег будет удалён у всех моделей.</p>
    <div class="modal-actions"><button class="btn btn-ghost" data-cancel>Отмена</button><button class="btn btn-danger" data-ok>Удалить</button></div>`,
    async()=>{ await Tags.delete(id); toast('Тег удалён','info'); renderTagMgr(); });
}

// ── BANS ───────────────────────────────────────────────────────────
async function renderBans() {
  topBar(`<button class="btn-icon" onclick="nav('home')" style="font-size:18px">←</button>
    <span class="top-title">Бан-лист</span>
    <div class="top-actions"><button class="btn btn-primary" style="height:34px" onclick="openBanModal()">+ Бан</button></div>`);
  const v=document.getElementById('view-bans'), bans=await BanRecords.getAll();
  const icons={'Дубликат':'🔁','Низкое качество':'⬇️','Неактуально':'📁','Другое':'❓'};
  if(!bans.length){v.innerHTML=`<div class="empty-state"><div class="es-icon">🚫</div><div class="es-title">Бан-лист пуст</div></div>`;return;}
  v.innerHTML=bans.map(b=>`<div class="ban-item">
    <span class="ban-icon">${icons[b.reason]||'🚫'}</span>
    <div class="ban-info"><div class="ban-name">${escHtml(b.name)}</div><div class="ban-reason">${escHtml(b.reason)}${b.description?': '+escHtml(b.description):''}</div></div>
    <button class="btn btn-danger" style="height:32px;padding:0 10px;font-size:12px" onclick="deleteBan(${b.id})">✕</button>
  </div>`).join('');
}
function openBanModal() {
  modal(`<div class="modal-title">Добавить в бан-лист</div>
    <div class="form-group"><label class="form-label">Имя / текст *</label><input class="form-input" id="bn" placeholder="Имя или описание"></div>
    <div class="form-group"><label class="form-label">Причина</label>
      <select class="form-select" id="br" onchange="document.getElementById('bd-grp').style.display=this.value==='Другое'?'block':'none'">
        <option>Дубликат</option><option>Низкое качество</option><option>Неактуально</option><option>Другое</option>
      </select>
    </div>
    <div class="form-group" id="bd-grp" style="display:none"><label class="form-label">Описание</label><input class="form-input" id="bd" placeholder="Уточните"></div>
    <div class="modal-actions"><button class="btn btn-ghost" data-cancel>Отмена</button><button class="btn btn-primary" data-ok>Добавить</button></div>`,
    async(ov)=>{ const name=ov.querySelector('#bn').value.trim(); if(!name){toast('Введите имя','error');return;} await BanRecords.add({name,reason:ov.querySelector('#br').value,description:ov.querySelector('#bd').value.trim()}); toast('Добавлено в бан-лист','success'); renderBans(); });
}
async function deleteBan(id) { await BanRecords.delete(id); toast('Удалено','info'); renderBans(); }

// ── STATS ──────────────────────────────────────────────────────────
async function renderStats() {
  topBar(`<span class="top-title">Статистика</span>`);
  const v=document.getElementById('view-stats');
  v.innerHTML='<div class="loading"><div class="spinner"></div></div>';
  const s=await Stats.get();
  if(!s.total){v.innerHTML=`<div class="empty-state"><div class="es-icon">📊</div><div class="es-title">Нет данных</div></div>`;return;}
  const allTags=await Tags.getAll(), tagMap=Object.fromEntries(allTags.map(t=>[t.id,t]));
  const parLbl={face:'Лицо',shoulders:'Плечи',waist:'Талия',hips:'Бёдра',figure:'Фигура'};
  const parKeys=Object.keys(parLbl);
  function topList(arr,field,title){
    return `<div class="sec-title">${title}</div><div class="top-list">
      ${arr.map((m,i)=>{const ts=window.ImageKit?ImageKit.thumb(m.main_photo):m.main_photo; return `<div class="top-item" onclick="nav('detail',{id:${m.id}})">
        <div class="top-photo">${ts?`<img src="${ts}">`:'👤'}</div>
        <span class="top-rank${i<3?' gold':''}">${i+1}</span>
        <span class="top-name">${escHtml(m.name)}</span>
        <span class="top-score">${m[field]||0}</span>
      </div>`;}).join('')}
    </div>`;
  }
  function distBars(lbls,bkts){
    const maxC=Math.max(...bkts,1);
    return lbls.map((lbl,i)=>`<div class="dist-col">
      <div class="dist-bar-wrap"><div class="dist-bar" style="height:${Math.max(Math.round(bkts[i]/maxC*100),4)}%"></div></div>
      <div class="dist-count">${bkts[i]}</div><div class="dist-lbl">${lbl}</div>
    </div>`).join('');
  }
  const tagStats=Object.entries(s.tagCounts).map(([id,count])=>({tag:tagMap[parseInt(id)],count})).filter(x=>x.tag).sort((a,b)=>b.count-a.count).slice(0,8);
  v.innerHTML=`
    <div class="stats-kpi">
      <div class="kpi-card accent-gold"><div class="kpi-val">${s.total}</div><div class="kpi-lbl">Моделей</div></div>
      <div class="kpi-card"><div class="kpi-val">${s.favorites}</div><div class="kpi-lbl">Любимчиков</div></div>
      <div class="kpi-card accent-gold"><div class="kpi-val">${s.avgOverall}</div><div class="kpi-lbl">Средний Overall</div></div>
      <div class="kpi-card"><div class="kpi-val">${s.avgPotential}</div><div class="kpi-lbl">Ср. Потенциал</div></div>
      <div class="kpi-card"><div class="kpi-val">${s.active}</div><div class="kpi-lbl">Активных</div></div>
      <div class="kpi-card"><div class="kpi-val">${s.totalDrops}</div><div class="kpi-lbl">Всего Drops</div></div>
    </div>
    <div class="sec-title">Распределение Overall</div>
    <div class="dist-chart">${distBars(['<20','20–40','40–60','60–80','80+'],s.overallBuckets)}</div>
    <div class="sec-title">Средние оценки</div>
    <div class="bar-chart">${parKeys.map(k=>`<div class="bc-row"><span class="bc-label">${parLbl[k]}</span><div class="bc-track"><div class="bc-fill" style="width:${Math.round(s.paramAvg[k]/10*100)}%"></div></div><span class="bc-val">${s.paramAvg[k]}</span></div>`).join('')}</div>
    <div class="sec-title">Распределение по параметрам</div>
    <div class="param-dist-grid">${parKeys.map(k=>`<div class="pd-item"><div class="pd-label">${parLbl[k]}</div><div class="dist-chart dist-mini">${distBars(['<2','2–4','4–6','6–8','8+'],s.distribution[k+'_rate']||[0,0,0,0,0])}</div></div>`).join('')}</div>
    ${topList(s.topOverall,'overall','🏆 Топ-10 по Overall')}
    ${topList(s.topPotential,'potential','⚡ Топ-10 по Потенциалу')}
    ${topList(s.topDrops,'drops','🔥 Топ-10 по Drops')}
    ${topList(s.topHips,'hips_rate','💎 Топ-5 Бёдра')}
    ${topList(s.topWaist,'waist_rate','✨ Топ-5 Талия')}
    ${Object.keys(s.countries).length?`<div class="sec-title">По странам</div><div class="country-list">${Object.entries(s.countries).sort((a,b)=>b[1]-a[1]).map(([c,n])=>`<div class="country-item"><span class="ci-name">${escHtml(c)}</span><span class="ci-count">${n}</span></div>`).join('')}</div>`:''}
    ${tagStats.length?`<div class="sec-title">По тегам</div><div class="tag-stat-list">${tagStats.map(({tag,count})=>`<div class="tag-stat-item"><span class="tsi-icon">${escHtml(tag.icon||'🏷️')}</span><span class="tsi-name">${escHtml(tag.name)}</span><div class="tsi-bar-wrap"><div class="tsi-bar" style="width:${Math.round(count/(tagStats[0]?.count||1)*100)}%"></div></div><span class="tsi-count">${count}</span></div>`).join('')}</div>`:''}`;
}

// ── SETTINGS ───────────────────────────────────────────────────────
async function renderSettings() {
  topBar(`<span class="top-title">Настройки</span>`);
  const v=document.getElementById('view-settings'), w=await Settings.get();
  const WL=[{key:'face',label:'Face (Лицо)',def:1.4},{key:'shoulders',label:'Shoulders (Плечи)',def:1.2},{key:'waist',label:'Waist (Талия)',def:1.4},{key:'hips',label:'Hips (Бёдра)',def:1.2},{key:'figure',label:'Figure (Фигура)',def:1.4}];
  const status=await SyncManager.getStatus?.()??{};
  v.innerHTML=`
    ${State.user?`<div class="sync-status-bar">
      <div class="ssb-info">
        <span class="ssb-email">${escHtml(State.user.email)}</span>
        <span class="ssb-status ${status.isOnline?'online':'offline'}">${status.isOnline?'●':'○'} ${status.isOnline?'Онлайн':'Офлайн'}</span>
      </div>
      <div class="ssb-actions">
        ${status.pending>0?`<span class="ssb-pending">⏳${status.pending}</span>`:''}
        <button class="btn btn-ghost" style="height:34px;font-size:12px" onclick="manualSync()">↻ Синхронизировать</button>
        <button class="btn btn-danger" style="height:34px;font-size:12px" onclick="doSignOut()">Выйти</button>
      </div>
    </div><div class="divider"></div>`:
    `<div class="auth-prompt"><p style="color:var(--text2);font-size:13px;margin-bottom:12px">Войдите для синхронизации данных между устройствами</p>
      <button class="btn btn-gold" style="width:100%;height:44px" onclick="showAuthModal()">🔐 Войти / Зарегистрироваться</button></div><div class="divider"></div>`}
    <div class="form-section">
      <div class="form-section-title">⚖️ Веса для расчёта Overall</div>
      <p style="color:var(--text3);font-size:13px;line-height:1.6;margin-bottom:14px">Overall = (Σ оценка × вес) ÷ Σ весов × 10 × коэф. тегов</p>
      ${WL.map(({key,label,def})=>`<div class="weight-row"><span class="weight-label">${label}</span><input class="weight-input" type="number" id="w-${key}" step="0.05" min="0.1" max="10" value="${w[key]||def}"></div>`).join('')}
      <div style="display:flex;gap:10px;margin-top:14px">
        <button class="btn btn-ghost" style="flex:1;height:44px" onclick="resetWeights()">↺ Сброс</button>
        <button class="btn btn-gold" style="flex:2;height:44px" onclick="saveWeights()">💾 Сохранить</button>
      </div>
    </div>
    <div class="divider"></div>
    <div class="form-section">
      <div class="form-section-title">📦 Экспорт и импорт</div>
      <div class="io-grid">
        <button class="btn btn-gold" style="height:46px" onclick="exportData()">📤 Экспорт</button>
        <button class="btn btn-primary" style="height:46px" onclick="document.getElementById('imp').click()">📥 Импорт</button>
      </div>
      <input type="file" id="imp" accept=".json" style="display:none" onchange="importData(this)">
    </div>
    <div class="divider"></div>
    <div class="form-section">
      <div class="form-section-title">⚠️ Опасная зона</div>
      <button class="btn btn-danger" style="width:100%;height:44px" onclick="clearAll()">🗑 Очистить все данные</button>
    </div>`;

    // Inject casting keywords editor
const kw = loadCastingKw();
const kwSection = document.createElement('div');
kwSection.innerHTML = `<div class="divider"></div>
  <div class="form-section">
    <div class="form-section-title">🎬 Ключевые слова кастинга</div>
    <p style="color:var(--text3);font-size:12px;line-height:1.6;margin-bottom:12px">
      Добавляются к имени модели при поиске фото в кастинге
    </p>
    ${CASTING_SLOTS.map(s => `
      <div class="weight-row">
        <span class="weight-label" style="width:90px">${s.label}</span>
        <input class="form-input" id="ckw-${s.key}" style="flex:1;height:36px"
               value="${escHtml(kw[s.key] || '')}">
      </div>`).join('')}
    <div style="display:flex;gap:10px;margin-top:12px">
      <button class="btn btn-ghost" style="flex:1;height:44px"
              onclick="resetCastingKw()">↺ Сброс</button>
      <button class="btn btn-gold" style="flex:2;height:44px"
              onclick="saveCastingKwFromUI()">💾 Сохранить</button>
    </div>
  </div>`;

document.getElementById('view-settings').appendChild(kwSection);
}

function saveCastingKwFromUI() {
  const kw = {};
  CASTING_SLOTS.forEach(s => {
    kw[s.key] = document.getElementById('ckw-' + s.key)?.value.trim() || '';
  });
  saveCastingKw(kw);
  toast('Ключевые слова сохранены', 'success');
}

function resetCastingKw() {
  CASTING_SLOTS.forEach(s => {
    const el = document.getElementById('ckw-' + s.key);
    if (el) el.value = DEFAULT_CASTING_KW[s.key] || '';
  });
  saveCastingKw({ ...DEFAULT_CASTING_KW });
  toast('Сброшено', 'info');
}

async function doSignOut() {
  try { await Auth.signOut(); State.user=null; SyncManager._userId=null; toast('Вышли из аккаунта','info'); renderSettings(); }
  catch(e) { toast('Ошибка: '+e.message,'error'); }
}

function showAuthModal() {
  modal(`<div class="modal-title">Войти в аккаунт</div>
    <div class="form-group"><label class="form-label">Email</label><input class="form-input" type="email" id="m-email" autocomplete="email"></div>
    <div class="form-group"><label class="form-label">Пароль</label><input class="form-input" type="password" id="m-pass" autocomplete="current-password"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-cancel>Отмена</button>
      <button class="btn btn-primary" id="m-signup">Регистрация</button>
      <button class="btn btn-gold" data-ok>Войти</button>
    </div>`,
    async(ov)=>{
      const email=ov.querySelector('#m-email').value.trim(), pass=ov.querySelector('#m-pass').value;
      if(!email||!pass){toast('Введите email и пароль','error');return;}
      try{ const user=await Auth.signIn(email,pass); await onUserSignedIn(user); renderSettings(); }
      catch(e){toast('Ошибка входа: '+e.message,'error');}
    });
  // signup button
  setTimeout(()=>{
    const ov=document.querySelector('.modal-overlay');
    ov?.querySelector('#m-signup')?.addEventListener('click',async()=>{
      const email=ov.querySelector('#m-email').value.trim(), pass=ov.querySelector('#m-pass').value;
      if(!email||!pass){toast('Введите email и пароль','error');return;}
      try{ await Auth.signUp(email,pass); toast('Аккаунт создан! Теперь войдите.','success'); }
      catch(e){toast('Ошибка: '+e.message,'error');}
    });
  },50);
}

async function saveWeights() {
  const keys=['face','shoulders','waist','hips','figure'], w={};
  keys.forEach(k=>{ w[k]=parseFloat(document.getElementById('w-'+k)?.value)||DEFAULT_WEIGHTS[k]; });
  await Settings.set(w); _cachedWeights=w;
  await Models.recalcAll();
  toast('Веса сохранены, Overall пересчитан ✓','success');
  updateSyncIndicator();
}
async function resetWeights() { Object.entries(DEFAULT_WEIGHTS).forEach(([k,v])=>{ const el=document.getElementById('w-'+k); if(el)el.value=v; }); toast('Сброшено (не сохранено)','info'); }

async function exportData() {
  try { const json=await DataIO.exportAll(), a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([json],{type:'application/json'})); a.download=`psbase-${new Date().toISOString().slice(0,10)}.json`; a.click(); toast('Экспорт готов ✓','success'); } catch(e){toast('Ошибка экспорта','error');}
}
async function importData(inp) {
  const file = inp.files[0];
  if (!file) return;

  const text = await file.text();

  modal(`
    <div class="modal-title">Импорт данных</div>
    <p style="color:var(--text2);font-size:14px">
      Все текущие данные будут <strong>заменены</strong> данными из "${escHtml(file.name)}".
    </p>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-cancel>Отмена</button>
      <button class="btn btn-danger" data-ok>Импортировать</button>
    </div>
  `,
  async () => {
    try {
      // 🔥 ВОТ ЭТО МЕНЯЕМ
      await importDataSafe(text);

      toast('Импорт завершён ✓', 'success');
      nav('home');

    } catch (e) {
      toast('Ошибка: ' + e.message, 'error');
    }
  });

  inp.value = '';
}

async function importDataSafe(text) {
  const json = JSON.parse(text);

  if (!json.models) {
    throw new Error('Неверный формат файла');
  }

  // ⚠️ 1. ОЧИЩАЕМ БАЗУ (раз у тебя "замена")
  await db.transaction('rw', db.models, db.tags, db.banRecords, async () => {
    await db.models.clear();
    await db.tags.clear();
    await db.banRecords.clear();
  });

  let added = 0;

  // 🧠 2. Импорт моделей
  for (const m of json.models) {
    const model = normalizeModel(m);
    await Models.add(model);
    added++;
  }

  // 🧠 3. (если есть) теги
  if (json.tags) {
    for (const t of json.tags) {
      await db.tags.add({
        name: t.name || '',
        icon: t.icon || '🏷️',
        weight: t.weight || 1.0,
        _local_updated: Date.now()
      });
    }
  }

  // 🧠 4. бан записи
  if (json.banRecords) {
    for (const b of json.banRecords) {
      await db.banRecords.add({
        name: b.name || '',
        reason: b.reason || '',
        description: b.description || '',
        date_added: b.date_added || Date.now(),
        _local_updated: Date.now()
      });
    }
  }

  // 🔥 5. ОБЯЗАТЕЛЬНО: синк
  if (navigator.onLine && window.SyncManager) {
    await SyncManager.flush();
    await SyncManager.pull(true);
  }

  return added;
}

function clearAll() {
  modal(`<div class="modal-title">Очистить всё?</div>
    <p style="color:var(--text2);font-size:14px;line-height:1.6">Все модели, теги и баны будут удалены. Необратимо.</p>
    <div class="modal-actions"><button class="btn btn-ghost" data-cancel>Отмена</button><button class="btn btn-danger" data-ok>Очистить</button></div>`,
    async()=>{ await db.transaction('rw',db.models,db.tags,db.banRecords,async()=>{ await db.models.clear();await db.tags.clear();await db.banRecords.clear(); }); toast('База очищена','info');nav('home'); });
}

// ── CASTING ────────────────────────────────────────────────────────
// Очередь кастинга хранится в IndexedDB — персистентна между сессиями и устройствами

const CastingDB = {
  async getAll()            { return db.castingQueue.orderBy('createdAt').toArray(); },
  async add(name)           { return db.castingQueue.add({ name, status: 'pending', createdAt: Date.now() }); },
  async setStatus(id, status) { return db.castingQueue.update(id, { status }); },
  async remove(id)          { return db.castingQueue.delete(id); },
  async clearDone()         { return db.castingQueue.where('status').notEqual('pending').delete(); },
};

let _castingCurrentId = null;

// ── Добавить пачку имён ───────────────────────────────────────────
function openAddBatchModal() {
  modal(`
    <div class="modal-title">🎬 Добавить пачку в кастинг</div>
    <p style="color:var(--text2);font-size:13px;margin-bottom:12px">
      Вставь список имён через запятую или с новой строки
    </p>
    <textarea class="form-input" id="batch-names" style="height:140px;padding:12px"
      placeholder="Anna Doe, Jane Smith&#10;Kate Brown"></textarea>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-cancel>Отмена</button>
      <button class="btn btn-gold" data-ok>Добавить в кастинг</button>
    </div>`,
    async (ov) => {
      const raw   = ov.querySelector('#batch-names').value;
      const names = raw.split(/[,\n]/).map(n => n.trim()).filter(Boolean);
      if (!names.length) { toast('Введите хотя бы одно имя', 'error'); return; }
      const existing = new Set((await CastingDB.getAll()).map(c => c.name.toLowerCase()));
      let added = 0;
      for (const name of names) {
        if (!existing.has(name.toLowerCase())) {
          await CastingDB.add(name);
          added++;
        }
      }
      toast(`Добавлено ${added} имён в кастинг`, 'success');
      renderCasting();
    }
  );
}

// ── Главный экран кастинга ────────────────────────────────────────
async function renderCasting() {
  let v = document.getElementById('view-casting');
  if (!v) {
    v = document.createElement('main');
    v.className = 'view'; v.id = 'view-casting';
    document.getElementById('app').insertBefore(v, document.querySelector('.bottom-nav'));
  }
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  v.classList.add('active');
  State.view = 'casting';

  topBar(`
    <button class="btn-icon" onclick="nav('home')" style="font-size:18px">←</button>
    <span class="top-title">Кастинг</span>
    <div class="top-actions">
      <button class="btn btn-gold" style="height:36px;padding:0 12px;font-size:13px"
        onclick="openAddBatchModal()">+ Пачка</button>
    </div>`);

  const all     = await CastingDB.getAll();
  const pending = all.filter(c => c.status === 'pending');
  const done    = all.filter(c => c.status !== 'pending');

  if (!all.length) {
    v.innerHTML = `
      <div class="empty-state">
        <div class="es-icon">🎬</div>
        <div class="es-title">Кастинг пуст</div>
        <div class="es-text">Нажмите «+ Пачка» чтобы добавить список имён</div>
      </div>
      <button class="btn btn-gold" style="width:100%;height:48px" onclick="openAddBatchModal()">
        + Добавить пачку имён
      </button>`;
    return;
  }

  v.innerHTML = `
    <div class="cast-queue-stats">
      <span class="cqs-item pending">⏳ ${pending.length} ожидают</span>
      <span class="cqs-item done">✓ ${done.length} обработано</span>
    </div>

    ${pending.length ? `
    <div class="sec-title">Ожидают проверки</div>
    <div class="cast-name-list">
      ${pending.map(c => `
        <div class="cast-name-item" onclick="openCastingItem(${c.id})">
          <span class="cni-name">${escHtml(c.name)}</span>
          <div class="cni-right">
            <button class="cni-del" onclick="event.stopPropagation();deleteCastingItem(${c.id})">✕</button>
            <span class="cni-arrow">→</span>
          </div>
        </div>`).join('')}
    </div>` : ''}

    ${done.length ? `
    <div class="sec-title" style="margin-top:18px">Обработано</div>
    <div class="cast-name-list">
      ${done.map(c => `
        <div class="cast-name-item ${c.status}">
          <span class="cni-icon">${c.status === 'added' ? '✓' : '🚫'}</span>
          <span class="cni-name">${escHtml(c.name)}</span>
          <div class="cni-right">
            <span class="cni-status">${c.status === 'added' ? 'Добавлена' : 'В бан'}</span>
            <button class="cni-del" onclick="deleteCastingItem(${c.id})">✕</button>
          </div>
        </div>`).join('')}
    </div>
    <button class="btn btn-ghost" style="width:100%;margin-top:12px;height:40px;font-size:12px"
      onclick="clearDoneCasting()">Очистить обработанных</button>
    ` : ''}`;
}

async function deleteCastingItem(id) {
  await CastingDB.remove(id);
  renderCasting();
}

async function clearDoneCasting() {
  await CastingDB.clearDone();
  renderCasting();
}

// ── Открыть элемент кастинга ──────────────────────────────────────
async function openCastingItem(id) {
  _castingCurrentId = id;
  const item = await db.castingQueue.get(id);
  if (!item) return;

  let v = document.getElementById('view-casting');
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
  v.classList.add('active');

  topBar(`
    <button class="btn-icon" onclick="renderCasting()" style="font-size:18px">←</button>
    <span class="top-title" style="font-size:14px">${escHtml(item.name)}</span>
    <button class="btn-icon" style="color:var(--red)" onclick="deleteCastingItem(${id})">✕</button>`);

  v.innerHTML = `
    <div class="cast-item-header">
      <div class="cast-item-name">${escHtml(item.name)}</div>
      <div class="cast-item-actions">
        <button class="btn btn-primary" style="flex:1;height:44px" onclick="castingAddModel()">
          ✦ Добавить модель
        </button>
        <button class="btn btn-danger" style="height:44px;padding:0 14px" onclick="castingBanModel()">
          🚫 В бан
        </button>
      </div>
    </div>

    <div id="cast-selected-wrap" style="display:none;background:var(--surface);border:1px solid var(--gold-dim);border-radius:var(--r-sm);padding:12px;margin-bottom:14px">
      <div class="sec-title" style="margin-bottom:8px">Выбранное фото</div>
      <div style="display:flex;align-items:center;gap:12px">
        <img id="cast-sel-img" src="" style="width:80px;height:110px;object-fit:cover;border-radius:8px">
        <button class="btn btn-ghost" style="height:32px;font-size:12px" onclick="clearSelectedPhoto()">
          ✕ Убрать
        </button>
      </div>
    </div>

    <div class="cast-search-row">
      <div class="search-bar" style="flex:1;margin-bottom:0">
        <span class="si">🔍</span>
        <input id="cast-q" type="text" value="${escHtml(item.name)}" placeholder="Поиск фото...">
        <button class="sc" onclick="document.getElementById('cast-q').value=''">✕</button>
      </div>
      <button class="btn btn-gold" style="height:44px;padding:0 14px;flex-shrink:0"
        onclick="castingSearch()">🔍 Найти фото</button>
    </div>

    <div id="cast-results" class="casting-grid"></div>
    <div id="cast-empty"></div>`;

  document.getElementById('cast-q').addEventListener('keydown', e => {
    if (e.key === 'Enter') castingSearch();
  });
}

// ── Поиск фото ────────────────────────────────────────────────────
async function castingSearch() {
  const q   = document.getElementById('cast-q')?.value.trim();
  const res = document.getElementById('cast-results');
  const emp = document.getElementById('cast-empty');
  if (!q || !res) return;

  res.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  if (emp) emp.innerHTML = '';

  try {
    const results = await DDGImages.search(q, 24);
    res.innerHTML = '';
    if (!results.length) {
      if (emp) emp.innerHTML = `<div class="empty-state"><div class="es-icon">🖼</div><div class="es-title">Ничего не найдено</div></div>`;
      return;
    }
    results.forEach(img => {
      const card = document.createElement('div');
      card.className = 'cast-card';
      card.innerHTML = `
        <img src="${escHtml(img.thumb)}" alt="" loading="lazy"
             onerror="this.parentElement.style.display='none'">
        <div class="cast-card-actions"><button class="cast-use-btn">Выбрать</button></div>`;
      card.querySelector('img').onclick          = () => viewImg(img.full);
      card.querySelector('.cast-use-btn').onclick = () => selectCastingPhoto(img.full, img.thumb);
      res.appendChild(card);
    });
  } catch(e) {
    res.innerHTML = '';
    if (emp) emp.innerHTML = `<div class="empty-state"><div class="es-icon">⚠️</div><div class="es-title">Ошибка</div><div class="es-text">${escHtml(e.message)}</div></div>`;
  }
}

function selectCastingPhoto(fullUrl, thumbUrl) {
  const wrap = document.getElementById('cast-selected-wrap');
  const img  = document.getElementById('cast-sel-img');
  if (!wrap || !img) return;
  img.src = thumbUrl || fullUrl;
  img.dataset.full = fullUrl;
  wrap.style.display = 'block';
  wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  toast('Фото выбрано', 'info', 1500);
}

function clearSelectedPhoto() {
  const wrap = document.getElementById('cast-selected-wrap');
  const img  = document.getElementById('cast-sel-img');
  if (wrap) wrap.style.display = 'none';
  if (img)  { img.src = ''; delete img.dataset.full; }
}

async function castingAddModel() {
  const item = await db.castingQueue.get(_castingCurrentId);
  if (!item) return;
  const selImg   = document.getElementById('cast-sel-img');
  const photoUrl = selImg?.dataset?.full || '';
  State._castingPrefill = { name: item.name, photo: photoUrl, castingId: _castingCurrentId };
  nav('add');
}

async function castingBanModel() {
  const item = await db.castingQueue.get(_castingCurrentId);
  if (!item) return;
  modal(`
    <div class="modal-title">🚫 В бан-лист</div>
    <div class="form-group"><label class="form-label">Имя</label>
      <input class="form-input" id="ban-name" value="${escHtml(item.name)}"></div>
    <div class="form-group"><label class="form-label">Причина</label>
      <select class="form-select" id="ban-reason">
        <option>Не подходит</option><option>Дубликат</option>
        <option>Низкое качество</option><option>Другое</option>
      </select></div>
    <div class="form-group"><label class="form-label">Комментарий</label>
      <input class="form-input" id="ban-desc" placeholder="Необязательно"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-cancel>Отмена</button>
      <button class="btn btn-danger" data-ok>В бан</button>
    </div>`,
    async (ov) => {
      const name   = ov.querySelector('#ban-name').value.trim();
      const reason = ov.querySelector('#ban-reason').value;
      const desc   = ov.querySelector('#ban-desc').value.trim();
      await BanRecords.add({ name, reason, description: desc });
      await CastingDB.setStatus(_castingCurrentId, 'banned');
      toast(`${name} — в бан-листе`, 'info');
      renderCasting();
    }
  );
}

// ── MODEL CASTING ────────────────────────────────────────────────
function openModelCasting(id) {
  State._modelCastingId = id;
  State._modelCastingPicks = {};
  
  // Ensure view element exists (may be missing if index.html not updated)
  let vEl = document.getElementById('view-model-casting');
  if (!vEl) {
    vEl = document.createElement('main');
    vEl.className = 'view';
    vEl.id = 'view-model-casting';
    document.getElementById('app').insertBefore(vEl, document.querySelector('.bottom-nav'));
  }
  
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
  vEl.classList.add('active');
  State.view = 'model-casting';
  renderModelCasting(id);
}

async function renderModelCasting(id) {
  const m = await Models.getById(id);
  if (!m) { nav('detail', { id: State.detailId }); return; }

  const kw = loadCastingKw();

  topBar(`
    <button class="btn-icon" style="font-size:18px" onclick="nav('detail',{id:${id}})">←</button>
    <span class="top-title" style="font-size:13px">🎬 ${escHtml(m.name)}</span>
    <button class="btn btn-gold" style="height:32px;font-size:12px;padding:0 10px"
            onclick="finishModelCasting(${id})">✓ Готово</button>`);

  const v = document.getElementById('view-model-casting');
  v.innerHTML = CASTING_SLOTS.map(s => `
    <div class="mcast-slot" id="mcs-${s.key}">
      <div class="mcast-slot-header">
        <span class="mcast-slot-label">${s.label}</span>
        <div class="mcast-pick-preview" id="mcp-${s.key}">
+          <img id="mcpi-${s.key}">
+          <button class="mcast-clear-btn" onclick="clearMcastPick('${s.key}')">✕</button>
+        </div>
      </div>
      <div class="mcast-search-row">
        <input class="form-input mcast-q" id="mcast-q-${s.key}"
               value="${escHtml(m.name)} ${escHtml(kw[s.key] || '')}">
        <button class="btn btn-ghost mcast-search-btn"
                onclick="runMcastSlot('${s.key}')">🔍</button>
      </div>
      <div class="mcast-results" id="mcr-${s.key}">
        <div class="loading"><div class="spinner"></div></div>
      </div>
    </div>`).join('') +
    `<div class="mcast-finish-bar">
       <button class="btn btn-gold" style="width:100%;height:50px;font-size:15px"
               onclick="finishModelCasting(${id})">✓ Завершить кастинг</button>
     </div>
     <div style="height:24px"></div>`;

  // Wire Enter key on each search input
  CASTING_SLOTS.forEach(s => {
    document.getElementById('mcast-q-' + s.key)
      ?.addEventListener('keydown', e => { if (e.key === 'Enter') runMcastSlot(s.key); });
  });

  // Auto-search all slots in parallel
  CASTING_SLOTS.forEach(s => runMcastSlot(s.key));
}

async function runMcastSlot(slotKey) {
  const input  = document.getElementById('mcast-q-' + slotKey);
  const resDiv = document.getElementById('mcr-' + slotKey);
  if (!input || !resDiv) return;
  const q = input.value.trim();
  if (!q) return;

  resDiv.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    const results = await DDGImages.search(q, 12);
    resDiv.innerHTML = '';
    if (!results.length) {
      resDiv.innerHTML = '<div class="mcast-empty">Нет результатов</div>';
      return;
    }
    const strip = document.createElement('div');
    strip.className = 'mcast-strip';
    const slot = CASTING_SLOTS.find(s => s.key === slotKey);
    results.forEach(img => {
      const card = document.createElement('div');
      card.className = 'mcast-card';
      card.innerHTML = `
        <img src="${escHtml(img.thumb)}" loading="lazy"
             onerror="this.parentElement.style.display='none'">
        <div class="mcast-card-btns">
          <button class="mcast-url-btn"
            onclick="pickMcastPhoto('${slotKey}','${escHtml(img.full)}','${escHtml(img.thumb)}')">🔗</button>
          <button class="mcast-crop-btn"
            onclick="pickMcastPhoto('${slotKey}','${escHtml(img.full)}',${slot?.aspect ?? NaN})">✂</button>
        </div>`;
      card.querySelector('img').onclick = () => viewImg(img.full);
      strip.appendChild(card);
    });
    resDiv.appendChild(strip);
  } catch(e) {
    resDiv.innerHTML = `<div class="mcast-empty">Ошибка: ${escHtml(e.message)}</div>`;
  }
}

function pickMcastPhoto(slotKey, fullUrl, thumbUrl) {
  State._modelCastingPicks[slotKey] = { url: fullUrl, thumb: thumbUrl, type: 'url' };
  _updateMcastPreview(slotKey, thumbUrl || fullUrl);
  // Подсветить выбранную карточку в стрипе
  const resDiv = document.getElementById('mcr-' + slotKey);
  resDiv?.querySelectorAll('.mcast-card').forEach(c => {
    const u = c.querySelector('.mcast-url-btn')?.getAttribute('onclick') || '';
    c.classList.toggle('mcast-selected', u.includes(fullUrl.slice(0, 40)));
  });
  toast('URL сохранён', 'success', 1400);
}

function pickMcastCrop(slotKey, fullUrl, aspect) {
  openCropper(fullUrl, (croppedSrc) => {
    State._modelCastingPicks[slotKey] = { url: croppedSrc, thumb: croppedSrc, type: 'upload' };
    _updateMcastPreview(slotKey, croppedSrc);
    toast('Обрезано и загружено', 'success', 1800);
  }, isNaN(aspect) ? NaN : aspect);
}

function _updateMcastPreview(slotKey, src) {
  const wrap = document.getElementById('mcp-' + slotKey);
  const img  = document.getElementById('mcpi-' + slotKey);
  if (!wrap || !img) return;
  img.src = src;
  wrap.classList.add('has-pick');
}

function clearMcastPick(slotKey) {
  delete State._modelCastingPicks[slotKey];
  const wrap = document.getElementById('mcp-' + slotKey);
  const img  = document.getElementById('mcpi-' + slotKey);
  if (wrap) wrap.classList.remove('has-pick');
  if (img)  img.src = '';
}

async function finishModelCasting(id) {
  const picks = State._modelCastingPicks || {};
  const keys  = Object.keys(picks);
  if (!keys.length) {
    toast('Нет выбранных фото', 'info');
    nav('detail', { id });
    return;
  }
  const m = await Models.getById(id);
  if (!m) return;

  // Patch only photo fields — bypass Models.update (which requires full model + recalculates scores)
const patch = {};
if (picks.main) patch.main_photo = picks.main.url;

const bpp = { ...(m.body_part_photos || {}) };
['face','shoulders','waist','hips','figure'].forEach(k => {
  if (picks[k]) bpp[k] = picks[k].url;
});
patch.body_part_photos = bpp;

await db.models.update(id, patch);  // прямое обновление, без checkDuplicate и пересчёта

  State._modelCastingPicks = {};
  toast(`Обновлено ${keys.length} фото`, 'success');
  State.detailId = id;
  nav('detail', { id });
}


// ── INIT ────────────────────────────────────────────────────────────
// ── INIT ────────────────────────────────────────────────────────────
async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

  document.querySelectorAll('.nav-btn').forEach(btn => btn.addEventListener('click', () => nav(btn.dataset.nav)));
  
  const sbConfigured = CONFIG.supabase.url !== 'https://YOURPROJECT.supabase.co';

  if (sbConfigured) {
    const user = await Auth.current();
    if (user) {
      State.user = user;
      SyncManager._userId = user.id;
      
      // Инициализация синхронизации для залогиненного пользователя
      SyncManager.startListeners();
      
      nav('home');

        // 1. Сборка мусора (GC) — выполняется один раз при запуске
 const lastGC = localStorage.getItem('psbase-last-gc');
if (!lastGC || Date.now() - parseInt(lastGC) > 86_400_000) {
  SyncManager.gc();
  localStorage.setItem('psbase-last-gc', String(Date.now()));
}

      if (navigator.onLine) {
        // Запускаем реалтайм и первичную синхронизацию
        SyncManager.startRealtime(); 
        SyncManager.sync().then(r => {
          if (r.pulled > 0) { 
            toast(`Получено ${r.pulled} обновлений`, 'info', 2500); 
            reloadGrid(); 
          }
          updateSyncIndicator();
        });
      }
    } else {
      renderAuth();
    }

    Auth.onAuthChange(async user => {
      const wasAuthed = !!State.user;
      State.user = user;
      SyncManager._userId = user ? user.id : null;

      if (user && !wasAuthed) {
        SyncManager.startListeners();
        if (navigator.onLine) {
          SyncManager.startRealtime(); // Включаем реалтайм при логине
          SyncManager.sync().then(() => updateSyncIndicator());
        }
      }
      updateSyncIndicator();
    });

  } else {
    // Локальный режим
    document.querySelector('.bottom-nav').style.display = '';
    SyncManager.startListeners(); // Слушатели нужны даже локально для работы IndexedDB
    nav('home');
  }
}

document.addEventListener('DOMContentLoaded', init);
