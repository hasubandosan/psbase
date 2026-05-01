// sync/strategy.js — PSBase SyncManager v2
// Зависит от: db.js, supabase-client.js

const TABLE_MAP = {
  models:     'models',
  tags:       'tags',
  banRecords: 'ban_records',
};

// ── local → remote ────────────────────────────────────────────────
function toRemote(table, local, userId) {
  const base = { user_id: userId, updated_at: new Date(local._local_updated || Date.now()).toISOString() };

  if (table === 'models') return {
    ...base,
    // id включается только если remote_id известен — иначе Postgres генерирует сам
    ...(local.remote_id ? { id: local.remote_id } : {}),
    local_id:         String(local.id),
    name:             local.name,
    aliases:          local.aliases        || null,
    country:          local.country        || null,
    date_of_birth:    local.date_of_birth  || null,
    date_of_death:    local.date_of_death  || null,
    height:           local.height         || null,
    weight:           local.weight         || null,
    shoulder_size:    local.shoulder_size  || null,
    face_rate:        local.face_rate      || null,
    shoulders_rate:   local.shoulders_rate || null,
    waist_rate:       local.waist_rate     || null,
    hips_rate:        local.hips_rate      || null,
    figure_rate:      local.figure_rate    || null,
    overall:          local.overall        || null,
    potential:        local.potential      || null,
    drops:            local.drops          || 0,
    is_favorite:      local.is_favorite    || false,
    tags:             JSON.stringify(local.tags             || []),
    links:            JSON.stringify(local.links            || []),
    main_photo:       local.main_photo     || null,
    body_part_photos: JSON.stringify(local.body_part_photos || {}),
    extra_photos:     JSON.stringify(local.extra_photos     || []),
    created_at:       local.date_added
      ? new Date(local.date_added).toISOString()
      : new Date().toISOString(),
  };

  if (table === 'tags') return {
    ...base,
    ...(local.remote_id ? { id: local.remote_id } : {}),
    local_id: String(local.id),
    icon:     local.icon   || '🏷️',
    name:     local.name,
    weight:   local.weight || 1.0,
  };

  if (table === 'banRecords') return {
    ...base,
    ...(local.remote_id ? { id: local.remote_id } : {}),
    local_id:    String(local.id),
    name:        local.name,
    reason:      local.reason      || null,
    description: local.description || null,
    created_at:  local.date_added
      ? new Date(local.date_added).toISOString()
      : new Date().toISOString(),
  };

  return { ...base, ...local };
}

// ── remote → local ────────────────────────────────────────────────
function toLocal(table, remote) {
  const jp = (v, fb) => {
    if (v == null) return fb;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return fb; }
  };

  if (table === 'models') return {
    remote_id:        remote.id,
    name:             remote.name,
    aliases:          remote.aliases        || '',
    country:          remote.country        || '',
    date_of_birth:    remote.date_of_birth  || null,
    date_of_death:    remote.date_of_death  || null,
    height:           remote.height         || null,
    weight:           remote.weight         || null,
    shoulder_size:    remote.shoulder_size  || null,
    face_rate:        remote.face_rate      || 0,
    shoulders_rate:   remote.shoulders_rate || 0,
    waist_rate:       remote.waist_rate     || 0,
    hips_rate:        remote.hips_rate      || 0,
    figure_rate:      remote.figure_rate    || 0,
    overall:          remote.overall        || 0,
    potential:        remote.potential      || 0,
    drops:            remote.drops          || 0,
    is_favorite:      remote.is_favorite    || false,
    tags:             jp(remote.tags,             []),
    links:            jp(remote.links,            []),
    main_photo:       remote.main_photo     || '',
    body_part_photos: jp(remote.body_part_photos, {}),
    extra_photos:     jp(remote.extra_photos,     []),
    date_added:       remote.created_at ? new Date(remote.created_at).getTime() : Date.now(),
    _remote_updated:  remote.updated_at,
    _local_updated:   remote.updated_at ? new Date(remote.updated_at).getTime() : Date.now(),
  };

  if (table === 'tags') return {
    remote_id: remote.id,
    icon:      remote.icon   || '🏷️',
    name:      remote.name,
    weight:    remote.weight || 1.0,
    _local_updated: remote.updated_at ? new Date(remote.updated_at).getTime() : Date.now(),
  };

  if (table === 'banRecords') return {
    remote_id:   remote.id,
    name:        remote.name,
    reason:      remote.reason      || '',
    description: remote.description || '',
    date_added:  remote.created_at ? new Date(remote.created_at).getTime() : Date.now(),
    _local_updated: remote.updated_at ? new Date(remote.updated_at).getTime() : Date.now(),
  };

  return remote;
}

