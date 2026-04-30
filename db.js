// db.js — PSBase v5 (Supabase + ImageKit ready)

const db = new Dexie('PSBase');

db.version(1).stores({ models:'++id,name,country,is_favorite,drops,overall,potential,date_added', tags:'++id,name', banRecords:'++id,name,reason,date_added' });
db.version(2).stores({ models:'++id,name,country,is_favorite,drops,overall,potential,date_added', tags:'++id,name', banRecords:'++id,name,reason,date_added', settings:'key' });
db.version(3).stores({ models:'++id,name,country,is_favorite,drops,overall,potential,date_added', tags:'++id,name', banRecords:'++id,name,reason,date_added', settings:'key' });
db.version(4).stores({ models:'++id,name,country,is_favorite,drops,overall,potential,date_added', tags:'++id,name', banRecords:'++id,name,reason,date_added', settings:'key', syncQueue:'++id,table,operation,recordId,createdAt', syncMeta:'key' });
// v5: remote_id индексы для быстрого merge при pull
db.version(5).stores({
  models:     '++id, name, country, is_favorite, drops, overall, potential, date_added, remote_id',
  tags:       '++id, name, remote_id',
  banRecords: '++id, name, reason, date_added, remote_id',
  settings:   'key',
  syncQueue:  '++id, table, operation, recordId, createdAt',
  syncMeta:   'key'
});

// v6: составной индекс в syncQueue для дедупликации upsert
db.version(6).stores({
  models:     '++id, name, country, is_favorite, drops, overall, potential, date_added, remote_id',
  tags:       '++id, name, remote_id',
  banRecords: '++id, name, reason, date_added, remote_id',
  settings:   'key',
  syncQueue:  '++id, [table+operation+recordId], createdAt',
  syncMeta:   'key'
});

// v7: _local_updated для правильного conflict resolution при pull
db.version(7).stores({
  models:     '++id, name, country, is_favorite, drops, overall, potential, date_added, remote_id, _local_updated',
  tags:       '++id, name, remote_id, _local_updated',
  banRecords: '++id, name, reason, date_added, remote_id, _local_updated',
  settings:   'key',
  syncQueue:  '++id, [table+operation+recordId], createdAt',
  syncMeta:   'key'
});

// ── Rating Levels ─────────────────────────────────────────────────
const RATING_LEVELS = {
  face:      [ {label:'Плохо',value:2}, {label:'Обычно',value:5}, {label:'Симпатично',value:7.5}, {label:'МОДЕЛЬ',value:10} ],
  shoulders: [ {label:'Плохо',value:2}, {label:'Обычно',value:5}, {label:'Красивая',value:7.5},   {label:'ВЗРЫВ',value:10}  ],
  hips:      [ {label:'Плохо',value:2}, {label:'Обычно',value:5}, {label:'Красивая',value:7.5},   {label:'КАЙФ',value:10}   ],
  waist:     [ {label:'Страшно',value:2}, {label:'Обычная',value:5}, {label:'СМАК',value:10} ],
  figure:    [ {label:'Плохо',value:2}, {label:'Немного перебор',value:5}, {label:'Обычное',value:7}, {label:'Идеал',value:10} ],
};

const DEFAULT_WEIGHTS = { face:1.4, shoulders:1.2, waist:1.4, hips:1.2, figure:1.4 };

