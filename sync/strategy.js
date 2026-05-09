// sync/strategy.js — PSBase SyncManager v5 (переписан с нуля)
// Зависит от: db.js, supabase-client.js
//
// Ключевые принципы:
//   1. Единственный источник истины — Supabase. IndexedDB — только кэш.
//   2. Удаление = soft delete (deleted_at). Физически никогда не удаляем локально до подтверждения сервера.
//   3. Все операции идут через очередь. Никаких прямых вызовов Supabase из UI.
//   4. Pull тянет ВСЁ включая deleted_at — так удаление синхронизируется между устройствами.
//   5. remote_id всегда записывается после первого успешного upsert.
//
// Изменения в db.js — добавить v8:
//   db.version(8).stores({
//     models:     '++id, name, country, is_favorite, drops, overall, potential, date_added, remote_id, _deleted_at',
//     tags:       '++id, name, remote_id, _deleted_at',
//     banRecords: '++id, name, reason, date_added, remote_id, _deleted_at',
//     settings:   'key',
//     syncQueue:  '++id, [table+operation+recordId], createdAt',
//     syncMeta:   'key',
//     castingQueue: '++id, status, createdAt',
//   });
//
// Изменения в Supabase — добавить колонку если нет:
//   ALTER TABLE models      ADD COLUMN IF NOT EXISTS deleted_at timestamptz DEFAULT NULL;
//   ALTER TABLE tags        ADD COLUMN IF NOT EXISTS deleted_at timestamptz DEFAULT NULL;
//   ALTER TABLE ban_records ADD COLUMN IF NOT EXISTS deleted_at timestamptz DEFAULT NULL;
//   CREATE INDEX IF NOT EXISTS idx_models_deleted      ON models(user_id, deleted_at);
//   CREATE INDEX IF NOT EXISTS idx_tags_deleted        ON tags(user_id, deleted_at);
//   CREATE INDEX IF NOT EXISTS idx_ban_records_deleted ON ban_records(user_id, deleted_at);
//
// Изменения в db.js — Models.delete():
//   БЫЛО:   await db.models.delete(id); enqueue('delete')
//   СТАЛО:  await Models.softDelete(id)  ← новый метод ниже
//
// Изменения в db.js — Models.getAll() и search():
//   Добавить фильтр: .filter(m => !m._deleted_at)

const TABLE_MAP = {
  models:     'models',
  tags:       'tags',
  banRecords: 'ban_records',
};

// GC: записи помеченные deleted_at старше этого числа дней удаляются физически
const GC_TTL_DAYS = 30;

// ─────────────────────────────────────────────────────────────────
// Маппинг: local → remote
// ─────────────────────────────────────────────────────────────────
function toRemote(table, local, userId) {
  const base = {
    user_id:    userId,
    updated_at: new Date(local._local_updated || Date.now()).toISOString(),
    deleted_at: local._deleted_at || null,
  };

  if (table === 'models') return {
    ...base,
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

// ─────────────────────────────────────────────────────────────────
// Маппинг: remote → local
// existing передаётся чтобы сохранить _local_updated пользователя
// ─────────────────────────────────────────────────────────────────
function toLocal(table, remote, existing = null) {
  const jp = (v, fb) => {
    if (v == null) return fb;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return fb; }
  };

  // ВАЖНО: _local_updated не перезаписываем серверным временем.
  // Иначе при следующем pull локальные изменения будут казаться "старее" серверных.
  const remoteTs     = remote.updated_at ? new Date(remote.updated_at).getTime() : Date.now();
  const localUpdated = existing?._local_updated || remoteTs;

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
    _local_updated:   localUpdated,
    _deleted_at:      remote.deleted_at || null,
  };

  if (table === 'tags') return {
    remote_id:       remote.id,
    icon:            remote.icon   || '🏷️',
    name:            remote.name,
    weight:          remote.weight || 1.0,
    _remote_updated: remote.updated_at,
    _local_updated:  localUpdated,
    _deleted_at:     remote.deleted_at || null,
  };

  if (table === 'banRecords') return {
    remote_id:       remote.id,
    name:            remote.name,
    reason:          remote.reason      || '',
    description:     remote.description || '',
    date_added:      remote.created_at ? new Date(remote.created_at).getTime() : Date.now(),
    _remote_updated: remote.updated_at,
    _local_updated:  localUpdated,
    _deleted_at:     remote.deleted_at || null,
  };

  return remote;
}

