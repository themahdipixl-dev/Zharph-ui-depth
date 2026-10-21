import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";
import * as WebBrowser from "expo-web-browser";
import * as ExpoLinking from "expo-linking";

WebBrowser.maybeCompleteAuthSession();

// The publishable key is meant to live in the app; Row Level Security protects the data.
// Flip to true once the Google provider is set up in Supabase (needs a Google Cloud OAuth client)
export const GOOGLE_ENABLED = false;

const SUPABASE_URL = "https://ovkhbonseblrhfmcdnag.supabase.co";
const SUPABASE_KEY = "sb_publishable_VnO6Vy5RwWuv4lzZhg2dUQ_nTGF480J";

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
    flowType: "pkce",
  },
});

const friendly = (err) => {
  const m = String(err?.message || "");
  if (/invalid login credentials/i.test(m)) return "Wrong email or password";
  if (/already registered|already been registered/i.test(m)) return "An account with this email already exists";
  if (/network|fetch/i.test(m)) return "No connection. Check your internet and try again.";
  return m || "Something went wrong. Please try again.";
};
const check = (error) => { if (error) throw new Error(friendly(error)); };

export async function signInOrUp({ mode, name, email, password }) {
  if (mode === "signup") {
    const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { name } } });
    check(error);
    if (!data.session) throw new Error("Check your email to confirm your account, then sign in.");
    return data.user;
  }
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  check(error);
  return data.user;
}

// The reset link in the email opens the app on this address (see the deep-link handler in App.js)
export async function resetPassword(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: ExpoLinking.createURL("reset-password") });
  check(error);
}

export async function setNewPassword(password) {
  const { error } = await supabase.auth.updateUser({ password });
  check(error);
}

// Reads the session out of a deep link (?code=... for PKCE, or #access_token=... as a fallback)
export async function sessionFromUrl(url) {
  const u = new URL(url);
  const hash = new URLSearchParams(u.hash.replace(/^#/, ""));
  const errDesc = u.searchParams.get("error_description") || hash.get("error_description");
  if (errDesc) throw new Error(errDesc.replace(/\+/g, " "));
  const code = u.searchParams.get("code");
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    check(error);
    return true;
  }
  const at = hash.get("access_token"), rt = hash.get("refresh_token");
  if (at && rt) {
    const { error } = await supabase.auth.setSession({ access_token: at, refresh_token: rt });
    check(error);
    return true;
  }
  return false;
}

// Google sign-in through the system browser. Returns true when signed in, false when the user backed out.
export async function signInWithGoogle() {
  const redirectTo = ExpoLinking.createURL("auth-callback");
  const { data, error } = await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo, skipBrowserRedirect: true } });
  check(error);
  const res = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
  if (res.type !== "success" || !res.url) return false;
  return sessionFromUrl(res.url);
}

export async function loadUserData(userId) {
  const [p, s, sv] = await Promise.all([
    supabase.from("profiles").select("name").eq("id", userId).maybeSingle(),
    supabase.from("settings").select("prefs, grid_columns").eq("user_id", userId).maybeSingle(),
    supabase.from("saved_wallpapers").select("wallpaper_id").eq("user_id", userId),
  ]);
  check(p.error); check(s.error); check(sv.error);
  const saved = {};
  (sv.data || []).forEach((r) => { saved[r.wallpaper_id] = true; });
  return { name: p.data?.name || null, prefs: s.data?.prefs || {}, gridColumns: s.data?.grid_columns || null, saved };
}

export async function saveSettings(userId, prefs, gridColumns) {
  const { cache, ...shared } = prefs || {}; // cache size is per-device, not synced
  const { error } = await supabase.from("settings").upsert(
    { user_id: userId, prefs: shared, grid_columns: gridColumns, updated_at: new Date().toISOString() },
    { onConflict: "user_id" }
  );
  check(error);
}

export async function syncSaved(userId, wallpaperId, on) {
  const id = String(wallpaperId);
  const { error } = on
    ? await supabase.from("saved_wallpapers").upsert({ user_id: userId, wallpaper_id: id }, { onConflict: "user_id,wallpaper_id" })
    : await supabase.from("saved_wallpapers").delete().eq("user_id", userId).eq("wallpaper_id", id);
  check(error);
}

export async function pushSaved(userId, ids) {
  if (!ids.length) return;
  const rows = ids.map((id) => ({ user_id: userId, wallpaper_id: String(id) }));
  const { error } = await supabase.from("saved_wallpapers").upsert(rows, { onConflict: "user_id,wallpaper_id" });
  check(error);
}

export async function updateName(userId, name) {
  const { error } = await supabase.from("profiles").upsert({ id: userId, name }, { onConflict: "id" });
  check(error);
  await supabase.auth.updateUser({ data: { name } });
}

export async function deleteAccount() {
  const { error } = await supabase.functions.invoke("delete-account");
  check(error);
  await supabase.auth.signOut({ scope: "local" });
}

// ---------- uploads (private bucket "user-uploads", one folder per user) ----------
const MIME = { png: "image/png", webp: "image/webp", gif: "image/gif", heic: "image/heic" };

export async function uploadImage(userId, localUri) {
  const buf = await (await fetch(localUri)).arrayBuffer();
  const m = localUri.split("?")[0].match(/\.(\w+)$/);
  const ext = m ? m[1].toLowerCase() : "jpg";
  const path = `${userId}/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}.${ext}`;
  const up = await supabase.storage.from("user-uploads").upload(path, buf, { contentType: MIME[ext] || "image/jpeg" });
  check(up.error);
  const row = await supabase.from("uploads").insert({ user_id: userId, storage_path: path }).select("id").single();
  check(row.error);
  return { id: row.data.id, path };
}

export async function loadUploads(userId) {
  const { data, error } = await supabase.from("uploads").select("id, storage_path").eq("user_id", userId).order("created_at", { ascending: false });
  check(error);
  if (!data || !data.length) return [];
  const signed = await supabase.storage.from("user-uploads").createSignedUrls(data.map((r) => r.storage_path), 60 * 60 * 24 * 7);
  check(signed.error);
  const out = [];
  data.forEach((r, i) => { const url = signed.data && signed.data[i] && signed.data[i].signedUrl; if (url) out.push({ id: r.id, url }); });
  return out;
}