const COUNTRIES = [
  {name:'🇦🇺 Австралия'},{name:'🇦🇹 Австрия'},{name:'🇦🇿 Азербайджан'},{name:'🇦🇷 Аргентина'},
  {name:'🇦🇲 Армения'},{name:'🇧🇾 Беларусь'},{name:'🇧🇪 Бельгия'},{name:'🇧🇬 Болгария'},
  {name:'🇧🇷 Бразилия'},{name:'🇬🇧 Великобритания'},{name:'🇭🇺 Венгрия'},{name:'🇩🇪 Германия'},
  {name:'🇬🇷 Греция'},{name:'🇬🇪 Грузия'},{name:'🇩🇰 Дания'},{name:'🇪🇬 Египет'},
  {name:'🇮🇱 Израиль'},{name:'🇮🇳 Индия'},{name:'🇮🇩 Индонезия'},{name:'🇮🇷 Иран'},
  {name:'🇮🇪 Ирландия'},{name:'🇪🇸 Испания'},{name:'🇮🇹 Италия'},{name:'🇰🇿 Казахстан'},
  {name:'🇨🇦 Канада'},{name:'🇨🇳 Китай'},{name:'🇨🇴 Колумбия'},{name:'🇱🇻 Латвия'},
  {name:'🇱🇹 Литва'},{name:'🇲🇽 Мексика'},{name:'🇳🇱 Нидерланды'},{name:'🇳🇴 Норвегия'},
  {name:'🇦🇪 ОАЭ'},{name:'🇵🇰 Пакистан'},{name:'🇵🇱 Польша'},{name:'🇵🇹 Португалия'},
  {name:'🇷🇺 Россия'},{name:'🇷🇴 Румыния'},{name:'🇺🇸 США'},{name:'🇷🇸 Сербия'},
  {name:'🇹🇭 Таиланд'},{name:'🇹🇷 Турция'},{name:'🇺🇿 Узбекистан'},{name:'🇺🇦 Украина'},
  {name:'🇫🇮 Финляндия'},{name:'🇫🇷 Франция'},{name:'🇭🇷 Хорватия'},{name:'🇨🇿 Чехия'},
  {name:'🇨🇭 Швейцария'},{name:'🇸🇪 Швеция'},{name:'🇯🇵 Япония'},
];

// ── Settings ──────────────────────────────────────────────────────
const Settings = {
  _cache: null,
  async get() {
    if (this._cache) return this._cache;
    const row = await db.settings.get('weights');
    this._cache = row ? {...DEFAULT_WEIGHTS,...row.value} : {...DEFAULT_WEIGHTS};
    return this._cache;
  },
  async set(weights) {
    this._cache = {...DEFAULT_WEIGHTS,...weights};
    await db.settings.put({ key:'weights', value:this._cache });
    if (window.SyncManager) {
      await SyncManager.enqueue('settings','upsert','weights',{value:this._cache});
      if (navigator.onLine) SyncManager.flush();
    }
  },
  invalidate() { this._cache = null; }
};

// ── Calculations ──────────────────────────────────────────────────
function calcOverallWith(model, tagList, w) {
  const {face_rate=0,figure_rate=0,hips_rate=0,shoulders_rate=0,waist_rate=0} = model;
  const wSum = w.face+w.shoulders+w.waist+w.hips+w.figure;
  const sum  = face_rate*w.face + shoulders_rate*w.shoulders + waist_rate*w.waist + hips_rate*w.hips + figure_rate*w.figure;
  let score  = (sum/wSum)*10;
  if (tagList?.length) score *= tagList.reduce((p,t)=>p*(t.weight||1),1);
  return Math.round(score*100)/100;
}
function calcAgeK(age) {
  if (age==null) return 1.0;
  if (age<25)    return 1.08;
  if (age<=30)   return 1.0;
  return Math.max(0.85, 1-(age-30)*0.015);
}
function calcAge(dob) {
  if (!dob) return null;
  const b = dob.length<=4 ? new Date(dob+'-07-01') : new Date(dob);
  if (isNaN(b)) return null;
  const n = new Date();
  let a = n.getFullYear()-b.getFullYear();
  if (n.getMonth()<b.getMonth()||(n.getMonth()===b.getMonth()&&n.getDate()<b.getDate())) a--;
  return a;
}
function calcAgeAtDeath(dob,dod) {
  if (!dob||!dod) return null;
  const b=dob.length<=4?new Date(dob+'-07-01'):new Date(dob), d=new Date(dod);
  if (isNaN(b)||isNaN(d)) return null;
  let a=d.getFullYear()-b.getFullYear();
  if (d.getMonth()<b.getMonth()||(d.getMonth()===b.getMonth()&&d.getDate()<b.getDate())) a--;
  return a;
}
function calcPotential(overall, model) {
  const age = model.date_of_death ? calcAgeAtDeath(model.date_of_birth,model.date_of_death) : calcAge(model.date_of_birth);
  return Math.round(overall*calcAgeK(age)*100)/100;
}
async function computeModelScores(model) {
  let tagList = [];
  if (model.tags?.length) tagList = (await db.tags.bulkGet(model.tags)).filter(Boolean);
  const w = await Settings.get();
  const overall = calcOverallWith(model,tagList,w);
  return { overall, potential: calcPotential(overall,model) };
}
function calcOverallSync(ratings, weights) {
  const w = weights||DEFAULT_WEIGHTS;
  const {face_rate=0,shoulders_rate=0,waist_rate=0,hips_rate=0,figure_rate=0} = ratings;
  const wSum = w.face+w.shoulders+w.waist+w.hips+w.figure;
  const sum  = face_rate*w.face+shoulders_rate*w.shoulders+waist_rate*w.waist+hips_rate*w.hips+figure_rate*w.figure;
  return Math.round((sum/wSum)*10*100)/100;
}