// ─────────────────────────────────────────────────────────────────
// SyncManager
// ─────────────────────────────────────────────────────────────────
const SyncManager = {
  _flushing:         false,
  _syncing:          false,
  _userId:           null,
  _listenersStarted: false,
  _realtimeChannel:  null,

  // ── Auth ────────────────────────────────────────────────────────
  async userId() {
    if (this._userId) return this._userId;
    const user = await Auth.current();
    this._userId = user?.id || null;
    return this._userId;
  },

  // ── Soft Delete ─────────────────────────────────────────────────
  // Вызывается вместо физического удаления из Models.delete(), Tags.delete(), BanRecords.delete().
  // Помечает запись локально → ставит upsert в очередь → сервер получает deleted_at → другие устройства тянут через pull.
  // UI фильтрует записи с _deleted_at !== null.
  async softDelete(table, recordId) {
    const rid       = parseInt(recordId);
    const deletedAt = new Date().toISOString();

    await db[table]?.update(rid, {
      _deleted_at:    deletedAt,
      _local_updated: Date.now(),
    });

    await this.enqueue(table, 'upsert', recordId);
    if (navigator.onLine) this.flush();
  },

  // ── Restore ─────────────────────────────────────────────────────
  async restore(table, recordId) {
    await db[table]?.update(parseInt(recordId), {
      _deleted_at:    null,
      _local_updated: Date.now(),
    });
    await this.enqueue(table, 'upsert', recordId);
    if (navigator.onLine) this.flush();
  },

  // ── Enqueue ─────────────────────────────────────────────────────
  // Дедупликация: если upsert для той же записи уже в очереди — удаляем и добавляем заново
  // (новый payload + новый timestamp = честный конец очереди)
  async enqueue(table, operation, recordId, payload = null) {
    const rid = String(recordId);

    if (operation === 'upsert') {
      const existing = await db.syncQueue
        .where('[table+operation+recordId]')
        .equals([table, 'upsert', rid])
        .first()
        .catch(() => null);

      if (existing) {
        await db.syncQueue.delete(existing.id).catch(() => {});
        await db.syncQueue.add({
          table, operation, recordId: rid,
          payload:   payload ? JSON.stringify(payload) : existing.payload,
          createdAt: Date.now(), retries: 0,
        });
        return;
      }
    }

    // При delete — убираем pending upsert (они уже не нужны) и сохраняем remote_id
    if (operation === 'delete') {
      await db.syncQueue
        .where('[table+operation+recordId]')
        .equals([table, 'upsert', rid])
        .delete().catch(() => {});

      // Сохраняем remote_id пока запись ещё в IndexedDB
      if (!payload) {
        const rec = await db[table]?.get(parseInt(rid)).catch(() => null);
        if (rec?.remote_id) payload = { remote_id: rec.remote_id };
      }
    }

    await db.syncQueue.add({
      table, operation, recordId: rid,
      payload:   payload ? JSON.stringify(payload) : null,
      createdAt: Date.now(), retries: 0,
    });
  },

  // ── Flush (Push) ────────────────────────────────────────────────
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
          await this._execOp(sb, userId, op);
          await db.syncQueue.delete(op.id).catch(() => {});
        } catch (e) {
          console.warn(`[Sync] Op failed [${op.table}/${op.operation}]:`, e.message);
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

  async _execOp(sb, userId, op) {
  const remoteTbl = TABLE_MAP[op.table] || op.table;

  let record = null;
  if (op.payload) {
    try { record = JSON.parse(op.payload); } catch {}
  }
  if (!record) {
    record = await db[op.table]?.get(parseInt(op.recordId)).catch(() => null);
  }
  if (!record) {
    console.warn(`[Sync] Record ${op.table}#${op.recordId} not found`);
    return;
  }

  // 🧠 1. Если есть remote_id — обновляем строго по нему
  if (record.remote_id) {
    const row = toRemote(op.table, record, userId);

    const { error } = await sb
      .from(remoteTbl)
      .update(row)
      .eq('id', record.remote_id)
      .eq('user_id', userId);

    if (error) throw error;
    return;
  }

  // 🧠 2. Если remote_id нет — ищем на сервере по local_id
  const { data: existing } = await sb
    .from(remoteTbl)
    .select('id')
    .eq('user_id', userId)
    .eq('local_id', String(op.recordId))
    .maybeSingle();

  if (existing?.id) {
    // 👉 нашли — сохраняем remote_id и обновляем
    await db[op.table].update(parseInt(op.recordId), {
      remote_id: existing.id
    });

    const row = toRemote(op.table, record, userId);

    const { error } = await sb
      .from(remoteTbl)
      .update(row)
      .eq('id', existing.id);

    if (error) throw error;
    return;
  }

  // 🧠 3. Если вообще нет — создаём новую запись
  const row = toRemote(op.table, record, userId);
  const { id: _, ...insertRow } = row;

  const { data, error } = await sb
    .from(remoteTbl)
    .insert(insertRow)
    .select('id')
    .single();

  if (error) throw error;

  if (data?.id) {
    await db[op.table].update(parseInt(op.recordId), {
      remote_id: data.id
    });
  }
},

  // ── Pull ────────────────────────────────────────────────────────
  // Тянет все изменения с сервера (включая deleted_at) начиная с lastPullAt.
  // Применяет только если серверная версия новее локальной И нет pending изменений.
 async pull(force = false) {
  const userId = await this.userId();
  if (!userId) return 0;

  const sb = getSupabase();
  let merged = 0;

  for (const [localTbl, remoteTbl] of Object.entries(TABLE_MAP)) {
    const { data, error } = await sb
      .from(remoteTbl)
      .select('*')
      .eq('user_id', userId);

    if (error) throw error;
    if (!data?.length) continue;

    for (const row of data) {
      let existing = null;

      // 🔎 1. ищем по remote_id
      if (row.id) {
        existing = await db[localTbl]
          .where('remote_id')
          .equals(row.id)
          .first();
      }

      // 🔎 2. fallback по local_id
      if (!existing && row.local_id) {
        existing = await db[localTbl]
          .where('id')
          .equals(parseInt(row.local_id))
          .first();
      }

      const local = toLocal(localTbl, row, existing);

      if (existing) {
        // 🔥 3. ПРОВЕРКА: есть ли локальные изменения (pending в очереди)
        const pending = await db.syncQueue
          .where('[table+operation+recordId]')
          .equals([localTbl, 'upsert', String(existing.id)])
          .first()
          .catch(() => null);

        if (pending) {
          // 👉 есть локальные изменения — НЕ трогаем запись
          continue;
        }

        // 🧠 4. сравнение времени (fallback защита)
        const remoteTs = row.updated_at
          ? new Date(row.updated_at).getTime()
          : 0;

        const localTs = existing._local_updated || 0;

        if (remoteTs >= localTs) {
          await db[localTbl].update(existing.id, local);
          merged++;
        }

      } else {
        // 🆕 новая запись
        await db[localTbl].add(local);
        merged++;
      }
    }
  }

  await db.syncMeta.put({
    key: 'lastPullAt',
    value: new Date().toISOString()
  });

  return merged;
},

  // ── GC ──────────────────────────────────────────────────────────
  // Физически удаляет soft-deleted записи старше GC_TTL_DAYS.
  // Вызывать при старте приложения раз в сутки.
  async gc() {
    const userId = await this.userId();
    if (!userId) return 0;

    const cutoffIso = new Date(Date.now() - GC_TTL_DAYS * 86_400_000).toISOString();
    const cutoffMs  = new Date(cutoffIso).getTime();
    const sb        = getSupabase();
    let   purged    = 0;

    for (const [localTbl, remoteTbl] of Object.entries(TABLE_MAP)) {
      try {
        // Физически удаляем на сервере
        await sb.from(remoteTbl).delete()
          .eq('user_id', userId)
          .not('deleted_at', 'is', null)
          .lt('deleted_at', cutoffIso);

        // Физически удаляем локально
        const stale = await db[localTbl]
          .filter(r => r._deleted_at != null && new Date(r._deleted_at).getTime() < cutoffMs)
          .toArray().catch(() => []);

        for (const r of stale) {
          await db[localTbl].delete(r.id).catch(() => {});
          purged++;
        }
      } catch (e) {
        console.warn(`[GC] Failed [${localTbl}]:`, e.message);
      }
    }

    if (purged > 0) console.log(`[GC] Purged ${purged} records older than ${GC_TTL_DAYS} days`);
    return purged;
  },

  // ── Realtime ────────────────────────────────────────────────────
  // Supabase Realtime — мгновенная синхронизация между устройствами.
  // Дополняет pull/flush, не заменяет.
  async startRealtime() {
    const userId = await this.userId();
    if (!userId || this._realtimeChannel) return;

    const sb = getSupabase();

    this._realtimeChannel = sb
      .channel(`psbase_${userId}`)
      .on('postgres_changes', {
        event: '*', schema: 'public',
        filter: `user_id=eq.${userId}`,
      }, (payload) => this._onRealtimeEvent(payload))
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log('[Realtime] Connected');
          updateSyncIndicator();
        } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
          console.warn('[Realtime] Disconnected');
          this._realtimeChannel = null;
          updateSyncIndicator();
        }
      });
  },

  stopRealtime() {
    if (!this._realtimeChannel) return;
    getSupabase().removeChannel(this._realtimeChannel);
    this._realtimeChannel = null;
  },

  async _onRealtimeEvent({ eventType, table: remoteTbl, new: newRow, old: oldRow }) {
    const localTbl = Object.keys(TABLE_MAP).find(k => TABLE_MAP[k] === remoteTbl);
    if (!localTbl) return;

    try {
      if (eventType === 'DELETE') {
        // Hard delete с сервера (редко, только через GC)
        if (oldRow?.id) {
          const rec = await db[localTbl].where('remote_id').equals(oldRow.id).first().catch(() => null);
          if (rec) await db[localTbl].delete(rec.id).catch(() => {});
        }
        this._notifyChange();
        return;
      }

      if (!newRow) return;

      const existing = await db[localTbl].where('remote_id').equals(newRow.id).first().catch(() => null);

      // Не трогаем если есть pending изменения
      if (existing) {
        const hasPending = await db.syncQueue
          .where('[table+operation+recordId]')
          .equals([localTbl, 'upsert', String(existing.id)])
          .first().catch(() => null);
        if (hasPending) return;

        const remoteTs = new Date(newRow.updated_at).getTime();
        const localTs  = existing._local_updated || 0;
        if (remoteTs <= localTs) return;

        const localObj = toLocal(localTbl, newRow, existing);
        await db[localTbl].update(existing.id, { ...localObj, id: existing.id });
      } else {
        const localObj = toLocal(localTbl, newRow, null);
        await db[localTbl].add(localObj).catch(() => {});
      }

      this._notifyChange(localTbl);
    } catch (e) {
      console.warn('[Realtime] Event error:', e.message);
    }
  },

  _notifyChange(table) {
    updateSyncIndicator();
    // Перезагружаем грид если нужно
    if (typeof reloadGrid === 'function' && State?.view === 'home') {
      reloadGrid();
    }
    window.dispatchEvent(new CustomEvent('sync:change', { detail: { table } }));
  },

  // ── Full sync ────────────────────────────────────────────────────
  async sync() {
    if (this._syncing)      return { skipped: true };
    if (!navigator.onLine) return { offline: true };

    this._syncing = true;
    try {
      const pulled = await this.pull();
      await this.flush();
      updateSyncIndicator();
      return { pulled, ok: true };
    } catch (e) {
      console.error('[Sync] Error:', e);
      return { error: e.message };
    } finally {
      this._syncing = false;
    }
  },

  // ── Status ──────────────────────────────────────────────────────
  async pendingCount() {
    return db.syncQueue.count().catch(() => 0);
  },

  async getStatus() {
    const pending = await db.syncQueue.count().catch(() => 0);
    const meta    = await db.syncMeta.get('lastPullAt').catch(() => null);
    return {
      pending,
      lastSync:   meta?.value || null,
      isOnline:   navigator.onLine,
      isAuthed:   !!(await this.userId()),
      isRealtime: !!this._realtimeChannel,
    };
  },

  // ── Listeners ────────────────────────────────────────────────────
  startListeners() {
    if (this._listenersStarted) return;
    this._listenersStarted = true;

    window.addEventListener('online', async () => {
      toast('Соединение восстановлено, синхронизируем...', 'info', 2000);
      const result = await this.sync();
      if (result.pulled > 0) {
        toast(`Получено ${result.pulled} обновлений`, 'success', 2500);
        if (typeof reloadGrid === 'function' && State?.view === 'home') reloadGrid();
      }
      await this.startRealtime();
      updateSyncIndicator();
    });

    window.addEventListener('offline', () => {
      toast('Нет соединения — работаем офлайн', 'info', 2000);
      this.stopRealtime();
      updateSyncIndicator();
    });
  },
};

window.SyncManager = SyncManager;
