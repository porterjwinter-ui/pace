// App state: one encrypted "vault" per user, cached locally and synced to the private GitHub repo.
import { encryptJSON, decryptJSON } from './crypto.js';
import { idb } from './idb.js';
import { DATA_ROOT } from './github.js';
import { planSchedule } from './scheduler.js';
import { dayKey } from './dates.js';

export const AVAILABILITY_PRESETS = {
  student: { name: 'After school', days: [[[600, 1200]], [[930, 1290]], [[930, 1290]], [[930, 1290]], [[930, 1290]], [[930, 1290]], [[600, 1200]]] },
  workday: { name: '9 to 5', days: [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []] },
  evenings: { name: 'Evenings and weekends', days: [[[600, 1080]], [[1080, 1320]], [[1080, 1320]], [[1080, 1320]], [[1080, 1320]], [[1080, 1320]], [[600, 1080]]] },
  anytime: { name: 'Any day, 8am to 10pm', days: Array.from({ length: 7 }, () => [[480, 1320]]) },
};

export const defaultSettings = () => ({
  updatedAt: 0,
  weekStartsOn: 0,
  clock: 'auto',
  theme: 'system',
  availability: structuredClone(AVAILABILITY_PRESETS.student.days),
  maxDailyMinutes: 360,
  minBlock: 30,
  maxBlock: 120,
  breakMinutes: 15,
  bufferHours: 24,
  defaultEstimate: 60,
  scrollHour: 8,
  aiKey: '',
  aiModel: '',
  corsProxy: '',
});

export const emptyVault = () => ({
  v: 1,
  settings: defaultSettings(),
  calendars: [{ id: 'personal', name: 'Personal', color: '#0E8A63', kind: 'personal', visible: true, blocksTime: true, updatedAt: 0 }],
  events: [],
  tasks: [],
  blocks: [],
  chats: {},
  tombstones: {},
  planAt: 0,
  planDay: '',
  planInfo: {},
  onboarded: false,
});

const COLLECTIONS = ['calendars', 'events', 'tasks'];
export const uid = (p = '') => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function mergeById(a = [], b = [], tomb) {
  const map = new Map();
  for (const item of [...a, ...b]) {
    const prev = map.get(item.id);
    if (!prev || (item.updatedAt || 0) > (prev.updatedAt || 0)) map.set(item.id, item);
  }
  return [...map.values()].filter((it) => !(tomb[it.id] >= (it.updatedAt || 0)));
}

const userTouched = (b) => b.status !== 'planned' || b.pinned;

/** Merge two copies of a vault. Pure; returns a new vault. */
export function mergeVaults(local, remote) {
  const tomb = { ...remote.tombstones };
  for (const [k, t] of Object.entries(local.tombstones || {})) tomb[k] = Math.max(t, tomb[k] || 0);
  const cutoff = Date.now() - 90 * 864e5;
  for (const k of Object.keys(tomb)) if (tomb[k] < cutoff) delete tomb[k];

  const out = { ...emptyVault(), ...local, tombstones: tomb };
  for (const c of COLLECTIONS) out[c] = mergeById(local[c], remote[c], tomb);

  const touched = mergeById(local.blocks.filter(userTouched), remote.blocks.filter(userTouched), tomb);
  const ids = new Set(touched.map((b) => b.id));
  const src = (local.planAt || 0) >= (remote.planAt || 0) ? local : remote;
  const planned = src.blocks.filter((b) => !userTouched(b) && !ids.has(b.id));
  out.blocks = [...touched, ...planned];
  out.planAt = src.planAt || 0;
  out.planDay = src.planDay || '';
  out.planInfo = src.planInfo || {};

  out.settings = (remote.settings?.updatedAt || 0) >= (local.settings?.updatedAt || 0) ? remote.settings : local.settings;
  out.settings = { ...defaultSettings(), ...out.settings };
  out.chats = { ...remote.chats };
  for (const [k, c] of Object.entries(local.chats || {})) {
    if (!out.chats[k] || (c.updatedAt || 0) >= (out.chats[k].updatedAt || 0)) out.chats[k] = c;
  }
  out.onboarded = !!(local.onboarded || remote.onboarded);
  return out;
}