// ── Duplicate check ───────────────────────────────────────────────
async function checkDuplicate(name, aliases, excludeId=null) {
  const all=await db.models.toArray(), nl=name.trim().toLowerCase();
  const na=aliases?aliases.split(',').map(a=>a.trim().toLowerCase()).filter(Boolean):[];
  for (const m of all) {
    if (m.id===excludeId) continue;
    const ml=m.name.toLowerCase(), ma=m.aliases?m.aliases.split(',').map(a=>a.trim().toLowerCase()):[];
    if (ml===nl)                    throw new Error('DUPLICATE:name');
    if (ma.includes(nl))            throw new Error('DUPLICATE:alias');
    if (na.includes(ml))            throw new Error('DUPLICATE:alias');
    if (na.some(a=>ma.includes(a))) throw new Error('DUPLICATE:alias');
  }
}

// ── Helpers ───────────────────────────────────────────────────────
// Загружает файл как ImageKit URL (если авторизован и онлайн),
// иначе возвращает DataURL как раньше — прозрачный fallback
async function processPhotoForSave(dataUrlOrFile) {
  if (!dataUrlOrFile) return '';
  // Уже ImageKit URL — нормализуем, уберем параметры
  if (typeof dataUrlOrFile === 'string' && !dataUrlOrFile.startsWith('data:')) {
    // Уберем параметры трансформации, оставим чистый URL
    const url = dataUrlOrFile.split('?')[0];
    return url;
  }
  // Если ImageKit сконфигурирован — пробуем загрузить
  if (window.ImageKit && window.SyncManager && navigator.onLine) {
    try {
      if (typeof dataUrlOrFile === 'string') {
        return await ImageKit.uploadDataUrl(dataUrlOrFile, `photo-${Date.now()}`);
      } else {
        const res = await ImageKit.uploadFile(dataUrlOrFile);
        return res.url;
      }
    } catch(e) { console.warn('ImageKit upload failed, storing locally:', e.message); }
  }
  return dataUrlOrFile; // fallback: DataURL в IndexedDB
}

