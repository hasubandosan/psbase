// sync/strategy.js — PSBase SyncManager v3
// Зависит от: db.js, supabase-client.js
//
// Новое в v3:
//   • Soft delete — удаление ставит deleted_at вместо физического удаления
//   • Restore — сброс deleted_at восстанавливает запись
//   • GC (garbage collection) — физически удаляет записи старше SOFT_DELETE_TTL_DAYS
//   • Realtime — Supabase channel подписка для мгновенной синхронизации между устройствами
//
// Требования к схеме Supabase (добавить если нет):
//   ALTER TABLE models      ADD COLUMN IF NOT EXISTS deleted_at timestamptz DEFAULT NULL;
//   ALTER TABLE tags        ADD COLUMN IF NOT EXISTS deleted_at timestamptz DEFAULT NULL;
//   ALTER TABLE ban_records ADD COLUMN IF NOT EXISTS deleted_at timestamptz DEFAULT NULL;
//   CREATE INDEX IF NOT EXISTS idx_models_deleted      ON models(user_id, deleted_at);
//   CREATE INDEX IF NOT EXISTS idx_tags_deleted        ON tags(user_id, deleted_at);
//   CREATE INDEX IF NOT EXISTS idx_ban_records_deleted ON ban_records(user_id, deleted_at);

const TABLE_MAP = {
  models:     'models',
  tags:       'tags',
  banRecords: 'ban_records',
};

// Записи мягко удалённые дольше этого числа дней — удаляются физически при GC
const SOFT_DELETE_TTL_DAYS = 30;