// Order-independent serialization, so merges that only reorder items don't trigger a push.
const stable = (x) => JSON.stringify(x, (k, val) => (val && typeof val === 'object' && !Array.isArray(val)
  ? Object.fromEntries(Object.keys(val).sort().map((key) => [key, val[key]]))
  : val));
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const canon = (v) => stable({ ...v, ...Object.fromEntries([...COLLECTIONS, 'blocks'].map((c) => [c, [...(v[c] || [])].sort(byId)])) });

const fingerprint = (v) => JSON.stringify([v.calendars, v.events, v.tasks, v.settings.availability, v.settings.maxDailyMinutes, v.settings.minBlock, v.settings.maxBlock, v.settings.breakMinutes, v.settings.bufferHours]);

export class Store extends EventTarget {
  constructor(session) {
    super();
    this.session = session;
    this.v = emptyVault();
    this.rev = 0;
    this.pushedRev = 0;
    this.remoteSha = null;
    this.status = session.gh ? 'idle' : 'local';
    this.syncError = '';
    this.lastSync = 0;
    this.undoStack = [];
    this._pushTimer = null;
  }

  get ctx() { return `pace:vault:${this.session.userId}`; }
  get remotePath() { return `${DATA_ROOT}/users/${this.session.userId}/vault.enc`; }
  get localKey() { return `vault:${this.session.userId}`; }
  get dirty() { return this.rev > this.pushedRev; }

  emit(type = 'change', detail = {}) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  async load() {
    const rec = await idb.get(this.localKey);
    if (rec?.blob) {
      try {
        this.v = { ...emptyVault(), ...(await decryptJSON(this.session.dek, rec.blob, this.ctx)) };
        this.v.settings = { ...defaultSettings(), ...this.v.settings };
        this.rev = rec.rev || 0;
        this.pushedRev = rec.pushedRev || 0;
        this.remoteSha = rec.remoteSha || null;
        this.lastSync = rec.lastSync || 0;
      } catch (e) {
        console.warn('Local cache unreadable, starting from remote', e);
      }
    }
    if (this.session.gh) await this.sync();
    if (this.v.planDay !== dayKey(new Date())) this.replan({ quiet: true });
    this.emit();
  }

  async saveLocal() {
    const blob = await encryptJSON(this.session.dek, this.v, this.ctx);
    await idb.set(this.localKey, { blob, rev: this.rev, pushedRev: this.pushedRev, remoteSha: this.remoteSha, lastSync: this.lastSync, savedAt: Date.now() });
  }

  /** Save to this device right away, coalescing overlapping saves. */
  scheduleSave() {
    if (this._saving) { this._saveAgain = true; return this._saving; }
    this._saving = this.saveLocal().catch(console.error).finally(() => {
      this._saving = null;
      if (this._saveAgain) { this._saveAgain = false; this.scheduleSave(); }
    });
    return this._saving;
  }

  touch() {
    this.rev++;
    this.scheduleSave();
    if (this.session.gh) {
      clearTimeout(this._pushTimer);
      this._pushTimer = setTimeout(() => this.sync(), 2500);
    }
  }

  /**
   * Apply a change. `fn(vault)` mutates in place.
   * opts.replan (default true) re-runs the scheduler; opts.undo stores a snapshot first.
   */
  mutate(fn, { replan = true, undo = true, label = '' } = {}) {
    if (undo) {
      this.undoStack.push({ v: structuredClone(this.v), label });
      if (this.undoStack.length > 30) this.undoStack.shift();
    }
    const result = fn(this.v);
    if (replan) this.runPlanner();
    this.touch();
    this.emit();
    return result;
  }