// ── Models CRUD ───────────────────────────────────────────────────
const Models = {
  async getAll()    { return db.models.orderBy('date_added').reverse().toArray(); },
  async getById(id) { return db.models.get(id); },

  async add(data) {
    await checkDuplicate(data.name, data.aliases);
    const scores = await computeModelScores(data);

    // Обработаем фото
    data.main_photo = await processPhotoForSave(data.main_photo);
    data.body_part_photos = Object.fromEntries(await Promise.all(Object.entries(data.body_part_photos || {}).map(async ([k,v]) => [k, await processPhotoForSave(v)])));
    data.extra_photos = await Promise.all((data.extra_photos || []).map(async v => await processPhotoForSave(v)));

    const localId = await db.models.add({
      ...data,
      name:             data.name.trim(),
      age:              calcAge(data.date_of_birth),
      overall:          scores.overall,
      potential:        scores.potential,
      drops:            data.drops       || 0,
      is_favorite:      data.is_favorite || false,
      tags:             data.tags        || [],
      body_part_photos: data.body_part_photos || {},
      extra_photos:     data.extra_photos     || [],
      links:            data.links            || [],
      date_added:       Date.now(),
      _local_updated:   Date.now(),
    });
    if (window.SyncManager) {
      await SyncManager.enqueue('models','upsert',localId);
      if (navigator.onLine) SyncManager.flush();
    }
    return localId;
  },

  async update(id, data) {
    await checkDuplicate(data.name, data.aliases, id);
    const scores = await computeModelScores(data);

    // Обработаем фото
    data.main_photo = await processPhotoForSave(data.main_photo);
    data.body_part_photos = Object.fromEntries(await Promise.all(Object.entries(data.body_part_photos || {}).map(async ([k,v]) => [k, await processPhotoForSave(v)])));
    data.extra_photos = await Promise.all((data.extra_photos || []).map(async v => await processPhotoForSave(v)));

    // Соберем старые URL фото перед обновлением
    const oldModel = await db.models.get(id);
    const oldUrls = oldModel ? ImageKit.collectModelUrls(oldModel) : [];

    await db.models.update(id, {
      ...data, name:data.name.trim(),
      age:calcAge(data.date_of_birth),
      overall:scores.overall, potential:scores.potential,
      _local_updated: Date.now(),
    });

    // Удалим старые фото, которые больше не используются
    if (window.ImageKit && navigator.onLine) {
      try {
        const newModel = await db.models.get(id);
        const newUrls = newModel ? ImageKit.collectModelUrls(newModel) : [];
        const toDelete = oldUrls.filter(u => !newUrls.includes(u));
        if (toDelete.length) await ImageKit.deleteUrls(toDelete);
      } catch(e) { console.warn('Storage photo delete failed:', e.message); }
    }

    if (window.SyncManager) {
      await SyncManager.enqueue('models','upsert',id);
      if (navigator.onLine) SyncManager.flush();
    }
    return id;
  },

  async delete(id) {
    // Удаляем фото из Storage перед удалением записи
    if (window.ImageKit && navigator.onLine) {
      try {
        const m = await db.models.get(id);
        if (m) await ImageKit.deleteUrls(ImageKit.collectModelUrls(m));
      } catch(e) { console.warn('Storage photo delete failed:', e.message); }
    }
    await db.models.delete(id);
    if (window.SyncManager) {
      await SyncManager.enqueue('models','delete',id);
      if (navigator.onLine) SyncManager.flush();
    }
  },

  async changeDrop(id, delta) {
    const m = await db.models.get(id);
    const next = Math.max(0,(m.drops||0)+delta);
    await db.models.update(id,{drops:next, _local_updated: Date.now()});
    if (window.SyncManager) {
      await SyncManager.enqueue('models','upsert',id);
      if (navigator.onLine) SyncManager.flush();
    }
    return next;
  },

  async toggleFavorite(id) {
    const m = await db.models.get(id);
    const val = !m.is_favorite;
    await db.models.update(id,{is_favorite:val, _local_updated: Date.now()});
    if (window.SyncManager) {
      await SyncManager.enqueue('models','upsert',id);
      if (navigator.onLine) SyncManager.flush();
    }
    return val;
  },

  async search(query) {
    const q = query.toLowerCase();
    return db.models.filter(m=>
      m.name.toLowerCase().includes(q)||
      (m.aliases&&m.aliases.toLowerCase().includes(q))||
      (m.country&&m.country.toLowerCase().includes(q))
    ).toArray();
  },

  async recalcAll() {
    const all = await db.models.toArray();
    for (const m of all) {
      const s = await computeModelScores(m);
      await db.models.update(m.id,{...s,age:calcAge(m.date_of_birth)});
    }
  },

  getSimilar(model, all, limit=6) {
    const fields = ['face_rate','shoulders_rate','waist_rate','hips_rate','figure_rate'];
    return all
      .filter(m=>m.id!==model.id)
      .map(m=>{
        const dist=Math.sqrt(fields.reduce((s,f)=>s+Math.pow((model[f]||0)-(m[f]||0),2),0));
        const shared=(model.tags||[]).filter(t=>(m.tags||[]).includes(t)).length;
        return {m, score:dist-shared*1.5};
      })
      .sort((a,b)=>a.score-b.score)
      .slice(0,limit)
      .map(x=>x.m);
  }
};

