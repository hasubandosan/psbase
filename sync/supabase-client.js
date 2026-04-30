// sync/supabase-client.js — Supabase singleton + Auth helpers
// Зависит от: CONFIG, @supabase/supabase-js (CDN)

let _sbClient = null;

function getSupabase() {
  if (_sbClient) return _sbClient;
  if (!window.supabase?.createClient)
    throw new Error('Supabase SDK не загружен — добавьте CDN-скрипт в index.html');
  _sbClient = window.supabase.createClient(
    CONFIG.supabase.url,
    CONFIG.supabase.anonKey,
    { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } }
  );
  return _sbClient;
}

const Auth = {
  async current() {
    const { data: { user } } = await getSupabase().auth.getUser();
    return user;
  },
  async signUp(email, password) {
    const { data, error } = await getSupabase().auth.signUp({ email, password });
    if (error) throw error;
    return data.user;
  },
  async signIn(email, password) {
    const { data, error } = await getSupabase().auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data.user;
  },
  async signOut() {
    const { error } = await getSupabase().auth.signOut();
    if (error) throw error;
  },
  onAuthChange(cb) {
    return getSupabase().auth.onAuthStateChange((_e, session) => cb(session?.user ?? null));
  },
};