  runPlanner() {
    const { blocks, info } = planSchedule(this.v);
    this.v.blocks = blocks;
    this.v.planInfo = info;
    this.v.planAt = Date.now();
    this.v.planDay = dayKey(new Date());
  }

  replan({ quiet = false } = {}) {
    this.mutate(() => {}, { replan: true, undo: !quiet, label: 'Replan' });
  }

  undo() {
    const snap = this.undoStack.pop();
    if (!snap) return null;
    const old = snap.v;
    const now = Date.now();
    for (const c of [...COLLECTIONS, 'blocks']) {
      const cur = new Map(this.v[c].map((x) => [x.id, x]));
      const prev = new Set(old[c].map((x) => x.id));
      for (const item of old[c]) {
        if (JSON.stringify(cur.get(item.id)) !== JSON.stringify(item)) { item.updatedAt = now; delete old.tombstones[item.id]; }
      }
      for (const item of this.v[c]) if (!prev.has(item.id)) old.tombstones[item.id] = now;
    }
    if (JSON.stringify(old.settings) !== JSON.stringify(this.v.settings)) old.settings.updatedAt = now;
    old.planAt = now;
    old.chats = this.v.chats; // conversations aren't part of undo
    old.onboarded = this.v.onboarded;
    this.v = old;
    this.touch();
    this.emit();
    return snap.label;
  }

  // ---- collection helpers (call inside mutate) ----
  static put(v, collection, item) {
    item.updatedAt = Date.now();
    const i = v[collection].findIndex((x) => x.id === item.id);
    if (i >= 0) v[collection][i] = item; else v[collection].push(item);
    delete v.tombstones[item.id];
    return item;
  }
  static drop(v, collection, id) {
    v[collection] = v[collection].filter((x) => x.id !== id);
    v.tombstones[id] = Date.now();
  }

  // ---- sync ----
  setStatus(status, error = '') {
    this.status = status;
    this.syncError = error;
    this.emit('sync');
  }

  async pullAndMerge() {
    const gh = this.session.gh;
    const remote = await gh.getFile(this.remotePath);
    if (!remote) return { exists: false };
    if (remote.sha === this.remoteSha) return { exists: true, changed: false };
    const rv = await decryptJSON(this.session.dek, remote.content, this.ctx);
    const before = fingerprint(this.v);
    const merged = mergeVaults(this.v, { ...emptyVault(), ...rv });
    const changed = canon(merged) !== canon(this.v);
    this.v = merged;
    this.remoteSha = remote.sha;
    if (fingerprint(merged) !== before) this.runPlanner();
    // If our merged copy differs from what's remote, we need to push it.
    if (canon(this.v) !== canon({ ...emptyVault(), ...rv })) this.rev++;
    if (changed) this.emit();
    return { exists: true, changed };
  }

  async sync() {
    const gh = this.session.gh;
    if (!gh) return;
    if (this._syncing) { this._again = true; return this._syncing; }
    clearTimeout(this._pushTimer);
    this.setStatus('syncing');
    this._syncing = (async () => {
      try {
        let { exists } = await this.pullAndMerge();
        for (let attempt = 0; attempt < 4 && (this.dirty || !exists); attempt++) {
          const rev = this.rev;
          const blob = await encryptJSON(this.session.dek, this.v, this.ctx);
          try {
            this.remoteSha = await gh.putFile(this.remotePath, blob, exists ? this.remoteSha : undefined, 'Sync');
            this.pushedRev = rev;
            exists = true;
          } catch (e) {
            if (e.code !== 'CONFLICT') throw e;
            ({ exists } = await this.pullAndMerge());
          }
        }
        this.lastSync = Date.now();
        this.setStatus('synced');
      } catch (e) {
        console.warn('Sync failed', e);
        this.setStatus(e.code === 'OFFLINE' ? 'offline' : 'error', e.message);
      } finally {
        await this.saveLocal().catch(console.error);
        this._syncing = null;
        if (this._again) { this._again = false; this.sync(); }
      }
    })();
    return this._syncing;
  }
}