// ── Tags ──────────────────────────────────────────────────────────
const Tags = {
  async getAll() { return db.tags.orderBy('name').toArray(); },
  async add(d) {
    const localId = await db.tags.add({ icon:d.icon||'🏷️', name:d.name.trim(), weight:parseFloat(d.weight)||1.0, _local_updated: Date.now() });
    if (window.SyncManager) { await SyncManager.enqueue('tags','upsert',localId); if(navigator.onLine) SyncManager.flush(); }
    return localId;
  },
  async update(id,d) {
    await db.tags.update(id,{ icon:d.icon, name:d.name.trim(), weight:parseFloat(d.weight)||1.0, _local_updated: Date.now() });
    if (window.SyncManager) { await SyncManager.enqueue('tags','upsert',id); if(navigator.onLine) SyncManager.flush(); }
  },
  async delete(id) {
    const all = await db.models.toArray();
    for (const m of all) if (m.tags?.includes(id)) await db.models.update(m.id,{tags:m.tags.filter(t=>t!==id)});
    await db.tags.delete(id);
    if (window.SyncManager) { await SyncManager.enqueue('tags','delete',id); if(navigator.onLine) SyncManager.flush(); }
  }
};

// ── Bans ──────────────────────────────────────────────────────────
const BanRecords = {
  async getAll() { return db.banRecords.orderBy('date_added').reverse().toArray(); },
  async add(d) {
    const localId = await db.banRecords.add({ name:d.name.trim(), reason:d.reason, description:d.description||'', date_added:Date.now(), _local_updated: Date.now() });
    if (window.SyncManager) { await SyncManager.enqueue('banRecords','upsert',localId); if(navigator.onLine) SyncManager.flush(); }
    return localId;
  },
  async delete(id) {
    await db.banRecords.delete(id);
    if (window.SyncManager) { await SyncManager.enqueue('banRecords','delete',id); if(navigator.onLine) SyncManager.flush(); }
  }
};

// ── Stats ─────────────────────────────────────────────────────────
const Stats = {
  async get() {
    const all = await db.models.toArray();
    if (!all.length) return {total:0};
    const avg = f => { const v=all.map(m=>m[f]||0); return Math.round(v.reduce((a,b)=>a+b,0)/v.length*100)/100; };
    const top = (f,n=10) => [...all].sort((a,b)=>(b[f]||0)-(a[f]||0)).slice(0,n);
    const params = ['face_rate','shoulders_rate','waist_rate','hips_rate','figure_rate'];
    const distribution = {};
    params.forEach(p => {
      const bkts=[0,0,0,0,0];
      all.forEach(m=>{ const v=m[p]||0; if(v<2)bkts[0]++; else if(v<4)bkts[1]++; else if(v<6)bkts[2]++; else if(v<8)bkts[3]++; else bkts[4]++; });
      distribution[p]=bkts;
    });
    const ob=[0,0,0,0,0];
    all.forEach(m=>{ const v=m.overall||0; if(v<20)ob[0]++; else if(v<40)ob[1]++; else if(v<60)ob[2]++; else if(v<80)ob[3]++; else ob[4]++; });
    const countries={}, tagCounts={};
    all.forEach(m=>{ if(m.country) countries[m.country]=(countries[m.country]||0)+1; });
    all.forEach(m=>(m.tags||[]).forEach(t=>{ tagCounts[t]=(tagCounts[t]||0)+1; }));
    return {
      total:all.length, active:all.filter(m=>!m.date_of_death).length,
      deceased:all.filter(m=>m.date_of_death).length, favorites:all.filter(m=>m.is_favorite).length,
      avgOverall:avg('overall'), avgPotential:avg('potential'),
      totalDrops:all.reduce((s,m)=>s+(m.drops||0),0),
      paramAvg:{ face:avg('face_rate'),shoulders:avg('shoulders_rate'),waist:avg('waist_rate'),hips:avg('hips_rate'),figure:avg('figure_rate') },
      distribution, overallBuckets:ob,
      topOverall:top('overall'), topPotential:top('potential'), topDrops:top('drops'),
      topFace:top('face_rate',5), topHips:top('hips_rate',5), topWaist:top('waist_rate',5),
      topShoulders:top('shoulders_rate',5), topFigure:top('figure_rate',5),
      countries, tagCounts, all,
    };
  }
};