// ── SyncManager ───────────────────────────────────────────────────
const SyncManager = {
  _flushing:         false,
  _userId:           null,
  _listenersStarted: false,

  async userId() {
    if (this._userId) return this._userId;
    const user = await Auth.current();
    this._userId = user?.id || null;
    return this._userId;
  },

  // Добавить операцию в очередь — с дедупликацией
  // Если для той же записи уже есть upsert в очереди — обновляем, не дублируем
  async enqueue(table, operation, recordId, payload = null) {
    const rid = String(recordId);

    if (operation === 'upsert') {
      // Ищем существующую запись в очереди для этой же строки
      const existing = await db.syncQueue
        .where('[table+operation+recordId]')
        .equals([table, 'upsert', rid])
        .first()
        .catch(() => null);

      if (existing) {
        // Обновляем timestamp — запись переместится в конец при следующем flush
        await db.syncQueue.update(existing.id, { createdAt: Date.now(), retries: 0 });
        return;
      }
    }

    if (operation === 'delete') {
      // При удалении — убираем все pending upsert для этой записи (они уже не нужны)
      await db.syncQueue
        .where('[table+operation+recordId]')
        .equals([table, 'upsert', rid])
        .delete()
        .catch(() => {});
    }

    await db.syncQueue.add({
      table,
      operation,
      recordId:  rid,
      payload:   payload ? JSON.stringify(payload) : null,
      createdAt: Date.now(),
      retries:   0,
    });
  },

  // ── Push ───────────────────────────────────────────────────────
  async flush() {
    if (this._flushing) return;
    const userId = await this.userId();
    if (!userId) return;

    this._flushing = true;
    const sb = getSupabase();

    try {
      const queue = await db.syncQueue.orderBy('createdAt').toArray();
      for (const op of queue) {
        try {
          await this._exec(sb, userId, op);
          await db.syncQueue.delete(op.id);
        } catch (e) {
          console.warn(`SyncOp failed [${op.table}/${op.operation}]:`, e.message);
          if ((op.retries || 0) >= 5) {
            await db.syncQueue.delete(op.id);
          } else {
            await db.syncQueue.update(op.id, { retries: (op.retries || 0) + 1 });
          }
        }
      }
    } finally {
      this._flushing = false;
    }
  },

  async _exec(sb, userId, op) {
    const remoteTbl = TABLE_MAP[op.table] || op.table;

    if (op.operation === 'delete') {
      const localId = parseInt(op.recordId);
      const local   = await db[op.table]?.get(localId);
      if (local?.remote_id) {
        const { error } = await sb.from(remoteTbl).delete().eq('id', local.remote_id);
        if (error) throw error;
      }
      return;
    }

    // upsert
    let record = op.payload ? (() => { try { return JSON.parse(op.payload); } catch { return null; } })() : null;
    if (!record) {
      record = await db[op.table]?.get(parseInt(op.recordId));
    }
    if (!record) return;

    const row = toRemote(op.table, record, userId);

    if (op.table === 'settings') {
      const { error } = await sb.from('settings').upsert(
        { user_id: userId, weights: JSON.stringify(record.value || {}), updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      );
      if (error) throw error;
      return;
    }

    let data, error;

    // Всегда делаем upsert по local_id+user_id, чтобы не зависеть от устаревшего remote_id
    const { id: _rid, ...rowWithoutId } = row; // убираем id=undefined из объекта
    ({ data, error } = await sb
      .from(remoteTbl)
      .upsert(rowWithoutId, { onConflict: 'local_id,user_id', ignoreDuplicates: false })
      .select('id')
      .single());

    if (error) throw error;
    if (data?.id) {
      // Сохраняем полученный remote_id, даже если он уже был
      await db[op.table]?.update(parseInt(op.recordId), { remote_id: data.id });
    }
  },

  // ── Pull ───────────────────────────────────────────────────────
  async pull() {
    const userId = await this.userId();
    if (!userId) return 0;

    const sb       = getSupabase();
    const meta     = await db.syncMeta.get('lastPullAt');
    const lastPull = meta?.value || '1970-01-01T00:00:00.000Z';
    let merged     = 0;

    for (const [localTbl, remoteTbl] of Object.entries(TABLE_MAP)) {
      try {
        const { data, error } = await sb
          .from(remoteTbl)
          .select('*')
          .eq('user_id', userId)
          .gt('updated_at', lastPull);

        if (error) throw error;
        if (!data?.length) continue;

        for (const row of data) {
          const localObj  = toLocal(localTbl, row);
          const existing  = await db[localTbl].where('remote_id').equals(row.id).first().catch(() => null);

          if (existing) {
            // Conflict resolution: compare remote updated_at with local _local_updated
            const remoteTs = new Date(row.updated_at).getTime();
            const localTs  = existing._local_updated || existing.date_added || 0;
            if (remoteTs > localTs) {
              await db[localTbl].update(existing.id, { ...localObj, id: existing.id });
            }
          } else {
            await db[localTbl].add(localObj);
          }
          merged++;
        }

        // Синхронизация удалений: если запись есть локально но отсутствует на сервере после полного pull
        // — обрабатывается через firstSync флаг (будет добавлено позже)
      } catch (e) {
        console.warn(`Pull failed [${localTbl}]:`, e.message);
      }
    }

    // Settings pull
    try {
      const { data } = await sb.from('settings').select('weights').eq('user_id', userId).maybeSingle();
      if (data?.weights) {
        const parsed = typeof data.weights === 'object' ? data.weights : JSON.parse(data.weights);
        await db.settings.put({ key: 'weights', value: parsed });
        Settings.invalidate();
      }
    } catch {}

    await db.syncMeta.put({ key: 'lastPullAt', value: new Date().toISOString() });
    return merged;
  },

  // ── Full sync ─────────────────────────────────────────────────
  async sync() {
    if (!navigator.onLine) return { offline: true };
    try {
      const pulled = await this.pull();
      await this.flush();
      return { pulled, ok: true };
    } catch (e) {
      console.error('Sync error:', e);
      return { error: e.message };
    }
  },

  // ── Pending count for UI indicator ───────────────────────────
  async pendingCount() {
    return db.syncQueue.count();
  },

  // ── Status for Settings UI ───────────────────────────────────
  async getStatus() {
    const pending = await db.syncQueue.count();
    const meta    = await db.syncMeta.get('lastPullAt').catch(() => null);
    return { pending, lastSync: meta?.value || null, isOnline: navigator.onLine, isAuthed: !!(await this.userId()) };
  },

    // ── Auto-listeners ────────────────────────────────────────────
  startListeners() {
    if (this._listenersStarted) return;
    this._listenersStarted = true;
    window.addEventListener('online', async () => {
      toast('Соединение восстановлено, синхронизируем...', 'info', 2000);
      const result = await this.sync();
      if (result.pulled > 0) {
        toast(`Получено ${result.pulled} обновлений`, 'success', 2500);
        if (State.view === 'home') reloadGrid();
      }
      updateSyncIndicator();
    });
    window.addEventListener('offline', () => {
      toast('Нет соединения — работаем офлайн', 'info', 2000);
      updateSyncIndicator();
    });
  },
};