// ── local → remote ────────────────────────────────────────────────
function toRemote(table, local, userId) {
  const base = {
    user_id:    userId,
    updated_at: new Date(local._local_updated || Date.now()).toISOString(),
    // Передаём deleted_at на сервер — null означает "живая запись"
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

// ── remote → local ────────────────────────────────────────────────
// existing — текущая локальная запись (если есть), нужна чтобы не затирать _local_updated
function toLocal(table, remote, existing = null) {
  const jp = (v, fb) => {
    if (v == null) return fb;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return fb; }
  };

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

// ── SyncManager ───────────────────────────────────────────────────
const SyncManager = {
  _flushing:         false,
  _syncing:          false,
  _userId:           null,
  _listenersStarted: false,
  _realtimeChannel:  null,

  async userId() {
    if (this._userId) return this._userId;
    const user = await Auth.current();
    this._userId = user?.id || null;
    return this._userId;
  },

  // ── Soft delete ────────────────────────────────────────────────
  // Помечает запись как удалённую — физически не удаляет.
  // UI должен фильтровать: db.models.filter(r => !r._deleted_at).toArray()
  async softDelete(table, recordId) {
    const rid       = parseInt(recordId);
    const deletedAt = new Date().toISOString();

    await db[table]?.update(rid, {
      _deleted_at:    deletedAt,
      _local_updated: Date.now(),
    });

    // Soft delete идёт как upsert — просто обновляем поле deleted_at
    await this.enqueue(table, 'upsert', recordId);
  },

  // ── Restore ───────────────────────────────────────────────────
  // Сбрасывает deleted_at — запись снова живая и появится в UI
  async restore(table, recordId) {
    const rid = parseInt(recordId);

    await db[table]?.update(rid, {
      _deleted_at:    null,
      _local_updated: Date.now(),
    });

    await this.enqueue(table, 'upsert', recordId);
  },

  // ── Garbage Collection ─────────────────────────────────────────
  // Физически удаляет soft-deleted записи старше SOFT_DELETE_TTL_DAYS дней.
  // Вызывать при старте приложения или раз в сутки.
  // На сервере можно дополнительно настроить Supabase scheduled function.
  async gc() {
    const userId = await this.userId();
    if (!userId) return 0;

    const cutoffIso = new Date(Date.now() - SOFT_DELETE_TTL_DAYS * 86_400_000).toISOString();
    const cutoffMs  = new Date(cutoffIso).getTime();
    const sb        = getSupabase();
    let   purged    = 0;

    for (const [localTbl, remoteTbl] of Object.entries(TABLE_MAP)) {
      try {
        // Удаляем физически на сервере записи старше TTL
        const { error } = await sb
          .from(remoteTbl)
          .delete()
          .eq('user_id', userId)
          .not('deleted_at', 'is', null)
          .lt('deleted_at', cutoffIso);

        if (error) {
          console.warn(`[GC] Remote failed [${localTbl}]:`, error.message);
          continue;
        }

        // Удаляем физически локально
        const stale = await db[localTbl]
          .filter(r => r._deleted_at != null && new Date(r._deleted_at).getTime() < cutoffMs)
          .toArray()
          .catch(() => []);

        for (const r of stale) {
          await db[localTbl].delete(r.id).catch(() => {});
          purged++;
        }
      } catch (e) {
        console.warn(`[GC] Failed [${localTbl}]:`, e.message);
      }
    }

    console.log(`[GC] Purged ${purged} records older than ${SOFT_DELETE_TTL_DAYS} days`);
    return purged;
  },

  // ── Enqueue ────────────────────────────────────────────────────
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
          table,
          operation,
          recordId:  rid,
          payload:   payload ? JSON.stringify(payload) : existing.payload,
          createdAt: Date.now(),
          retries:   0,
        });
        return;
      }
    }

    if (operation === 'delete') {
      await db.syncQueue
        .where('[table+operation+recordId]')
        .equals([table, 'upsert', rid])
        .delete()
        .catch(() => {});

      if (!payload) {
        const localRecord = await db[table]?.get(parseInt(rid)).catch(() => null);
        if (localRecord?.remote_id) {
          payload = { remote_id: localRecord.remote_id };
        }
      }
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
          await db.syncQueue.delete(op.id).catch(() => {});
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
      // Hard delete — используется только напрямую (GC), UI работает через softDelete
      let remoteId = null;
      if (op.payload) {
        try { remoteId = JSON.parse(op.payload)?.remote_id ?? null; } catch {}
      }
      if (!remoteId) {
        const local = await db[op.table]?.get(parseInt(op.recordId));
        if (local?.remote_id) remoteId = local.remote_id;
      }
      if (!remoteId) {
        const { data } = await sb
          .from(remoteTbl)
          .select('id')
          .eq('user_id', userId)
          .eq('local_id', String(op.recordId))
          .maybeSingle();
        remoteId = data?.id ?? null;
      }
      if (remoteId) {
        const { error } = await sb.from(remoteTbl).delete().eq('id', remoteId);
        if (error) throw error;
      }
      return;
    }

    // upsert — включает soft delete (deleted_at передаётся через toRemote)
    let record = null;
    if (op.payload) {
      try { record = JSON.parse(op.payload); } catch { record = null; }
    }
    if (!record) {
      record = await db[op.table]?.get(parseInt(op.recordId));
      if (!record) {
        console.warn(`SyncManager._exec: record ${op.table}#${op.recordId} not found, skipping`);
        return;
      }
    }

    if (op.table === 'settings') {
      const { error } = await sb.from('settings').upsert(
        { user_id: userId, weights: JSON.stringify(record.value || {}), updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      );
      if (error) throw error;
      return;
    }

    const row = toRemote(op.table, record, userId);
    const { id: _rid, ...rowWithoutId } = row;

    const { data, error } = await sb
      .from(remoteTbl)
      .upsert(rowWithoutId, { onConflict: 'local_id,user_id', ignoreDuplicates: false })
      .select('id')
      .single();

    if (error) throw error;
    if (data?.id) {
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
        // Тянем все записи включая soft-deleted — удаление с другого устройства
        // должно синхронизироваться сюда через deleted_at
        const { data, error } = await sb
          .from(remoteTbl)
          .select('*')
          .eq('user_id', userId)
          .gt('updated_at', lastPull);

        if (error) throw error;
        if (!data?.length) continue;

        for (const row of data) {
          let existing = await db[localTbl].where('remote_id').equals(row.id).first().catch(() => null);

          if (!existing && row.local_id) {
            const localNumId = parseInt(row.local_id);
            if (!isNaN(localNumId)) {
              existing = await db[localTbl].get(localNumId);
              if (existing) {
                await db[localTbl].update(existing.id, { remote_id: row.id });
              }
            }
          }

          const localObj = toLocal(localTbl, row, existing);

          if (existing) {
            const remoteTs = new Date(row.updated_at).getTime();
            const localTs  = existing._local_updated || existing.date_added || 0;

            if (remoteTs > localTs) {
              const pendingOp = await db.syncQueue
                .where('[table+operation+recordId]')
                .equals([localTbl, 'upsert', String(existing.id)])
                .first()
                .catch(() => null);

              if (!pendingOp) {
                await db[localTbl].update(existing.id, { ...localObj, id: existing.id });
                merged++;
              }
            }
          } else {
            // Новая запись — добавляем даже если soft-deleted
            // (UI не покажет — фильтрует по _deleted_at)
            await db[localTbl].add(localObj);
            merged++;
          }
        }

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

  // ── Realtime ──────────────────────────────────────────────────
  // Supabase Realtime — мгновенная синхронизация между устройствами без polling.
  // Дополняет pull/flush для online-режима. При оффлайне — отключается автоматически.
  async startRealtime() {
    const userId = await this.userId();
    if (!userId || this._realtimeChannel) return;

    const sb = getSupabase();

    this._realtimeChannel = sb
      .channel(`psbase_sync_${userId}`)
      .on('postgres_changes', {
        event:  '*',
        schema: 'public',
        filter: `user_id=eq.${userId}`,
      }, (payload) => this._handleRealtimeEvent(payload))
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log('[Realtime] Connected');
        } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
          console.warn('[Realtime] Disconnected');
          this._realtimeChannel = null;
        }
      });
  },

  stopRealtime() {
    if (!this._realtimeChannel) return;
    getSupabase().removeChannel(this._realtimeChannel);
    this._realtimeChannel = null;
    console.log('[Realtime] Stopped');
  },

  async _handleRealtimeEvent(payload) {
    const { eventType, table: remoteTbl, new: newRow, old: oldRow } = payload;

    const localTbl = Object.keys(TABLE_MAP).find(k => TABLE_MAP[k] === remoteTbl);
    if (!localTbl) return;

    try {
      if (eventType === 'DELETE') {
        // Hard delete с другого устройства
        if (oldRow?.id) {
          const existing = await db[localTbl].where('remote_id').equals(oldRow.id).first().catch(() => null);
          if (existing) {
            await db[localTbl].delete(existing.id);
            this._notifyUIChange(localTbl, 'delete', existing.id);
          }
        }
        return;
      }

      if (!newRow) return;

      const existing = await db[localTbl].where('remote_id').equals(newRow.id).first().catch(() => null);
      const localObj = toLocal(localTbl, newRow, existing);

      if (existing) {
        const remoteTs = new Date(newRow.updated_at).getTime();
        const localTs  = existing._local_updated || 0;
        if (remoteTs <= localTs) return; // наши данные новее

        const pendingOp = await db.syncQueue
          .where('[table+operation+recordId]')
          .equals([localTbl, 'upsert', String(existing.id)])
          .first()
          .catch(() => null);

        if (!pendingOp) {
          await db[localTbl].update(existing.id, { ...localObj, id: existing.id });
          this._notifyUIChange(localTbl, 'update', existing.id);
        }
      } else {
        const newId = await db[localTbl].add(localObj);
        this._notifyUIChange(localTbl, 'insert', newId);
      }
    } catch (e) {
      console.warn('[Realtime] Failed to apply event:', e.message);
    }
  },

  // Диспатчит кастомное событие — UI слушает через window.addEventListener('sync:change', ...)
  _notifyUIChange(table, eventType, recordId) {
    window.dispatchEvent(new CustomEvent('sync:change', {
      detail: { table, eventType, recordId }
    }));
    if (table === 'models' && typeof reloadGrid === 'function') {
      if (State?.view === 'home') reloadGrid();
    }
  },

  // ── Full sync ─────────────────────────────────────────────────
  async sync() {
    if (this._syncing) return { skipped: true };
    if (!navigator.onLine) return { offline: true };
    this._syncing = true;
    try {
      const pulled = await this.pull();
      await this.flush();
      return { pulled, ok: true };
    } catch (e) {
      console.error('Sync error:', e);
      return { error: e.message };
    } finally {
      this._syncing = false;
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
    return {
      pending,
      lastSync:   meta?.value || null,
      isOnline:   navigator.onLine,
      isAuthed:   !!(await this.userId()),
      isRealtime: !!this._realtimeChannel,
    };
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
        if (State?.view === 'home') reloadGrid();
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