// ── DataIO ────────────────────────────────────────────────────────
const DataIO = {
  async exportAll() {
    const [models,tags,banRecords,weights] = await Promise.all([
      db.models.toArray(),db.tags.toArray(),db.banRecords.toArray(),Settings.get()
    ]);
    return JSON.stringify({version:5,exportedAt:Date.now(),models,tags,banRecords,weights},null,2);
  },
  async importAll(jsonStr) {
    const data = JSON.parse(jsonStr);
    if (!data.models) throw new Error('Invalid backup format');
    await db.transaction('rw',db.models,db.tags,db.banRecords,db.settings,async()=>{
      await db.models.clear(); await db.tags.clear(); await db.banRecords.clear();
      if (data.tags?.length)       await db.tags.bulkAdd(data.tags);
      if (data.models?.length)     await db.models.bulkAdd(data.models);
      if (data.banRecords?.length) await db.banRecords.bulkAdd(data.banRecords);
      if (data.weights)            await db.settings.put({key:'weights',value:data.weights});
    });
    Settings.invalidate();
    await db.syncMeta.put({key:'lastPullAt',value:'1970-01-01T00:00:00.000Z'});
  }
};

// ── Seed ─────────────────────────────────────────────────────────
// async function seedDemoData() {
//   if (await db.models.count()>0) return;
//   const t1=await Tags.add({icon:'🌹',name:'Классика',weight:1.05});
//   const t2=await Tags.add({icon:'✨',name:'Топ',weight:1.1});
//   const t3=await Tags.add({icon:'🎭',name:'Актриса',weight:1.0});
//   await Models.add({name:'Aurora Voss',aliases:'Aurora V, A.Voss',country:'🇩🇪 Германия',date_of_birth:'1998-03-15',height:172,weight:55,shoulder_size:38,main_photo:'',body_part_photos:{},extra_photos:[],links:[],tags:[t1,t2],is_favorite:true,drops:12,face_rate:9.5,shoulders_rate:7.5,waist_rate:10,hips_rate:9.5,figure_rate:10});
//   await Models.add({name:'Stella Blanc',aliases:'S.Blanc',country:'🇫🇷 Франция',date_of_birth:'2001-07-22',height:168,weight:52,shoulder_size:36,main_photo:'',body_part_photos:{},extra_photos:[],links:[],tags:[t2,t3],is_favorite:false,drops:5,face_rate:9.5,shoulders_rate:7.5,waist_rate:5,hips_rate:7.5,figure_rate:10});
//   await Models.add({name:'Nadia Cruz',aliases:'',country:'🇧🇷 Бразилия',date_of_birth:'1995-11-08',height:175,weight:60,shoulder_size:40,main_photo:'',body_part_photos:{},extra_photos:[],links:[],tags:[t1],is_favorite:false,drops:8,face_rate:7.5,shoulders_rate:7.5,waist_rate:5,hips_rate:10,figure_rate:10});
// }
