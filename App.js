import React, { useEffect, useState, useRef, useCallback, useMemo, useSyncExternalStore, memo } from "react";
import { View, Text, ScrollView, Pressable, Image, StyleSheet, StatusBar, Animated, Easing, useWindowDimensions, BackHandler, PanResponder, TextInput, Platform, Modal, KeyboardAvoidingView, Switch, Alert, Linking, ActivityIndicator, InteractionManager } from "react-native";

import { SafeAreaView } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as NavigationBar from "expo-navigation-bar";
import * as ImagePicker from "expo-image-picker";
import { useFonts, loadAsync as loadFontAsync } from "expo-font";
// Custom fonts picked from the device (install once:  npx expo install expo-document-picker expo-file-system)
let DocPicker = null; try { DocPicker = require("expo-document-picker"); } catch (e) { DocPicker = null; }
let FS = null; try { FS = require("expo-file-system/legacy"); } catch (e) { try { FS = require("expo-file-system"); } catch (e2) { FS = null; } }
import Svg, { Defs, LinearGradient, RadialGradient, Stop, Rect, Circle, Mask, G, Path, Text as SvgText, TSpan } from "react-native-svg";
// Fonts are required per file (not through the family barrel, which bundles every weight/italic of the family).
// UI fonts load before the first screen; clock fonts load right after it (see loadClockFonts).
import { customFonts } from "./fonts";
import { supabase, signInOrUp, signInWithGoogle, GOOGLE_ENABLED, resetPassword, setNewPassword, sessionFromUrl, loadUserData, saveSettings, syncSaved, pushSaved, updateName, deleteAccount, uploadImage, loadUploads } from "./supabase";

// Depth system (zharph-core): AI layer analysis + live wallpaper with a foreground mask. Needs a native build with
// react-native-webview, expo-image-manipulator and @shopify/react-native-skia (not Expo Go). Missing -> Depth/Apply explain it.
let DepthCore = null;
try {
  DepthCore = { Engine: require("./core/engine").default, tools: require("./core/tools"), wp: require("./modules/zharph-wallpaper") };
} catch (e) { DepthCore = null; if (__DEV__) console.warn("[depth] zharph-core unavailable:", e && e.message); }

// Glass background blur needs:  npx expo install @react-native-masked-view/masked-view  (without it glass still works, just no blur)
let MaskedViewC = null;
try { MaskedViewC = require("@react-native-masked-view/masked-view").default; } catch (e) { MaskedViewC = null; }

// Ruler "teeth": a very light tick on every value of a ruler slider.  Needs:  npx expo install expo-haptics
// (not installed -> the ruler simply stays silent).  Follows Settings > Haptic feedback (hapticCfg.on).
let HapticsC = null;
try { HapticsC = require("expo-haptics"); } catch (e) { HapticsC = null; }
const hapticCfg = { on: true, last: 0 };
function rulerTick() {
  if (!HapticsC || !hapticCfg.on) return;
  const n = Date.now();
  if (n - hapticCfg.last < 70) return;   // a fast flick must not turn into a buzz
  hapticCfg.last = n;
  try { HapticsC.selectionAsync(); } catch (e) { /* ignore */ }
}

// Bottom-nav blur (the ONLY blur in the UI). Needs:  npx expo install expo-blur
// Not installed / unsupported device -> BlurViewC stays null or BLUR_OK is false and the bar becomes an almost solid dark surface.
let BlurViewC = null, BlurTargetC = null; // BlurTargetView exists only in newer expo-blur versions (Android needs it there)
try { const _blur = require("expo-blur"); BlurViewC = _blur.BlurView || null; BlurTargetC = _blur.BlurTargetView || null; }
catch (e) { BlurViewC = null; console.warn("[nav blur] require('expo-blur') failed -> using solid fallback:", e && e.message); }
const BLUR_OK = !!BlurViewC && (Platform.OS === "ios" || (Platform.OS === "android" && Number(Platform.Version) >= 31));
if (!BLUR_OK) console.warn("[nav blur] FALLBACK active:", BlurViewC ? "device not supported (Android < 12)" : "expo-blur missing or BlurView not exported (not installed in this build?)");
else if (__DEV__) console.log("[nav blur] BlurView active", Platform.OS, "BlurTargetView:", !!BlurTargetC);

// ---------- Remote wallpapers (GitHub: index.json in repo + files on the "wallpapers" release) ----------
const GH_USER = "themahdipixl-dev";
const GH_REPO = "assets";
const GH_BRANCH = "main";
const GH_TAG = "wallpapers";
const INDEX_URL = `https://raw.githubusercontent.com/${GH_USER}/${GH_REPO}/${GH_BRANCH}/index.json`;
const releaseUrl = (file) => `https://github.com/${GH_USER}/${GH_REPO}/releases/download/${GH_TAG}/${file}`;
async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}
const REMOTE_CACHE_KEY = "zharph:remote-wallpapers:v1";
function useRemoteWallpapers() {
  const [list, setList] = useState([]);
  useEffect(() => {
    let dead = false;
    let fresh = false;
    // 1) last known list from disk: the grid is filled immediately, even offline
    AsyncStorage.getItem(REMOTE_CACHE_KEY).then((raw) => {
      if (dead || fresh || !raw) return;
      try { const cached = JSON.parse(raw); if (Array.isArray(cached)) setList(cached); } catch (e) { /* ignore */ }
    }).catch(() => {});
    // 2) refresh in the background
    (async () => {
      try {
        const ids = await getJson(`${INDEX_URL}?t=${Date.now()}`); // ?t= skips stale cache (tiny file)
        const loaded = await Promise.all(ids.map(async (id) => {
          try {
            const meta = await getJson(releaseUrl(`${id}_meta.json`));
            const firstLayer = meta.layers && meta.layers[0] && meta.layers[0].file;
            if (!firstLayer) return null;
            return {
              id: String(meta.id || id),
              title: meta.title || String(id),
              type: meta.type || "depth",
              thumb: releaseUrl(meta.thumb || firstLayer),
              uri: releaseUrl(firstLayer),
              meta
            };
          } catch (e) { if (__DEV__) console.warn("Wallpaper skipped:", id, e.message); return null; }
        }));
        const ok = loaded.filter(Boolean);
        fresh = true;
        if (dead) return;
        setList(ok);
        AsyncStorage.setItem(REMOTE_CACHE_KEY, JSON.stringify(ok)).catch(() => {});
      } catch (e) { if (__DEV__) console.warn("index.json failed:", e.message); }
    })();
    return () => { dead = true; };
  }, []);
  return list;
}

// ---------- Theme (merged from theme.js) ----------
// One place for colors, fonts, corner radii, page margin and the sample wallpapers.
// C / F / R below are the short names the rest of this file uses.
export const theme = {
  bg: "#100E0E",
  surface: "#1A1716",
  surface2: "#241F1D",
  surface3: "#2E2825",
  primary: "#FF7A59",
  primaryPressed: "#E8643F",
  primarySoft: "rgba(255,122,89,0.16)",
  onPrimary: "#2A0E08",
  text: "#F2EBE7",
  muted: "#B8ADA7",
  outline: "#3A322F",
  hair: "rgba(242,235,231,0.08)",   // very thin light border for floating surfaces
  scrim: "rgba(16,14,14,0.86)",     // matte dark surface for buttons/badges that sit on wallpapers
  danger: "#E5484D"
};
// Type: Syne for titles, Manrope for text, labels, numbers and controls. (Nunito stays loaded only for the clock "rounded" font.)
export const fonts = {
  body: "Manrope_400Regular",
  semi: "Manrope_600SemiBold",
  bold: "Manrope_700Bold",
  black: "Manrope_800ExtraBold",
  display: "Syne_700Bold",
  displayXL: "Syne_800ExtraBold"
};
// Corner scale: xs badges/tags, sm chips/buttons/fields/Seg, md cards, lg sheet top corners. Circles only for small round buttons.
export const radius = { xs: 6, sm: 10, md: 14, lg: 20 };
export const layout = { pageX: 16 }; // one horizontal page margin: app name, chips and cards all start here; filter icon and last card end here
export const wallpapers = [
  { id: "w1", title: "Alpine dusk", category: "Nature", image: "https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=700&auto=format&fit=crop&q=85" },
  { id: "w2", title: "Quiet coast", category: "Nature", image: "https://images.unsplash.com/photo-1500375592092-40eb2168fd21?w=700&auto=format&fit=crop&q=85" },
  { id: "w3", title: "Blue hour", category: "Minimal", image: "https://images.unsplash.com/photo-1519681393784-d120267933ba?w=700&auto=format&fit=crop&q=85" },
  { id: "w4", title: "Desert lines", category: "Minimal", image: "https://images.unsplash.com/photo-1509316785289-025f5b846b35?w=700&auto=format&fit=crop&q=85" },
  { id: "w5", title: "Forest light", category: "Nature", image: "https://images.unsplash.com/photo-1448375240586-882707db888b?w=700&auto=format&fit=crop&q=85" },
  { id: "w6", title: "Soft horizon", category: "Abstract", image: "https://images.unsplash.com/photo-1470770841072-f978cf4d019e?w=700&auto=format&fit=crop&q=85" }
];
const C = theme, F = fonts, R = radius;
// Bottom nav: full-width bar, content height (the safe-area bottom inset is added by a SafeAreaView inside the bar).
const NAV_H = 68;
const NAV_TINT = BLUR_OK ? "rgba(16,14,14,0.65)" : "rgba(16,14,14,0.96)"; // 78% dark tint over the blur; near-solid only in fallback
const TOPBAR_ICON_R = 13; // right offset of the filter icon: same x as the grid/layout icon in the header
const TOPBAR_H = 52; // top category bar (chips + filter icon): one fixed-height row, glass like the bottom nav (same blur intensity + NAV_TINT)
const NAV_PILL_W = 52, NAV_PILL_H = 28, NAV_PILL_TOP = 12.5; // active "pill" behind the icon (measured from the reference design)
const BlurWrap = BlurTargetC && Platform.OS === "android" ? BlurTargetC : View; // Android (new expo-blur): the content the bar blurs must live inside a BlurTargetView
// Motion: calm, precise, no overshoot (except the "saved" moment).
const SPRING = { stiffness: 400, damping: 38, mass: 1, overshootClamping: true, useNativeDriver: true };
const SPRING_SHEET = { stiffness: 340, damping: 36, mass: 1, overshootClamping: true, useNativeDriver: true };
const EASE_OUT = Easing.out(Easing.cubic);
const items = [
  ...wallpapers.map(w => [w.title, w.image]),
  ["Misty peaks", "https://images.unsplash.com/photo-1519681393784-d120267933ba?w=700&auto=format&fit=crop&q=85&sat=-20"],
  ["Emerald lake", "https://images.unsplash.com/photo-1439853949127-fa647821eba0?w=700&auto=format&fit=crop&q=85"],
  ["Golden fields", "https://images.unsplash.com/photo-1500382017468-9049fed747ef?w=700&auto=format&fit=crop&q=85"],
  ["Ocean cliffs", "https://images.unsplash.com/photo-1518837695005-2083093ee35b?w=700&auto=format&fit=crop&q=85"],
  ["Autumn path", "https://images.unsplash.com/photo-1507783548227-7b1b4fa075e0?w=700&auto=format&fit=crop&q=85"],
  ["Snow valley", "https://images.unsplash.com/photo-1454496522488-7a8e488e8606?w=700&auto=format&fit=crop&q=85"],
  ["Tropical bay", "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=700&auto=format&fit=crop&q=85"],
  ["Moonlit lake", "https://images.unsplash.com/photo-1470770841072-f978cf4d019e?w=700&auto=format&fit=crop&q=85&sat=-35"],
  ["Pine wilderness", "https://images.unsplash.com/photo-1448375240586-882707db888b?w=700&auto=format&fit=crop&q=85&sat=-15"],
  ["Canyon glow", "https://images.unsplash.com/photo-1464013778555-8e723c2f01f8?w=700&auto=format&fit=crop&q=85"],
  ["Rainforest", "https://images.unsplash.com/photo-1511497584788-876760111969?w=700&auto=format&fit=crop&q=85"],
  ["Calm lagoon", "https://images.unsplash.com/photo-1519046904884-53103b34b206?w=700&auto=format&fit=crop&q=85"],
  ["Cloud summit", "https://images.unsplash.com/photo-1464278533981-50106e6176b1?w=700&auto=format&fit=crop&q=85"],
  ["River bend", "https://images.unsplash.com/photo-1433086966358-54859d0ed716?w=700&auto=format&fit=crop&q=85"]
];
// Grid cards are ~190dp wide: a 480px / q70 thumbnail is plenty; the editor still loads the full 700px / q85 image.
const thumbUrl = (u) => (typeof u === "string" && u.includes("images.unsplash.com") ? u.replace("w=700", "w=480").replace("q=85", "q=70") : u);
const tabs = [ // [internal name, icon, label shown in the bar]
  ["Home", "nav_home", "Home"], ["Wallpapers", "nav_explore", "Explore"],
  ["Add", "nav_create", "Create"], ["Saved", "bookmark", "Saved"], ["Settings", "tune", "Settings"]
];

const TOOL_NAMES = ["Depth", "Adjust", "Clock", "Parallax", "Effects"];

function findTouch(touches, identifier) {
  if (!touches) return null;
  for (let i = 0; i < touches.length; i++) {
    if ((touches[i].identifier ?? 0) === identifier) return touches[i];
  }
  return null;
}

// ---------- Icons: drawn from scratch, line-only, 24x24, round caps/joins, no sharp corners ----------
const ic = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
const rr = (x, y, w, h, r) => `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}z`;
const DROP = "M12 3.8c3.2 3.4 6 6.6 6 10a6 6 0 0 1-12 0c0-3.4 2.8-6.6 6-10z";
const ICONS = {
  nav_home: rr(4, 3.5, 7, 9.5, 2.4) + " " + rr(4, 16, 7, 4.5, 2.2) + " " + rr(13.5, 3.5, 6.5, 6, 2.4) + " " + rr(13.5, 12.5, 6.5, 8, 2.4),
  nav_explore: ic(12, 12, 8.5) + " M15 9l-1.7 4.3L9 15l1.7-4.3z",
  nav_create: rr(3.5, 3.5, 17, 17, 4.6) + " M12 8.3v7.4M8.3 12h7.4",
  layers: "M12 3.8 4 8.3l8 4.5 8-4.5z M4 12.3l8 4.5 8-4.5 M4 16.3l8 4.5 8-4.5",
  wallpaper: rr(3.5, 4.5, 17, 15, 4.5) + " " + ic(9, 9.8, 1.5) + " M4.2 16.4l4.4-4.1 3.2 3 2.8-2.9 5.4 4.8",
  add: "M12 5v14M5 12h14",
  bookmark: "M8 4h8a2.5 2.5 0 0 1 2.5 2.5V20L12 15.8 5.5 20V6.5A2.5 2.5 0 0 1 8 4z",
  settings: "M10.4 3.8h3.2l.55 2.1 1.6.93 2.1-.6 1.6 2.78-1.55 1.5v1.85l1.55 1.5-1.6 2.78-2.1-.6-1.6.93-.55 2.1h-3.2l-.55-2.1-1.6-.93-2.1.6-1.6-2.78 1.55-1.5v-1.85l-1.55-1.5 1.6-2.78 2.1.6 1.6-.93z " + ic(12, 12, 2.9),
  restart_alt: "M5 12a7 7 0 1 0 2.1-5M5 4.5V8h3.5",
  refresh: "M19 12a7 7 0 1 1-2.1-5M19 4.5V8h-3.5",
  arrow_back: "M19 12H5.5M11 6l-6 6 6 6",
  check: "M5 12.5l4.5 4.5L19 7.5",
  tune: "M4 8h9M17 8h3M4 16h3M11 16h9 " + ic(15, 8, 2) + " " + ic(9, 16, 2),
  palette: "M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 2-1 1.6-2.1-.4-1.1.3-2.1 1.5-2.1H17a3.5 3.5 0 0 0 3.5-3.5c0-4.3-3.8-9.3-8.5-9.3z " + ic(8, 11.2, .5) + " " + ic(10.8, 7.6, .5) + " " + ic(15, 7.8, .5),
  undo: "M8.5 5 4.5 9l4 4M5 9h8.5a5.5 5.5 0 0 1 0 11H10",
  redo: "M15.5 5l4 4-4 4M19 9h-8.5a5.5 5.5 0 0 0 0 11H14",
  auto_awesome: "M10 4.5c.6 3.8 1.7 4.9 5.5 5.5-3.8.6-4.9 1.7-5.5 5.5-.6-3.8-1.7-4.9-5.5-5.5 3.8-.6 4.9-1.7 5.5-5.5z M17.8 14.6c.3 1.9.9 2.5 2.7 2.8-1.8.3-2.4.9-2.7 2.8-.3-1.9-.9-2.5-2.7-2.8 1.8-.3 2.4-.9 2.7-2.8z",
  "3d_rotation": "M12 3.6l7.4 4.2v8.4L12 20.4l-7.4-4.2V7.8z M4.6 7.8L12 12l7.4-4.2M12 12v8.4",
  chevron_right: "M9.5 6l6 6-6 6",
  visibility: "M2.8 12C2.8 12 6 5.8 12 5.8C18 5.8 21.2 12 21.2 12C21.2 12 18 18.2 12 18.2C6 18.2 2.8 12 2.8 12z " + ic(12, 12, 2.7),
  visibility_off: "M2.8 12C2.8 12 6 5.8 12 5.8C18 5.8 21.2 12 21.2 12C21.2 12 18 18.2 12 18.2C6 18.2 2.8 12 2.8 12z M4.5 4.5l15 15",
  edit: "M4.5 19.5l.9-3.9L16 5a2.2 2.2 0 0 1 3.1 3.1L8.4 18.6z M14 7l3 3",
  person: ic(12, 8.2, 3.6) + " M5 19.5c.8-3.6 3.6-5.5 7-5.5 3.4 0 6.2 1.9 7 5.5",
  zoom_in: ic(10.5, 10.5, 6.5) + " M15.3 15.3L20 20M10.5 8v5M8 10.5h5",
  zoom_out: ic(10.5, 10.5, 6.5) + " M15.3 15.3L20 20M8 10.5h5",
  expand_diag: "M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7",      // two diagonal arrows pointing away from each other
  collapse_diag: "M20 10h-6V4M14 10l7-7M4 14h6v6M10 14l-7 7",   // two diagonal arrows pointing at each other
  grid_view: rr(4, 4, 7, 7, 2.6) + " " + rr(13, 4, 7, 7, 2.6) + " " + rr(4, 13, 7, 7, 2.6) + " " + rr(13, 13, 7, 7, 2.6),
  view_module: rr(3.5, 4.5, 5, 15, 2.2) + " " + rr(9.5, 4.5, 5, 15, 2.2) + " " + rr(15.5, 4.5, 5, 15, 2.2),
  schedule: ic(12, 12, 8.5) + " M12 7.5V12l3 2",
  mail: rr(3.5, 5.5, 17, 13, 3.8) + " M5.2 8.6L12 13l6.8-4.4",
  lock: rr(5, 10.5, 14, 9.5, 3.2) + " M8 10.5V8a4 4 0 0 1 8 0v2.5M12 14.8v1.8",
  notifications: "M6.5 16V11a5.5 5.5 0 0 1 11 0v5l1.5 1.8H5L6.5 16z M10 20.5a2.2 2.2 0 0 0 4 0",
  wifi: "M3.5 9.4a12 12 0 0 1 17 0M6.5 12.6a7.7 7.7 0 0 1 11 0M9.4 15.8a3.6 3.6 0 0 1 5.2 0M12 19.2h.01",
  hd: rr(3, 5.5, 18, 13, 3.8) + " M7.5 9.5v5M7.5 12h3M10.5 9.5v5M13.6 9.5h1.2a2.5 2.5 0 0 1 0 5h-1.2z",
  key: ic(7.8, 16.2, 3.5) + " M10.4 13.6L19 5M16.2 7.8l2.4 2.4M13.6 10.4l1.8 1.8",
  logout: "M10 4.5H7A2.5 2.5 0 0 0 4.5 7v10A2.5 2.5 0 0 0 7 19.5h3M15 8l4 4-4 4M19 12H9.5",
  star: "M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.7L12 16.8l-5.1 2.7 1-5.7-4.1-4 5.7-.8z",
  support_agent: "M5 14v-2a7 7 0 0 1 14 0v2 " + rr(3.5, 13, 3.6, 5.5, 1.8) + " " + rr(16.9, 13, 3.6, 5.5, 1.8) + " M18.7 18.5c0 1.8-1.5 2.8-3.3 2.8H13",
  policy: "M12 3.5L19 6v5.5c0 4.2-2.8 7.4-7 9-4.2-1.6-7-4.8-7-9V6z M9 12l2.2 2.2L15.2 10",
  description: "M7 3.5h6.5L19 9v9.5a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2z M13.5 3.8V8a1 1 0 0 0 1 1h4.2M8.5 13h7M8.5 16.5h4.5",
  info: ic(12, 12, 8.5) + " M12 11v5M12 8h.01",
  delete_forever: "M4.5 7h15M9.5 7V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v2M6.5 7l.8 11.5a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9L17.5 7M10 11v5M14 11v5",
  opacity: DROP + " M6.4 14h11.2",
  water_drop: DROP + " M9.6 15.2a2.6 2.6 0 0 0 2 1.7",
  lens_blur: ic(12, 12, 8.5) + " " + ic(12, 12, 4.4) + " M12 12h.01",
  light_mode: ic(12, 12, 3.8) + " M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4",
  flare: ic(12, 12, 2.2) + " M12 3.5v4.2M12 16.3v4.2M3.5 12h4.2M16.3 12h4.2M6 6l2.6 2.6M15.4 15.4L18 18M18 6l-2.6 2.6M8.6 15.4L6 18",
  line_weight: "M4 6h16M4 11h16 " + rr(4, 15.5, 16, 4, 2),
  contrast: ic(12, 12, 8.5) + " M12 3.5a8.5 8.5 0 0 1 0 17z",
  border_style: "M4 6.5h16M4 12h3.5M10.2 12h3.6M16.5 12H20M4 17.5h.01M8.7 17.5h.01M13.3 17.5h.01M18 17.5h.01",
  rotate_right: "M18.5 8.5A7 7 0 1 0 19 12M18.8 4.8v4h-4",
  blur_on: ic(6.5, 6.5, .9) + " " + ic(12, 6.5, .9) + " " + ic(17.5, 6.5, .9) + " " + ic(6.5, 12, .9) + " " + ic(12, 12, .9) + " " + ic(17.5, 12, .9) + " " + ic(6.5, 17.5, .9) + " " + ic(12, 17.5, .9) + " " + ic(17.5, 17.5, .9),
  rounded_corner: "M4.5 19.5V12a7.5 7.5 0 0 1 7.5-7.5h7.5",
  crop_square: rr(5, 5, 14, 14, 3.6),
  format_size: "M4 7V5.5h11V7M9.5 5.5v13M7.5 18.5h4M15 12.5v-1h5.5v1M17.75 11.5v7M16.4 18.5h2.7",
  height: "M12 4v16M8 8l4-4 4 4M8 16l4 4 4-4",
  swap_horiz: "M4 8h14M14.5 4.5L18 8l-3.5 3.5M20 16H6M9.5 12.5L6 16l3.5 3.5",
  swap_vert: "M8 4v14M4.5 14.5L8 18l3.5-3.5M16 20V6M12.5 9.5L16 6l3.5 3.5",
  format_letter_spacing: "M7.5 15l4.5-10 4.5 10M9.2 11.4h5.6M4 20h16M6.2 18L4 20l2.2 2M17.8 18L20 20l-2.2 2",
  space_bar: "M4 10v6a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 16v-6",
  format_line_spacing: "M9.5 6H20M9.5 12H20M9.5 18H20M5 5.5v13M3 8l2-2.5L7 8M3 16l2 2.5L7 16",
  subdirectory_arrow_right: "M5 5v7.5A3.5 3.5 0 0 0 8.5 16H19M15 12l4 4-4 4",
  vertical_align_top: "M5 4.5h14M12 20V9M8 13l4-4 4 4",
  vertical_align_center: "M4 12h16M12 4v5M9 6.5l3 3 3-3M12 20v-5M9 17.5l3-3 3 3",
  format_italic: "M10 5h7M7 19h7M14.5 5L9.5 19",
  open_with: "M12 3.5v17M3.5 12h17M9.2 6.3L12 3.5l2.8 2.8M9.2 17.7L12 20.5l2.8-2.8M6.3 9.2L3.5 12l2.8 2.8M17.7 9.2l2.8 2.8-2.8 2.8",
  text_fields: "M5 7V5.5h14V7M12 5.5v13M9.5 18.5h5",
  speed: "M4.2 17a9 9 0 1 1 15.6 0M12 14.2l4-5 " + ic(12, 14.2, .9),
  exposure: rr(3.5, 3.5, 17, 17, 4.6) + " M7.5 9h5M10 6.5v5M12.5 16h4.5",
  thermostat: "M14 13.8V5.5a2 2 0 0 0-4 0v8.3a4.3 4.3 0 1 0 4 0z M12 9.5v6",
  colorize: "M14.4 6.4l3.2 3.2M16.8 4a2.3 2.3 0 0 1 3.2 3.2l-2 2-3.2-3.2zM13.2 9.2l-7 7V19h2.8l7-7",
  tonality: ic(12, 12, 8.5) + " M12 3.5v17M15.4 8h.01M15.4 12h.01M15.4 16h.01",
  vignette: rr(3.5, 5, 17, 14, 5) + " M7.6 12a4.4 3.4 0 1 0 8.8 0 4.4 3.4 0 1 0-8.8 0",
  search: ic(11, 11, 6.5) + " M16 16l4.5 4.5",
  more_vert: "M12 5.5h.01M12 12h.01M12 18.5h.01",
  photo_camera: rr(3.5, 7.5, 17, 12, 3.4) + " M8.5 7.5l1.2-2.2h4.6l1.2 2.2 " + ic(12, 13.4, 3.1),
  dark_mode: "M19.5 14.2A8 8 0 0 1 9.8 4.5a8 8 0 1 0 9.7 9.7z",
  phone_android: rr(7, 3.5, 10, 17, 2.8) + " M10.7 17.5h2.6",
  calendar_today: rr(4, 5.5, 16, 14.5, 3.4) + " M4 10.5h16M8.5 3.5v3.6M15.5 3.5v3.6",
  language: ic(12, 12, 8.5) + " M3.5 12h17M12 3.5c-3 3.4-3 13.6 0 17M12 3.5c3 3.4 3 13.6 0 17",
  storage: "M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  vibration: rr(8, 4.5, 8, 15, 2.4) + " M4.5 8v8M19.5 8v8",
  download: "M12 4.5v11M7.5 11.5l4.5 4.5 4.5-4.5M5 20h14",
  remove: "M5 12h14",
  expand_more: "M6 9.5l6 6 6-6"
};
// ---- Zharph icon set v2: generated by gen.js (rounded corners re-fitted to the same size, stroke 1.5) ----
// d = line drawing (used when inactive), f = closed shapes that get the 24% fill ONLY when the icon is active
const ICON_NEW = {
  "layers": { d: "M12.65 3.41L18.55 6.49A1.4 1.4 0 0 1 18.55 8.97L12.65 12.06A1.4 1.4 0 0 1 11.35 12.06L5.45 8.97A1.4 1.4 0 0 1 5.45 6.49L11.35 3.41A1.4 1.4 0 0 1 12.65 3.41ZM4.69 12.85L11.35 16.32A1.4 1.4 0 0 0 12.65 16.32L19.31 12.85M4.69 17.11L11.35 20.59A1.4 1.4 0 0 0 12.65 20.59L19.31 17.11", f: "M12.65 3.41L18.55 6.49A1.4 1.4 0 0 1 18.55 8.97L12.65 12.06A1.4 1.4 0 0 1 11.35 12.06L5.45 8.97A1.4 1.4 0 0 1 5.45 6.49L11.35 3.41A1.4 1.4 0 0 1 12.65 3.41Z" },
  "3d_rotation": { d: "M12.7 3.44L19.07 7.11A1.4 1.4 0 0 1 19.77 8.33L19.77 15.68A1.4 1.4 0 0 1 19.07 16.89L12.7 20.56A1.4 1.4 0 0 1 11.3 20.56L4.93 16.89A1.4 1.4 0 0 1 4.23 15.68L4.23 8.32A1.4 1.4 0 0 1 4.93 7.11L11.3 3.44A1.4 1.4 0 0 1 12.7 3.44ZM12 12L19.58 7.63M12 12L4.42 7.62M12 12L12 20.75", f: "M12.7 3.44L19.07 7.11A1.4 1.4 0 0 1 19.77 8.33L19.77 15.68A1.4 1.4 0 0 1 19.07 16.89L12.7 20.56A1.4 1.4 0 0 1 11.3 20.56L4.93 16.89A1.4 1.4 0 0 1 4.23 15.68L4.23 8.32A1.4 1.4 0 0 1 4.93 7.11L11.3 3.44A1.4 1.4 0 0 1 12.7 3.44Z" },
  "auto_awesome": { d: "M10.11 4L10.99 6.23A1.4 1.4 0 0 0 11.78 7.02L14.01 7.9A1.19 1.19 0 0 1 14.01 10.11L11.78 10.99A1.4 1.4 0 0 0 10.99 11.78L10.11 14.01A1.19 1.19 0 0 1 7.9 14.01L7.02 11.78A1.4 1.4 0 0 0 6.23 10.99L4 10.11A1.19 1.19 0 0 1 4 7.9L6.23 7.02A1.4 1.4 0 0 0 7.02 6.23L7.9 4A1.19 1.19 0 0 1 10.11 4ZM18.27 15.01L18.71 16.12A0.95 0.95 0 0 0 19.24 16.65L20.35 17.09A0.63 0.63 0 0 1 20.35 18.27L19.24 18.71A0.95 0.95 0 0 0 18.71 19.24L18.27 20.35A0.63 0.63 0 0 1 17.09 20.35L16.65 19.24A0.95 0.95 0 0 0 16.12 18.71L15.01 18.27A0.63 0.63 0 0 1 15.01 17.09L16.12 16.65A0.95 0.95 0 0 0 16.65 16.12L17.09 15.01A0.63 0.63 0 0 1 18.27 15.01Z", f: "M10.11 4L10.99 6.23A1.4 1.4 0 0 0 11.78 7.02L14.01 7.9A1.19 1.19 0 0 1 14.01 10.11L11.78 10.99A1.4 1.4 0 0 0 10.99 11.78L10.11 14.01A1.19 1.19 0 0 1 7.9 14.01L7.02 11.78A1.4 1.4 0 0 0 6.23 10.99L4 10.11A1.19 1.19 0 0 1 4 7.9L6.23 7.02A1.4 1.4 0 0 0 7.02 6.23L7.9 4A1.19 1.19 0 0 1 10.11 4ZM18.27 15.01L18.71 16.12A0.95 0.95 0 0 0 19.24 16.65L20.35 17.09A0.63 0.63 0 0 1 20.35 18.27L19.24 18.71A0.95 0.95 0 0 0 18.71 19.24L18.27 20.35A0.63 0.63 0 0 1 17.09 20.35L16.65 19.24A0.95 0.95 0 0 0 16.12 18.71L15.01 18.27A0.63 0.63 0 0 1 15.01 17.09L16.12 16.65A0.95 0.95 0 0 0 16.65 16.12L17.09 15.01A0.63 0.63 0 0 1 18.27 15.01Z" },
  "star": { d: "M13.29 4.45L14.72 7.78A1.4 1.4 0 0 0 15.88 8.62L19.48 8.96A1.4 1.4 0 0 1 20.28 11.4L17.56 13.79A1.4 1.4 0 0 0 17.11 15.15L17.91 18.69A1.4 1.4 0 0 1 15.83 20.2L12.71 18.35A1.4 1.4 0 0 0 11.29 18.35L8.17 20.2A1.4 1.4 0 0 1 6.09 18.69L6.89 15.15A1.4 1.4 0 0 0 6.44 13.79L3.72 11.4A1.4 1.4 0 0 1 4.52 8.96L8.12 8.62A1.4 1.4 0 0 0 9.28 7.78L10.71 4.45A1.4 1.4 0 0 1 13.29 4.45Z", f: "M13.29 4.45L14.72 7.78A1.4 1.4 0 0 0 15.88 8.62L19.48 8.96A1.4 1.4 0 0 1 20.28 11.4L17.56 13.79A1.4 1.4 0 0 0 17.11 15.15L17.91 18.69A1.4 1.4 0 0 1 15.83 20.2L12.71 18.35A1.4 1.4 0 0 0 11.29 18.35L8.17 20.2A1.4 1.4 0 0 1 6.09 18.69L6.89 15.15A1.4 1.4 0 0 0 6.44 13.79L3.72 11.4A1.4 1.4 0 0 1 4.52 8.96L8.12 8.62A1.4 1.4 0 0 0 9.28 7.78L10.71 4.45A1.4 1.4 0 0 1 13.29 4.45Z" },
  "open_with": { d: "M15.52 6.19L12.99 3.66A1.4 1.4 0 0 0 11.01 3.66L8.48 6.19M17.81 15.52L20.34 12.99A1.4 1.4 0 0 0 20.34 11.01L17.81 8.48M8.48 17.81L11.01 20.34A1.4 1.4 0 0 0 12.99 20.34L15.52 17.81M6.19 8.48L3.66 11.01A1.4 1.4 0 0 0 3.66 12.99L6.19 15.52M12 3.25L12 20.75M3.25 12L20.75 12", f: "" },
  "settings": { d: "M10.1 4.94L10.24 4.07A0.98 0.98 0 0 1 11.21 3.25L12.79 3.25A0.98 0.98 0 0 1 13.76 4.07L13.9 4.94A0.98 0.98 0 0 0 14.5 5.68L14.7 5.77A0.98 0.98 0 0 0 15.65 5.66L16.37 5.15A0.98 0.98 0 0 1 17.63 5.25L18.75 6.37A0.98 0.98 0 0 1 18.85 7.63L18.34 8.35A0.98 0.98 0 0 0 18.23 9.3L18.32 9.5A0.98 0.98 0 0 0 19.06 10.1L19.93 10.24A0.98 0.98 0 0 1 20.75 11.21L20.75 12.79A0.98 0.98 0 0 1 19.93 13.76L19.06 13.9A0.98 0.98 0 0 0 18.32 14.5L18.23 14.7A0.98 0.98 0 0 0 18.34 15.65L18.85 16.37A0.98 0.98 0 0 1 18.75 17.63L17.63 18.75A0.98 0.98 0 0 1 16.37 18.85L15.65 18.34A0.98 0.98 0 0 0 14.7 18.23L14.5 18.32A0.98 0.98 0 0 0 13.9 19.06L13.76 19.93A0.98 0.98 0 0 1 12.79 20.75L11.21 20.75A0.98 0.98 0 0 1 10.24 19.93L10.1 19.06A0.98 0.98 0 0 0 9.5 18.32L9.3 18.23A0.98 0.98 0 0 0 8.35 18.34L7.63 18.85A0.98 0.98 0 0 1 6.37 18.75L5.25 17.63A0.98 0.98 0 0 1 5.15 16.37L5.66 15.65A0.98 0.98 0 0 0 5.77 14.7L5.68 14.5A0.98 0.98 0 0 0 4.94 13.9L4.07 13.76A0.98 0.98 0 0 1 3.25 12.79L3.25 11.21A0.98 0.98 0 0 1 4.07 10.24L4.94 10.1A0.98 0.98 0 0 0 5.68 9.5L5.77 9.3A0.98 0.98 0 0 0 5.66 8.35L5.15 7.63A0.98 0.98 0 0 1 5.25 6.37L6.37 5.25A0.98 0.98 0 0 1 7.63 5.15L8.35 5.66A0.98 0.98 0 0 0 9.3 5.77L9.5 5.68A0.98 0.98 0 0 0 10.1 4.94ZM9.1 12a2.9 2.9 0 1 0 5.8 0a2.9 2.9 0 1 0 -5.8 0", f: "M10.1 4.94L10.24 4.07A0.98 0.98 0 0 1 11.21 3.25L12.79 3.25A0.98 0.98 0 0 1 13.76 4.07L13.9 4.94A0.98 0.98 0 0 0 14.5 5.68L14.7 5.77A0.98 0.98 0 0 0 15.65 5.66L16.37 5.15A0.98 0.98 0 0 1 17.63 5.25L18.75 6.37A0.98 0.98 0 0 1 18.85 7.63L18.34 8.35A0.98 0.98 0 0 0 18.23 9.3L18.32 9.5A0.98 0.98 0 0 0 19.06 10.1L19.93 10.24A0.98 0.98 0 0 1 20.75 11.21L20.75 12.79A0.98 0.98 0 0 1 19.93 13.76L19.06 13.9A0.98 0.98 0 0 0 18.32 14.5L18.23 14.7A0.98 0.98 0 0 0 18.34 15.65L18.85 16.37A0.98 0.98 0 0 1 18.75 17.63L17.63 18.75A0.98 0.98 0 0 1 16.37 18.85L15.65 18.34A0.98 0.98 0 0 0 14.7 18.23L14.5 18.32A0.98 0.98 0 0 0 13.9 19.06L13.76 19.93A0.98 0.98 0 0 1 12.79 20.75L11.21 20.75A0.98 0.98 0 0 1 10.24 19.93L10.1 19.06A0.98 0.98 0 0 0 9.5 18.32L9.3 18.23A0.98 0.98 0 0 0 8.35 18.34L7.63 18.85A0.98 0.98 0 0 1 6.37 18.75L5.25 17.63A0.98 0.98 0 0 1 5.15 16.37L5.66 15.65A0.98 0.98 0 0 0 5.77 14.7L5.68 14.5A0.98 0.98 0 0 0 4.94 13.9L4.07 13.76A0.98 0.98 0 0 1 3.25 12.79L3.25 11.21A0.98 0.98 0 0 1 4.07 10.24L4.94 10.1A0.98 0.98 0 0 0 5.68 9.5L5.77 9.3A0.98 0.98 0 0 0 5.66 8.35L5.15 7.63A0.98 0.98 0 0 1 5.25 6.37L6.37 5.25A0.98 0.98 0 0 1 7.63 5.15L8.35 5.66A0.98 0.98 0 0 0 9.3 5.77L9.5 5.68A0.98 0.98 0 0 0 10.1 4.94Z" },
  "colorize": { d: "M17.75 3.72L20.28 6.25A1.6 1.6 0 0 1 20.28 8.51L18.31 10.48A1.6 1.6 0 0 1 16.04 10.48L13.52 7.96A1.6 1.6 0 0 1 13.52 5.69L15.49 3.72A1.6 1.6 0 0 1 17.75 3.72ZM11.82 6.26L17.74 12.18A0.9 0.9 0 0 1 17.74 13.45L17.17 14.02A0.9 0.9 0 0 1 15.89 14.02L15.05 13.17A0.9 0.9 0 0 0 13.78 13.17L7.72 19.23A0.9 0.9 0 0 1 7.44 19.42L4.5 20.68A0.9 0.9 0 0 1 3.32 19.5L4.58 16.56A0.9 0.9 0 0 1 4.77 16.28L10.83 10.22A0.9 0.9 0 0 0 10.83 8.95L9.98 8.11A0.9 0.9 0 0 1 9.98 6.83L10.55 6.26A0.9 0.9 0 0 1 11.82 6.26Z", f: "M17.75 3.72L20.28 6.25A1.6 1.6 0 0 1 20.28 8.51L18.31 10.48A1.6 1.6 0 0 1 16.04 10.48L13.52 7.96A1.6 1.6 0 0 1 13.52 5.69L15.49 3.72A1.6 1.6 0 0 1 17.75 3.72ZM11.82 6.26L17.74 12.18A0.9 0.9 0 0 1 17.74 13.45L17.17 14.02A0.9 0.9 0 0 1 15.89 14.02L15.05 13.17A0.9 0.9 0 0 0 13.78 13.17L7.72 19.23A0.9 0.9 0 0 1 7.44 19.42L4.5 20.68A0.9 0.9 0 0 1 3.32 19.5L4.58 16.56A0.9 0.9 0 0 1 4.77 16.28L10.83 10.22A0.9 0.9 0 0 0 10.83 8.95L9.98 8.11A0.9 0.9 0 0 1 9.98 6.83L10.55 6.26A0.9 0.9 0 0 1 11.82 6.26Z" },
  "tune": { d: "M3.75 8H13M17 8h3.25M3.75 16H7M11 16h9.25M13 8a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M7 16a2 2 0 1 0 4 0a2 2 0 1 0 -4 0", f: "" },
  "schedule": { d: "M6.15 3.75h11.7a2.4 2.4 0 0 1 2.4 2.4v11.7a2.4 2.4 0 0 1 -2.4 2.4h-11.7a2.4 2.4 0 0 1 -2.4 -2.4v-11.7a2.4 2.4 0 0 1 2.4 -2.4zM12 7.9V12l3 1.8", f: "M6.15 3.75h11.7a2.4 2.4 0 0 1 2.4 2.4v11.7a2.4 2.4 0 0 1 -2.4 2.4h-11.7a2.4 2.4 0 0 1 -2.4 -2.4v-11.7a2.4 2.4 0 0 1 2.4 -2.4z" },
  "calendar_today": { d: "M6.15 5h11.7a2.4 2.4 0 0 1 2.4 2.4v10.45a2.4 2.4 0 0 1 -2.4 2.4h-11.7a2.4 2.4 0 0 1 -2.4 -2.4v-10.45a2.4 2.4 0 0 1 2.4 -2.4zM3.75 10.25h16.5M8.25 3.25v3.5M15.75 3.25v3.5", f: "M6.15 5h11.7a2.4 2.4 0 0 1 2.4 2.4v10.45a2.4 2.4 0 0 1 -2.4 2.4h-11.7a2.4 2.4 0 0 1 -2.4 -2.4v-10.45a2.4 2.4 0 0 1 2.4 -2.4z" },
  "text_fields": { d: "M4.25 8.5v-3h15.5v3M12 5.5v14M8.75 19.5h6.5", f: "" },
  "water_drop": { d: "M11 4.9C8.9 7.2 5.9 10.4 5.9 13.8a6.1 6.1 0 0 0 12.2 0C18.1 10.4 15.1 7.2 13 4.9Q12 3.8 11 4.9z", f: "M11 4.9C8.9 7.2 5.9 10.4 5.9 13.8a6.1 6.1 0 0 0 12.2 0C18.1 10.4 15.1 7.2 13 4.9Q12 3.8 11 4.9z" },
  "exposure": { d: "M6.15 3.75h11.7a2.4 2.4 0 0 1 2.4 2.4v11.7a2.4 2.4 0 0 1 -2.4 2.4h-11.7a2.4 2.4 0 0 1 -2.4 -2.4v-11.7a2.4 2.4 0 0 1 2.4 -2.4zM7.5 9.25h5M10 6.75v5M12.5 16h4.5", f: "M6.15 3.75h11.7a2.4 2.4 0 0 1 2.4 2.4v11.7a2.4 2.4 0 0 1 -2.4 2.4h-11.7a2.4 2.4 0 0 1 -2.4 -2.4v-11.7a2.4 2.4 0 0 1 2.4 -2.4z" },
  "contrast": { d: "M3.75 12a8.25 8.25 0 1 0 16.5 0a8.25 8.25 0 1 0 -16.5 0M12 3.75a8.25 8.25 0 0 1 0 16.5z", f: "M3.75 12a8.25 8.25 0 1 0 16.5 0a8.25 8.25 0 1 0 -16.5 0M12 3.75a8.25 8.25 0 0 1 0 16.5z" },
  "thermostat": { d: "M14.2 13.6V6a2.2 2.2 0 0 0-4.4 0v7.6a4.2 4.2 0 1 0 4.4 0z M12 10v5.6", f: "" },
  "format_letter_spacing": { d: "M8.4 13.5L12 4.5l3.6 9M9.6 10.8h4.8M4 18.25h16M6.4 15.9L4 18.25l2.4 2.35M17.6 15.9L20 18.25l-2.4 2.35", f: "" },
  "restart_alt": { d: "M5 12a7 7 0 1 0 2.1-5M5 4.5V8h3.5", f: "" },
  "undo": { d: "M8.5 5 4.5 9l4 4M5 9h8.5a5.5 5.5 0 0 1 0 11H10", f: "" },
  "zoom_in": { d: "M4 10.5a6.5 6.5 0 1 0 13 0a6.5 6.5 0 1 0 -13 0M15.3 15.3L20 20M10.5 8v5M8 10.5h5", f: "" },
  "zoom_out": { d: "M4 10.5a6.5 6.5 0 1 0 13 0a6.5 6.5 0 1 0 -13 0M15.3 15.3L20 20M8 10.5h5", f: "" },
  "nav_create": { d: "M6.15 3.75h11.7a2.4 2.4 0 0 1 2.4 2.4v11.7a2.4 2.4 0 0 1 -2.4 2.4h-11.7a2.4 2.4 0 0 1 -2.4 -2.4v-11.7a2.4 2.4 0 0 1 2.4 -2.4zM12 8.3v7.4M8.3 12h7.4", f: "M6.15 3.75h11.7a2.4 2.4 0 0 1 2.4 2.4v11.7a2.4 2.4 0 0 1 -2.4 2.4h-11.7a2.4 2.4 0 0 1 -2.4 -2.4v-11.7a2.4 2.4 0 0 1 2.4 -2.4z" },
};
// legacy icons (not rebuilt): closed subpaths (ending in z, or full circles) get the active fill too
const LEGACY_FILL = (() => {
  const out = {};
  Object.keys(ICONS).forEach(k => {
    const parts = ICONS[k].split(/(?=M)/).filter(p => /z\s*$/i.test(p.trim()) || /^M[-\d.]+ [-\d.]+a([\d.]+) \1 0 1 0 [-\d.]+ 0a\1 \1 0 1 0 [-\d.]+ 0\s*$/.test(p.trim()) && Number(RegExp.$1) > 1.2);
    out[k] = parts.join("");
  });
  return out;
})();
// active = true -> the icon is selected: closed shapes get a 24% fill of the icon colour. Inactive icons are plain line icons.
function AppIcon({ name, size = 24, color = "#F2EBE7", active = false, style }) {
  const n = ICON_NEW[name];
  const d = n ? n.d : (ICONS[name] || ICONS.info);
  const f = active ? (n ? n.f : LEGACY_FILL[name]) : "";
  return (
    <View accessibilityLabel={name} style={[{ width: size, height: size }, style]}>
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        {!!f && <Path d={f} fill={color} fillOpacity={0.24} stroke="none" />}
        <Path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      </Svg>
    </View>
  );
}

// One tool card drawn only from transforms (top cap + stretchable middle + bottom cap),
// so its height can shrink on the native thread without touching layout.
function ToolCardShape({ bg, border, capHeight, radius, topY, midHeight, midScale, midY, bottomCapTop, capY, radiusOpen, openOpacity }) {
  // while the sheet opens, a second copy with squarer corners fades in over the first one (same corners as every other rectangle in the app)
  if (radiusOpen != null && openOpacity) {
    const one = { bg, border, capHeight, topY, midHeight, midScale, midY, bottomCapTop, capY };
    return (
      <>
        <ToolCardShape {...one} radius={radius} />
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: openOpacity }]}><ToolCardShape {...one} radius={radiusOpen} /></Animated.View>
      </>
    );
  }
  return (
    <>
      <View style={{ position: "absolute", left: 0, right: 0, top: 0, height: capHeight, backgroundColor: bg, borderColor: border, borderWidth: 1, borderBottomWidth: 0, borderTopLeftRadius: radius, borderTopRightRadius: radius }} />
      <Animated.View style={{ position: "absolute", left: 0, right: 0, top: topY, height: midHeight, backgroundColor: bg, borderColor: border, borderLeftWidth: 1, borderRightWidth: 1, transform: [{ translateY: midY }, { scaleY: midScale }] }} />
      <Animated.View style={{ position: "absolute", left: 0, right: 0, top: bottomCapTop, height: capHeight, backgroundColor: bg, borderColor: border, borderWidth: 1, borderTopWidth: 0, borderBottomLeftRadius: radius, borderBottomRightRadius: radius, transform: [{ translateY: capY }] }} />
    </>
  );
}

// =====================================================================================
//  EDITOR SHEET — shared state, helpers and the content of every tool tab
//  Everything that moves (thumbs, fills, segmented pills, press feedback, sheet pages)
//  is driven by Animated + useNativeDriver, so it never waits on the JS thread.
//  Slider drags only touch Animated.Values; React state is limited to tiny components
//  (the number label, the preview image/clock), never the whole App.
// =====================================================================================
const TRACK = "#4A413D";
const SL_PAD = 14;
const clamp = (v, a, b) => (v === v ? Math.max(a, Math.min(b, v)) : a); // NaN-safe
const ALIGN = { left: "flex-start", center: "center", right: "flex-end" };
const FONT_FAMILY = {
  sans: undefined,
  serif: Platform.select({ android: "serif", default: "Georgia" }),
  mono: Platform.select({ android: "monospace", default: "Menlo" }),
  condensed: Platform.select({ android: "sans-serif-condensed", default: "AvenirNextCondensed-Bold" })
};
// Downloaded fonts: every weight is its own registered family (so fontWeight is not used for them)
const CLOCK_FONT_FILES = {
  rounded: { 100: "Nunito_200ExtraLight", 300: "Nunito_300Light", 400: "Nunito_400Regular", 700: "Nunito_700Bold", 900: "Nunito_900Black" },
  grotesk: { 100: "SpaceGrotesk_300Light", 300: "SpaceGrotesk_300Light", 400: "SpaceGrotesk_400Regular", 700: "SpaceGrotesk_700Bold", 900: "SpaceGrotesk_700Bold" },
  tall: { 100: "Oswald_200ExtraLight", 300: "Oswald_300Light", 400: "Oswald_400Regular", 700: "Oswald_700Bold", 900: "Oswald_700Bold" },
  display: { 100: "PlayfairDisplay_400Regular", 300: "PlayfairDisplay_400Regular", 400: "PlayfairDisplay_400Regular", 700: "PlayfairDisplay_700Bold", 900: "PlayfairDisplay_900Black" },
  wide: { 100: "Unbounded_200ExtraLight", 300: "Unbounded_300Light", 400: "Unbounded_400Regular", 700: "Unbounded_700Bold", 900: "Unbounded_900Black" },
  quirk: { 100: "Syne_400Regular", 300: "Syne_400Regular", 400: "Syne_400Regular", 700: "Syne_700Bold", 900: "Syne_800ExtraBold" },
  bebas: { 100: "BebasNeue_400Regular", 300: "BebasNeue_400Regular", 400: "BebasNeue_400Regular", 700: "BebasNeue_400Regular", 900: "BebasNeue_400Regular" },
  script: { 100: "Caveat_400Regular", 300: "Caveat_400Regular", 400: "Caveat_400Regular", 700: "Caveat_700Bold", 900: "Caveat_700Bold" },
  maze: { 100: "RubikMaze_400Regular", 300: "RubikMaze_400Regular", 400: "RubikMaze_400Regular", 700: "RubikMaze_400Regular", 900: "RubikMaze_400Regular" },
  drip: { 100: "Nosifer_400Regular", 300: "Nosifer_400Regular", 400: "Nosifer_400Regular", 700: "Nosifer_400Regular", 900: "Nosifer_400Regular" }
};
const UI_FONT_ASSETS = {
  Manrope_400Regular: require("@expo-google-fonts/manrope/400Regular/Manrope_400Regular.ttf"),
  Manrope_600SemiBold: require("@expo-google-fonts/manrope/600SemiBold/Manrope_600SemiBold.ttf"),
  Manrope_700Bold: require("@expo-google-fonts/manrope/700Bold/Manrope_700Bold.ttf"),
  Manrope_800ExtraBold: require("@expo-google-fonts/manrope/800ExtraBold/Manrope_800ExtraBold.ttf"),
  Syne_400Regular: require("@expo-google-fonts/syne/400Regular/Syne_400Regular.ttf"),
  Syne_700Bold: require("@expo-google-fonts/syne/700Bold/Syne_700Bold.ttf"),
  Syne_800ExtraBold: require("@expo-google-fonts/syne/800ExtraBold/Syne_800ExtraBold.ttf"),
};
const CLOCK_FONT_ASSETS = {
  Nunito_200ExtraLight: require("@expo-google-fonts/nunito/200ExtraLight/Nunito_200ExtraLight.ttf"),
  Nunito_300Light: require("@expo-google-fonts/nunito/300Light/Nunito_300Light.ttf"),
  Nunito_400Regular: require("@expo-google-fonts/nunito/400Regular/Nunito_400Regular.ttf"),
  Nunito_700Bold: require("@expo-google-fonts/nunito/700Bold/Nunito_700Bold.ttf"),
  Nunito_900Black: require("@expo-google-fonts/nunito/900Black/Nunito_900Black.ttf"),
  SpaceGrotesk_300Light: require("@expo-google-fonts/space-grotesk/300Light/SpaceGrotesk_300Light.ttf"),
  SpaceGrotesk_400Regular: require("@expo-google-fonts/space-grotesk/400Regular/SpaceGrotesk_400Regular.ttf"),
  SpaceGrotesk_700Bold: require("@expo-google-fonts/space-grotesk/700Bold/SpaceGrotesk_700Bold.ttf"),
  Oswald_200ExtraLight: require("@expo-google-fonts/oswald/200ExtraLight/Oswald_200ExtraLight.ttf"),
  Oswald_300Light: require("@expo-google-fonts/oswald/300Light/Oswald_300Light.ttf"),
  Oswald_400Regular: require("@expo-google-fonts/oswald/400Regular/Oswald_400Regular.ttf"),
  Oswald_700Bold: require("@expo-google-fonts/oswald/700Bold/Oswald_700Bold.ttf"),
  PlayfairDisplay_400Regular: require("@expo-google-fonts/playfair-display/400Regular/PlayfairDisplay_400Regular.ttf"),
  PlayfairDisplay_700Bold: require("@expo-google-fonts/playfair-display/700Bold/PlayfairDisplay_700Bold.ttf"),
  PlayfairDisplay_900Black: require("@expo-google-fonts/playfair-display/900Black/PlayfairDisplay_900Black.ttf"),
  Unbounded_200ExtraLight: require("@expo-google-fonts/unbounded/200ExtraLight/Unbounded_200ExtraLight.ttf"),
  Unbounded_300Light: require("@expo-google-fonts/unbounded/300Light/Unbounded_300Light.ttf"),
  Unbounded_400Regular: require("@expo-google-fonts/unbounded/400Regular/Unbounded_400Regular.ttf"),
  Unbounded_700Bold: require("@expo-google-fonts/unbounded/700Bold/Unbounded_700Bold.ttf"),
  Unbounded_900Black: require("@expo-google-fonts/unbounded/900Black/Unbounded_900Black.ttf"),
  BebasNeue_400Regular: require("@expo-google-fonts/bebas-neue/400Regular/BebasNeue_400Regular.ttf"),
  Caveat_400Regular: require("@expo-google-fonts/caveat/400Regular/Caveat_400Regular.ttf"),
  Caveat_700Bold: require("@expo-google-fonts/caveat/700Bold/Caveat_700Bold.ttf"),
  RubikMaze_400Regular: require("@expo-google-fonts/rubik-maze/400Regular/RubikMaze_400Regular.ttf"),
  Nosifer_400Regular: require("@expo-google-fonts/nosifer/400Regular/Nosifer_400Regular.ttf"),
};
// Clock fonts are not needed on the home screen, so they load in the background after the first paint.
const clockFontsStore = createStore({ ready: false });
let clockFontsStarted = false;
function loadClockFonts() {
  if (clockFontsStarted) return;
  clockFontsStarted = true;
  loadFontAsync({ ...CLOCK_FONT_ASSETS, ...customFonts })
    .then(() => clockFontsStore.set({ ready: true }))
    .catch(() => { clockFontsStarted = false; });
}
const useClockFontsReady = () => useSyncExternalStore(clockFontsStore.sub, () => clockFontsStore.get().ready);
function resolveFont(font, weight) {
  if (customFonts[font] || String(font).startsWith("uf_")) return { fontFamily: font, fontWeight: "normal" }; // fonts.js + fonts picked from the device
  const files = CLOCK_FONT_FILES[font];
  if (files) return { fontFamily: files[weight] || files[400], fontWeight: "normal" };
  return { fontFamily: FONT_FAMILY[font], fontWeight: weight };
}
const numeralize = (s, mode) => (mode === "fa" ? s.replace(/[0-9]/g, c => String.fromCharCode(0x06F0 + Number(c)))
  : mode === "ar" ? s.replace(/[0-9]/g, c => String.fromCharCode(0x0660 + Number(c))) : s);

// ---------- tiny external store (so slider drags don't re-render the whole App) ----------
function createStore(initial) {
  let state = initial;
  const subs = new Set();
  return {
    get: () => state,
    set: (patch) => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; subs.forEach(f => f()); },
    sub: (f) => { subs.add(f); return () => subs.delete(f); }
  };
}

// ---------- fonts the user adds from the device (.ttf / .otf) ----------
// Each one is copied into the app's own folder, registered under an id like "uf_xxx" and listed after the built-in fonts.
const userFonts = createStore({ list: [] });
const UF_DIR = FS && FS.documentDirectory ? FS.documentDirectory + "userfonts/" : null;
const UF_INDEX = UF_DIR ? UF_DIR + "index.json" : null;
async function ufSaveIndex() {
  if (!UF_INDEX || !FS) return;
  try { await FS.writeAsStringAsync(UF_INDEX, JSON.stringify(userFonts.get().list)); } catch (e) { /* ignore */ }
}
async function ufInit() {   // on app start: register the fonts added earlier
  if (!UF_INDEX || !FS) return;
  try {
    const info = await FS.getInfoAsync(UF_INDEX);
    if (!info.exists) return;
    const saved = JSON.parse(await FS.readAsStringAsync(UF_INDEX));
    const ok = [];
    for (const f of Array.isArray(saved) ? saved : []) {
      try { await loadFontAsync({ [f.id]: f.uri }); ok.push(f); } catch (e) { /* ignore */ }
    }
    userFonts.set({ list: ok });
  } catch (e) { /* ignore */ }
}
async function addUserFont() {   // returns the new font id, or null
  if (!DocPicker || !DocPicker.getDocumentAsync) { Alert.alert("Can't add fonts yet", "Install expo-document-picker (npx expo install expo-document-picker) and rebuild the app."); return null; }
  let res;
  try { res = await DocPicker.getDocumentAsync({ type: "*/*", copyToCacheDirectory: true, multiple: false }); } catch (e) { return null; }
  if (!res || res.canceled || !res.assets || !res.assets.length) return null;
  const a = res.assets[0];
  const m = String(a.name || "").match(/\.(ttf|otf)$/i);
  if (!m) { Alert.alert("Unsupported file", "Please choose a .ttf or .otf font file."); return null; }
  const id = "uf_" + Date.now().toString(36);
  let uri = a.uri;
  if (UF_DIR && FS) {
    try { await FS.makeDirectoryAsync(UF_DIR, { intermediates: true }); } catch (e) { /* ignore */ }
    try { const dest = UF_DIR + id + "." + m[1].toLowerCase(); await FS.copyAsync({ from: a.uri, to: dest }); uri = dest; } catch (e) { /* ignore */ }
  }
  try { await loadFontAsync({ [id]: uri }); } catch (e) { Alert.alert("Can't use this font", "The file could not be loaded as a font."); return null; }
  const name = String(a.name).replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim().slice(0, 22) || "My font";
  userFonts.set(s0 => ({ list: [...s0.list, { id, name, uri }] }));
  ufSaveIndex();
  return id;
}
const useUserFonts = () => useSyncExternalStore(userFonts.sub, () => userFonts.get().list);

const FX_DEFAULT = { exposure: 0, contrast: 0, saturation: 0, warmth: 0, tint: 0, fade: 0, vignette: 0, blur: 0 };
// Every property below has a matching control on the "Your design" page.
const CLOCK_CLASSIC = {
  layout: "inline", font: "sans", weight: "300", size: 100, spacing: -3, showDate: "on", dateSize: 9, align: "center", top: 17, opacity: 100, shadow: 0,
  look: "solid",      // solid | glass  (glass is fully independent: it ignores every option below)
  // ---- independent, combinable looks (all of them work together, except with glass) ----
  strokeOn: "off",    // stroke added around the digits
  strokeColor: "#000000",
  strokeOpacity: 100, // 0-100, applies to the stroke colour and to the stroke fade
  fadeOn: "off",      // gradient on the digits
  fadeC1: "#FFFFFF", fadeC2: "#D0BCFF", fadeAngle: 180, fadeScope: "all",   // scope: all (whole clock) | each (every digit)
  fadeStops: null,    // optional list of 2-6 colours (wallpaper meta.json); when set it replaces fadeC1 / fadeC2
  sFadeOn: "off",     // separate gradient for the stroke
  sC1: "#FF4B3E", sC2: "#FDD663", sAngle: 180, sScope: "all", sStops: null,
  toneA: "",          // two-tone: colour of the digits that are NOT the accent ("" = clock colour)
  glass: 50,         // glass body opacity 0-100 (iOS 26 "Glass" slider)
  glassBlur: 35,      // blur of the wallpaper seen through the digits (0 = none)
  glassAngle: 315,    // direction the light comes FROM, degrees (0 top, 90 right, 180 bottom, 270 left)
  glassEdge: 60,      // opacity of the edge light (white, lit side) and dark edge (black, opposite side): 0 hidden, 100 solid
  glassEdgeW: 50,     // thickness of those two edges
  glassStrokeOn: "off",     // on | off   stroke around every glass digit (own colour / width / opacity)
  glassStrokeColor: "#FFFFFF",
  glassStrokeW: 1.5,        // stroke width 1-12 (same scale as "stroke")
  glassStrokeOpacity: 60,   // 0-100
  glassLight: "on",      // on | off   light edge (white, on the side the light comes from)
  glassLightSides: "one",// one (lit side only) | both (also on the opposite side, instead of the dark edge)
  glassLightA: null, glassLightW: null,  // own opacity / thickness 0-100 (null = follow glassEdge / glassEdgeW)
  glassDark: "on",       // on | off    dark edge (black, on the side opposite to the light)
  glassDarkSides: "one", // one (opposite side only) | both (also on the lit side)   -> where both want a side, the light edge wins
  glassDarkA: null, glassDarkW: null,
  glassBlend: "normal", // normal | overlay: how the blurred wallpaper inside the digits is mixed with the sharp wallpaper under it
  glassBlendAmt: 100,   // 0-100 strength of that blend (only used by "overlay")
  stroke: 2,          // stroke width
  stretch: 100,       // vertical stretch % (iOS 26 tall clock)
  lineGap: 0,         // gap between hour / minute lines when stacked
  twoTone: "off",     // minutes in the accent colour (HyperOS multi-colour digits)
  accent: "#D0BCFF",
  numerals: "latn",   // latn | fa | ar
  dotShape: "round", ghost: "on",  // dot-matrix font only
  arrange: "flow",    // flow | stairs | vertical | split | column | giant | mixsize | orbit | arc | scatter
  hours: "on",        // on ("09:41", 4 digits - app default) | off ("9:41") | auto
  sep: "colon",       // colon | dot | none           -> clock with / without the two dots
  dateStyle: "line",  // line | split | day | stack
  datePos: "above",   // above | below | left | right of the clock (flow arrangement)
  dateRot: "none",    // none | up | down  (date turned sideways next to the clock, flow)
  dateSide: "left",   // left | right of the clock when the date is turned
  dateGap: 6,         // distance between clock and date
  // the date is drawn by the clock renderer, so it inherits every look of the clock; these are its own settings:
  dateCal: "gregorian",   // gregorian | jalali (Shamsi) | hijri
  dateWhat: "all",        // all | weekday | date (day / month / year)
  dateOrder: "dmy",       // gregorian only, horizontal date: dmy | mdy | ymd | ydm
  dateVOrder: "dmy",      // vertical date, top to bottom: dmy (day / month / year) | ymd (year / month / day)
  dateMonth: "name",      // name | short | number (number = every part numeric)
  dateWeekday: "full",    // full | short
  dateDir: "horizontal",  // horizontal | vertical (one letter / digit per line)
  dateStretch: 100, dateWidthScale: 100, dateRotate: 0,
  dateSpacing: 1,     // date letter spacing
  seconds: "off",     // third group "50" (HH / MM / SS)
  toneOn: "min",      // min | hour  -> which part gets the accent colour
  groupGap: 0,        // extra gap between hour / minute / second groups (inline)
  lineShift: 0,       // horizontal shift of every following line (stacked)
  widthScale: 100,    // horizontal stretch %
  rotate: 0, skew: 0, // whole clock rotation / italic slant (degrees)
  offsetX: 0, offsetY: 0, // move the clock (% of the screen width)
  panel: "off", panelTone: "dark", panelOpacity: 35, panelRadius: 18, panelPad: 14 // box behind the clock
};
const CLOCK_STYLES = [
  // --- iPhone (iOS 26 Liquid Glass / Solid) ---
  { id: "glass", name: "Glass", d: { ...CLOCK_CLASSIC, look: "glass", font: "rounded", weight: "700", size: 112, spacing: -2, glass: 45, glassBlur: 35, glassAngle: 315, glassEdge: 60, glassStrokeOn: "on", glassStrokeW: 1.5, glassStrokeOpacity: 32, top: 14 } },
  { id: "tallglass", name: "Tall Glass", d: { ...CLOCK_CLASSIC, look: "glass", layout: "stacked", font: "tall", weight: "700", size: 100, stretch: 135, spacing: 0, glass: 40, glassBlur: 25, glassAngle: 315, glassEdge: 70, glassStrokeOn: "on", glassStrokeW: 1.4, glassStrokeOpacity: 29, lineGap: 2, top: 10, dateStyle: "day" } },
  { id: "clearglass", name: "Clear Glass", d: { ...CLOCK_CLASSIC, look: "glass", font: "rounded", weight: "300", size: 150, spacing: -3, glass: 12, glassBlur: 10, glassAngle: 315, glassEdge: 80, glassStrokeOn: "on", glassStrokeW: 1.9, glassStrokeOpacity: 46, top: 15, hours: "on", sep: "none", showDate: "off" } },
  { id: "frost", name: "Frost", d: { ...CLOCK_CLASSIC, look: "glass", layout: "stacked", font: "rounded", weight: "900", size: 120, spacing: -1, glass: 78, glassBlur: 80, glassAngle: 315, glassEdge: 45, glassStrokeOn: "on", glassStrokeW: 1.2, glassStrokeOpacity: 22, shadow: 10, align: "left", top: 12, dateStyle: "split", datePos: "below" } },
  { id: "rounded", name: "Rounded", d: { ...CLOCK_CLASSIC, font: "rounded", weight: "700", size: 128, spacing: -2, hours: "on", showDate: "off", top: 16 } },
  { id: "editorial", name: "Editorial", d: { ...CLOCK_CLASSIC, layout: "stacked", font: "display", weight: "400", size: 124, spacing: -2, lineGap: -4, align: "left", top: 12, dateStyle: "split", datePos: "below" } },
  // --- Xiaomi HyperOS (Rhombus two-tone digits, Magazine cover) ---
  { id: "rhombus", name: "Rhombus", d: { ...CLOCK_CLASSIC, layout: "stacked", weight: "900", size: 96, spacing: -2, twoTone: "on", accent: "#FDD663", align: "left", top: 12, dateStyle: "day" } },
  { id: "magazine", name: "Magazine", d: { ...CLOCK_CLASSIC, layout: "stacked", font: "tall", weight: "700", size: 140, stretch: 112, spacing: 0, lineGap: -6, top: 9, showDate: "off" } },
  // --- Nothing (dot matrix, Metro-style grotesk) ---
  { id: "dots", name: "Dot Matrix", d: { ...CLOCK_CLASSIC, font: "dots", size: 120, spacing: 0, twoTone: "on", accent: "#FF4B3E", top: 16 } },
  { id: "dotstack", name: "Dot Stack", d: { ...CLOCK_CLASSIC, layout: "stacked", font: "dots", size: 140, spacing: 0, dotShape: "square", align: "left", top: 12, showDate: "off" } },
  { id: "metro", name: "Metro", d: { ...CLOCK_CLASSIC, font: "grotesk", weight: "700", size: 118, spacing: -2, twoTone: "on", accent: "#FF4B3E", hours: "on", sep: "none", dateStyle: "split", datePos: "below" } },
  // --- OnePlus (full-width stretched clock, One Serif) ---
  { id: "fullstretch", name: "Full Stretch", d: { ...CLOCK_CLASSIC, layout: "stacked", font: "tall", weight: "700", size: 150, stretch: 125, spacing: 0, lineGap: -8, top: 8, showDate: "off" } },
  { id: "oneserif", name: "One Serif", d: { ...CLOCK_CLASSIC, font: "display", weight: "700", size: 100, spacing: -1, top: 15, dateStyle: "day", datePos: "below", hours: "off" } },
  // --- generic ---
  { id: "persian", name: "Persian", d: { ...CLOCK_CLASSIC, numerals: "fa", weight: "300", size: 112, spacing: 0, hours: "off" } },
  // --- wide / quirky type (Unbounded, Syne) ---
  { id: "wide", name: "Wide", d: { ...CLOCK_CLASSIC, font: "wide", weight: "700", size: 110, spacing: -2, top: 15, hours: "off" } },
  { id: "widestack", name: "Wide Stack", d: { ...CLOCK_CLASSIC, layout: "stacked", font: "wide", weight: "900", size: 120, spacing: -3, align: "left", top: 12, lineGap: -2, dateStyle: "split", datePos: "below" } }
];
const CLOCK_COLORS = ["#FFFFFF", "#D0BCFF", "#8AB4F8", "#81C995", "#FDD663", "#F28BCB", "#0B0B0F"];

const FX_PRESETS = [
  ["original", "Original", {}],
  ["vivid", "Vivid", { exposure: 4, contrast: 14, saturation: 38 }],
  ["warm", "Warm", { exposure: 6, warmth: 48, saturation: 12 }],
  ["cool", "Cool", { exposure: 2, warmth: -46, contrast: 8 }],
  ["cinema", "Cinema", { contrast: 24, saturation: -14, warmth: -16, tint: 6, fade: 8, vignette: 38 }],
  ["vintage", "Vintage", { contrast: -8, saturation: -26, warmth: 30, fade: 42, vignette: 26 }],
  ["matte", "Matte", { contrast: -10, saturation: -10, fade: 32 }],
  ["dream", "Dreamy", { exposure: 12, contrast: -14, saturation: 12, tint: 10, fade: 20 }],
  ["noir", "Noir", { saturation: -100, contrast: 30, vignette: 36 }],
  ["sunset", "Sunset", { exposure: -4, contrast: 10, warmth: 64, tint: 10, vignette: 20 }]
].map(([id, name, fx]) => ({ id, name, fx: { ...FX_DEFAULT, ...fx } }));

const FX_TOOLS = [
  ["exposure", "Exposure", "exposure", -100, 100, true],
  ["contrast", "Contrast", "contrast", -100, 100, true],
  ["saturation", "Saturation", "water_drop", -100, 100, true],
  ["warmth", "Warmth", "thermostat", -100, 100, true],
  ["tint", "Tint", "colorize", -100, 100, true],
  ["fade", "Fade", "tonality", 0, 100, false],
  ["vignette", "Vignette", "vignette", 0, 100, false],
  ["blur", "Blur", "blur_on", 0, 100, false]
];

const makeEditorState = () => ({
  fx: { ...FX_DEFAULT }, presetId: "original",
  adjust: { scale: 100, x: 0, y: 0, rotate: 0 },
  parallax: { speed: 50, amount: 40 },
  clockId: "glass", custom: null, clockColor: "#FFFFFF",
  cm: { x: 0, y: 0, s: 1 }, // clock placed by the user: move (fraction of width / height) and scale
  rc: null,                 // position / size of the wallpaper's own (remote) clock: { x, y, size } or null = as designed
  depth: {}   // layer id -> "over" | "under" (filled by the Depth analysis)
});
const editor = createStore(makeEditorState());
function useEditor(selector) { return useSyncExternalStore(editor.sub, () => selector(editor.get())); }

// Real depth analysis (one wallpaper at a time). layers: [{ id, label, area, nearness, color, mask }] nearest first.
const makeDepthState = () => ({ uri: null, status: "idle", progress: "", layers: [], displayUri: null, job: null, error: null });
const depthStore = createStore(makeDepthState());
function useDepth(selector) { return useSyncExternalStore(depthStore.sub, () => selector(depthStore.get())); }
// layers that sit in front of the clock, as the core expects them (above = Over)
const depthLayersWithPos = (layers, pos) => layers.map(l => ({ ...l, above: pos[l.id] === "over" }));
async function startDepthAnalysis(uri) {
  if (!DepthCore) { Alert.alert("Depth needs a native build", "Install a Zharph Android build (not Expo Go) to analyze depth."); return; }
  depthStore.set({ ...makeDepthState(), uri, status: "scanning", progress: "Preparing image..." });
  try {
    const { photo, displayUri, job } = await DepthCore.tools.prepareImage(uri);
    try { photo && photo.dispose && photo.dispose(); } catch (e) { /* ignore */ }
    if (depthStore.get().uri !== uri) return;               // another wallpaper was opened meanwhile
    depthStore.set({ displayUri, job });
  } catch (e) {
    if (depthStore.get().uri === uri) depthStore.set({ status: "error", error: String((e && e.message) || e), job: null });
  }
}
// Invisible: runs the AI engine only while a job exists, then unmounts it (frees the models)
function DepthRunner() {
  const job = useDepth(s => s.job);
  if (!DepthCore || !job) return null;
  const Engine = DepthCore.Engine;
  return (
    <Engine
      job={job}
      onProgress={(p) => depthStore.set({ progress: DepthCore.tools.describeProgress(p) })}
      onResult={(r) => {
        try {
          const layers = DepthCore.tools.buildLayerList(r);
          const pos = {};
          layers.forEach((l, i) => { pos[l.id] = i === 0 ? "over" : "under"; });   // nearest layer in front of the clock
          depthStore.set({ layers, status: layers.length ? "done" : "error", error: layers.length ? null : "No layers found", job: null });
          editor.set({ depth: pos });
        } catch (e) { depthStore.set({ status: "error", error: String((e && e.message) || e), job: null }); }
      }}
      onError={(e) => depthStore.set({ status: "error", error: String((e && e.message) || e), job: null })}
    />
  );
}
// Apply: sets the Zharph live wallpaper (photo + clock position + foreground mask of the Over layers)
async function applyToPhone(uri) {
  if (Platform.OS !== "android") { Alert.alert("Android only", "The live wallpaper is available on Android."); return false; }
  if (!DepthCore) { Alert.alert("Needs a native build", "Install a Zharph Android build (not Expo Go) to apply wallpapers."); return false; }
  const d = depthStore.get(), e = editor.get();
  const mine = d.uri === uri && d.layers.length > 0;
  try {
    const mask = mine ? DepthCore.tools.encodeForegroundMask({ layers: depthLayersWithPos(d.layers, e.depth) }) : null;
    const clock = { nx: clamp(0.18 + e.cm.x, 0, 1), ny: clamp(0.07 + e.cm.y, 0, 1), calendar: e.clockId === "persian" ? "persian" : "gregorian" };
    await DepthCore.wp.applyWallpaperWithMask(mine && d.displayUri ? d.displayUri : uri, clock, mask, { edgeSharpness: 3 });
    return true;
  } catch (err) { Alert.alert("Couldn't apply wallpaper", String((err && err.message) || err)); return false; }
}
// wallpaper transform (Adjust tab) lives in native Animated values: no React render while dragging
const motion = { scale: new Animated.Value(1), tx: new Animated.Value(0), ty: new Animated.Value(0), rot: new Animated.Value(0) };
const motionRot = motion.rot.interpolate({ inputRange: [-180, 180], outputRange: ["-180deg", "180deg"] });   // wallpaper rotation (Adjust)
function resetEditor() {
  editor.set(makeEditorState());
  motion.scale.setValue(1); motion.tx.setValue(0); motion.ty.setValue(0); motion.rot.setValue(0);
  depthStore.set(makeDepthState());
}
// ---------- Undo / Redo (last 30 steps of everything done on the Edit wallpaper page) ----------
// Every change goes through `editor`, so history simply watches the store: when the changes stop for a moment
// (a whole slider drag / colour pick = one step) the new state is pushed on the undo stack.
const HIST_MAX = 30;
const histStore = createStore({ rev: 0, canUndo: false, canRedo: false });
const previewDims = { w: 315, h: 682 };          // set by <App/> (needed to rebuild the Adjust offsets)
const HIST_KEYS = ["fx", "presetId", "adjust", "parallax", "clockId", "custom", "clockColor", "cm", "rc", "depth"];
const histSnap = (s) => { const o = {}; HIST_KEYS.forEach(k => { o[k] = s[k]; }); return o; };
const histSame = (a, b) => HIST_KEYS.every(k => a[k] === b[k] || JSON.stringify(a[k]) === JSON.stringify(b[k]));
const hist = { past: [], future: [], present: histSnap(editor.get()), timer: null, applying: false };
function histFlags() { histStore.set({ canUndo: hist.past.length > 0, canRedo: hist.future.length > 0 }); }
function histCommit() {
  if (hist.timer) { clearTimeout(hist.timer); hist.timer = null; }
  const cur = histSnap(editor.get());
  if (histSame(cur, hist.present)) { histFlags(); return; }
  hist.past.push(hist.present);
  if (hist.past.length > HIST_MAX) hist.past.shift();
  hist.present = cur; hist.future = [];
  histFlags();
}
editor.sub(() => {
  if (hist.applying) return;
  if (hist.timer) clearTimeout(hist.timer);
  hist.timer = setTimeout(histCommit, 450);
  const f = histStore.get();
  if (!f.canUndo || f.canRedo) histStore.set({ canUndo: true, canRedo: false }); // buttons react at once, before the step is stored
});
function histReset() {            // new editing session
  if (hist.timer) { clearTimeout(hist.timer); hist.timer = null; }
  hist.past = []; hist.future = []; hist.present = histSnap(editor.get());
  histStore.set(s => ({ rev: s.rev + 1, canUndo: false, canRedo: false }));
}
function histMark() { histCommit(); return { past: hist.past.slice(), present: hist.present }; }
function histRollback(m) {        // "Back" on the colour page: its live changes are discarded, so they leave no steps behind
  if (hist.timer) { clearTimeout(hist.timer); hist.timer = null; }
  hist.past = m.past.slice(); hist.future = []; hist.present = histSnap(editor.get());
  histFlags();
}
function histApply(snap) {
  hist.applying = true;
  editor.set({ ...snap });
  hist.applying = false;
  const a = snap.adjust;
  motion.scale.setValue(a.scale / 100);
  motion.tx.setValue((a.x / 100) * (previewDims.w / 2));
  motion.ty.setValue(-(a.y / 100) * (previewDims.h / 2));
  motion.rot.setValue(a.rotate || 0);
  histStore.set(s => ({ rev: s.rev + 1 }));   // sliders / fields re-read their values
  histFlags();
}
function undo() {
  histCommit();
  if (!hist.past.length) return;
  hist.future.push(hist.present);
  hist.present = hist.past.pop();
  histApply(hist.present);
}
function redo() {
  histCommit();
  if (!hist.future.length) return;
  hist.past.push(hist.present);
  if (hist.past.length > HIST_MAX) hist.past.shift();
  hist.present = hist.future.pop();
  histApply(hist.present);
}
function useHistRev() { return useSyncExternalStore(histStore.sub, () => histStore.get().rev); }
function useHistFlags() { return useSyncExternalStore(histStore.sub, () => { const s = histStore.get(); return (s.canUndo ? 1 : 0) + (s.canRedo ? 2 : 0); }); }

// ---------- zoom-to-clock preview (view only: it is not an edit and is not part of the history) ----------
const ZOOM_LEVEL = 1.65;   // zoom-to-clock factor: the same for every wallpaper
const zoomView = { s: new Animated.Value(1), tx: new Animated.Value(0), ty: new Animated.Value(0) };
const zoomNow = { z: 1, ty: 0, maxY: 0, fit: 1, p: 0, avail: 340 };   // fit = preview scale when the sheet is open, p = sheet progress (0..1)
const fitNow = () => 1 + (zoomNow.fit - 1) * zoomNow.p;                       // scale the preview has because of the open sheet
const viewScaleNow = () => Math.max(0.2, fitNow() * (zoomNow.z || 1));        // total on-screen scale of the preview: finger moves are divided by it         // z is also used by the clock drag handles (the preview is scaled, so finger moves are divided by z)
const clockCenter = { x: 0.5, y: 0.3 };            // centre of the clock in the preview (fraction of width / height)
function zoomTo(on) {
  // zoom only as far as the framed preview still fits the screen width (a little empty space stays on the left and right)
  const W = previewDims.w, H = previewDims.h, z = on ? ZOOM_LEVEL : 1;
  const maxY = ((z - 1) * H) / 2;
  const tx = 0;
  const ty = on ? clamp(-z * (clockCenter.y - 0.5) * H, -maxY, maxY) : 0;
  zoomNow.z = z; zoomNow.ty = ty; zoomNow.maxY = maxY;
  [zoomView.s, zoomView.tx, zoomView.ty].forEach(v => v.stopAnimation());
  const cfg = { duration: 250, easing: EASE_OUT, useNativeDriver: true };
  Animated.parallel([
    Animated.timing(zoomView.s, { toValue: z, ...cfg }),
    Animated.timing(zoomView.tx, { toValue: tx, ...cfg }),
    Animated.timing(zoomView.ty, { toValue: ty, ...cfg })
  ]).start();
}
function zoomReset() {
  [zoomView.s, zoomView.tx, zoomView.ty].forEach(v => v.stopAnimation());
  zoomView.s.setValue(1); zoomView.tx.setValue(0); zoomView.ty.setValue(0);
  zoomNow.z = 1; zoomNow.ty = 0; zoomNow.maxY = 0;
}
const CLOCK_ASPECT = 19.5 / 9; // preview height / width
// older saved designs used look: "fade"; that is now an independent switch
function normDesign(d0) {
  const d = { ...CLOCK_CLASSIC, ...d0, arrange: "flow" }; // only the horizontal / stacked layouts remain
  if (d0.glassOutline != null) {   // older designs: the glass "full outline" became the glass stroke
    const o = d0.glassOutline / 100;
    if (d0.glassStrokeOn == null) { d.glassStrokeOn = o > 0 ? "on" : "off"; d.glassStrokeW = Math.round((1 + 2 * o) * 10) / 10; d.glassStrokeOpacity = Math.round(15 + 70 * o); }
    delete d.glassOutline;
  }
  if (d.hours === "auto") d.hours = d.layout === "stacked" ? "on" : "off";   // the removed \"Auto\" option
  if (d.look === "outline") d.look = "solid";
  else if (d.look === "fade") { d.look = "solid"; d.fadeOn = "on"; }
  if (d.dateRot === "up" || d.dateRot === "down") { d.dateRotate = d.dateRotate || (d.dateRot === "up" ? -90 : 90); d.dateRot = "none"; }   // older designs
  return d;
}
// does this design need the SVG renderer? (glass, or any of stroke / fade)
const isStyledLook = (d) => d.font !== "dots" && (d.look === "glass" || d.strokeOn === "on" || d.fadeOn === "on");
const fin = (v, f = 0) => (typeof v === "number" && isFinite(v) ? v : f);   // never hand NaN / Infinity to the native side
function applyClockMove(d0, cm) {
  const d = normDesign(d0);
  if (!cm || (cm.x === 0 && cm.y === 0 && cm.s === 1)) return d;
  const s = fin(cm.s, 1);
  return {
    ...d,
    stroke: d.stroke * s, glassStrokeW: d.glassStrokeW * s,
    offsetX: d.offsetX + cm.x * 100, offsetY: d.offsetY + cm.y * 100 * CLOCK_ASPECT,
    size: d.size * s, spacing: d.spacing * s, dateSize: d.dateSize * s, dateGap: d.dateGap * s, dateSpacing: d.dateSpacing * s,
    lineGap: d.lineGap * s, groupGap: d.groupGap * s, lineShift: d.lineShift * s, shadow: d.shadow * s,
    panelPad: d.panelPad * s, panelRadius: d.panelRadius * s
  };
}
function useActiveDesign() {
  const id = useEditor(s => s.clockId);
  const custom = useEditor(s => s.custom);
  if (id === "custom" && custom) return custom;
  return (CLOCK_STYLES.find(x => x.id === id) || CLOCK_STYLES[0]).d;
}

// ---------- color helpers ----------
function hsvToHex(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    const c = v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, "0");
  };
  return ("#" + f(5) + f(3) + f(1)).toUpperCase();
}
function hexToHsv(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}
const textOn = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) > 150 ? "#100E0E" : "#FFFFFF";
};

// ---------- small building blocks ----------
// Pressable with native-thread press feedback (same feel as the tool cards)
const Press = memo(function Press({ onPress, style, children, scaleTo = 0.97, dim = false, wrapStyle }) {
  const sc = useRef(new Animated.Value(1)).current;
  const op = useRef(new Animated.Value(1)).current;
  return (
    <Pressable
      onPress={onPress}
      style={wrapStyle}
      onPressIn={() => {
        sc.stopAnimation(); Animated.timing(sc, { toValue: scaleTo, duration: 90, easing: EASE_OUT, useNativeDriver: true }).start();
        if (dim) { op.stopAnimation(); Animated.timing(op, { toValue: 0.88, duration: 90, easing: EASE_OUT, useNativeDriver: true }).start(); }
      }}
      onPressOut={() => {
        sc.stopAnimation(); Animated.spring(sc, { toValue: 1, ...SPRING }).start();
        if (dim) { op.stopAnimation(); Animated.timing(op, { toValue: 1, duration: 160, easing: EASE_OUT, useNativeDriver: true }).start(); }
      }}
    >
      <Animated.View style={[style, dim && { opacity: op }, { transform: [{ scale: sc }] }]}>{children}</Animated.View>
    </Pressable>
  );
});

// Segmented control with a sliding pill (native driver).
// The pill is neutral on purpose: coral is kept for "on" switches, selected cards and the main action.
const SEG_PILL = "#3B3330";
// accent: the old coral pill, kept for the Settings page so only the editor changes look
const Seg = memo(function Seg({ options, value, onChange, height = 32, width, accent = false }) {
  const [W, setW] = useState(0);
  const idx = Math.max(0, options.findIndex(o => o[0] === value));
  const a = useRef(new Animated.Value(idx)).current;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; a.setValue(idx); return; }
    Animated.spring(a, { toValue: idx, ...SPRING }).start();
  }, [idx, a]);
  const segW = W > 0 ? (W - 6) / options.length : 0;
  return (
    <View onLayout={e => setW(e.nativeEvent.layout.width)} style={[st.seg, accent && { backgroundColor: C.surface, borderColor: C.outline }, { height, borderRadius: R.sm }, width != null && { width }]}>
      {segW > 0 && <Animated.View pointerEvents="none" style={{ position: "absolute", left: 2, top: 2, width: segW, height: height - 6, borderRadius: R.sm - 2, backgroundColor: accent ? C.primary : SEG_PILL, transform: [{ translateX: a.interpolate({ inputRange: [0, 1], outputRange: [0, segW] }) }] }} />}
      {options.map(([v, label]) => (
        <Pressable key={v} onPress={() => onChange(v)} style={st.segItem}>
          <Text numberOfLines={1} style={[st.segText, v === value && { color: accent ? C.onPrimary : C.text }]}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
});

// Ruler slider (one setting = one row):  icon tile · label · reset · value chip · chevron.
// Tap the row to open it: a short ruler with  −  and  +  on both sides. Drag the ruler (it keeps gliding after a flick),
// or hold − / + to repeat. Tap the value chip while the row is open to type a number by hand.
const RULER_FADE = "#141111";   // colour of the open area (C.surface darkened); the ruler edges fade into it
const RULER_GAP = 7;            // px between two ticks
const RULER_H = 40;
let RULER_ID = 0;
const RulerTicks = memo(function RulerTicks({ min, max, tu }) {
  const n = Math.round((max - min) / tu);
  let minor = "", major = "";
  for (let i = 0; i <= n; i++) {
    const x = i * RULER_GAP + 1;
    if (i % 5 === 0) major += "M" + x + " 9v22"; else minor += "M" + x + " 15v10";
  }
  return (
    <Svg width={n * RULER_GAP + 2} height={RULER_H}>
      <Path d={minor} stroke={C.muted} strokeOpacity={0.4} strokeWidth={2} strokeLinecap="round" />
      <Path d={major} stroke={C.muted} strokeOpacity={0.85} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
});
const RulerFade = memo(function RulerFade({ W }) {
  const id = useRef("rf" + (++RULER_ID)).current;
  const fw = Math.min(70, W * 0.32);
  return (
    <Svg pointerEvents="none" width={W} height={RULER_H} style={StyleSheet.absoluteFill}>
      <Defs>
        <LinearGradient id={id + "l"} x1="0" y1="0" x2="1" y2="0"><Stop offset="0" stopColor={RULER_FADE} stopOpacity="1" /><Stop offset="1" stopColor={RULER_FADE} stopOpacity="0" /></LinearGradient>
        <LinearGradient id={id + "r"} x1="0" y1="0" x2="1" y2="0"><Stop offset="0" stopColor={RULER_FADE} stopOpacity="0" /><Stop offset="1" stopColor={RULER_FADE} stopOpacity="1" /></LinearGradient>
      </Defs>
      <Rect x={0} y={0} width={fw} height={RULER_H} fill={"url(#" + id + "l)"} />
      <Rect x={W - fw} y={0} width={fw} height={RULER_H} fill={"url(#" + id + "r)"} />
    </Svg>
  );
});

const ValueSlider = memo(function ValueSlider({ label, icon, min, max, initial, def, centered = false, signed = false, suffix = "", showLabel = false, onChange }) {
  initial = clamp(Math.round(isFinite(initial) ? initial : min), min, max);   // whole numbers only, never decimals
  def = Math.round(isFinite(def) ? def : min);
  const [W, setW] = useState(0);
  const [val, setVal] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const tu = (max - min) > 220 ? 5 : 1;       // one tick = 1 unit (5 units on very long ranges)
  const ppu = RULER_GAP / tu;                  // px per unit
  const geo = useRef({}); geo.current = { min, max, tu, ppu, span: (max - min) * ppu };
  // haptic tick only on the long ruler marks (every 5th tick), not on every value
  const tickIf = useRef((v) => { const g = geo.current; if ((v - g.min) % (g.tu * 5) === 0) rulerTick(); }).current;
  const x = useRef(new Animated.Value(0)).current;           // translateX of the ruler strip
  const valRef = useRef(initial);
  const offRef = useRef((initial - min) * ppu);              // scroll offset in px (0 = min)
  const WRef = useRef(0); WRef.current = W;
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const startRef = useRef(0);
  const raf = useRef(null);
  const hold = useRef({ t: null, i: null }).current;

  const stopMomentum = useRef(() => { if (raf.current) { cancelAnimationFrame(raf.current); raf.current = null; } }).current;
  const stopHold = useRef(() => { clearTimeout(hold.t); clearInterval(hold.i); hold.t = null; hold.i = null; }).current;
  useEffect(() => () => { stopMomentum(); stopHold(); }, [stopMomentum, stopHold]);

  useEffect(() => { if (W > 0) x.setValue(W / 2 - offRef.current); }, [W, x]);

  // move the ruler to scroll offset o (px) and report the value
  const place = useRef((o) => {
    const g = geo.current;
    const c = clamp(o, 0, g.span);
    offRef.current = c;
    x.setValue(WRef.current / 2 - c);
    const v = clamp(Math.round(g.min + c / g.ppu), g.min, g.max);
    if (v !== valRef.current) { valRef.current = v; setVal(v); tickIf(v); onChangeRef.current(v); }
    return c;
  }).current;
  // glide to the exact tick of the current value
  const settle = useRef((animated) => {
    const g = geo.current;
    const o = (valRef.current - g.min) * g.ppu;
    offRef.current = o;
    x.stopAnimation();
    const to = WRef.current / 2 - o;
    if (animated) Animated.timing(x, { toValue: to, duration: 120, easing: EASE_OUT, useNativeDriver: true }).start(); else x.setValue(to);
  }).current;
  const setFromValue = (raw, animated = true) => {
    const g = geo.current;
    const v = clamp(Math.round(raw), g.min, g.max);
    const changed = v !== valRef.current;
    valRef.current = v; setVal(v);
    settle(animated);
    if (changed) onChangeRef.current(v);
  };
  const fling = useRef((v0) => {
    let v = v0 * 16;                                   // px per frame
    if (Math.abs(v) < 0.6) { settle(true); return; }
    let last = Date.now();
    const step = () => {
      const now = Date.now(), k = Math.min(3, (now - last) / 16); last = now;
      v *= Math.pow(0.94, k);
      const c = place(offRef.current + v * k);
      if (Math.abs(v) < 0.35 || c <= 0 || c >= geo.current.span) { raf.current = null; settle(true); return; }
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  }).current;

  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 3 && Math.abs(g.dx) > Math.abs(g.dy) * 1.2,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => { stopMomentum(); x.stopAnimation(); startRef.current = offRef.current; },
    onPanResponderMove: (_, g) => place(startRef.current - g.dx),
    onPanResponderRelease: (_, g) => fling(-g.vx),
    onPanResponderTerminate: () => settle(true)
  })).current;

  const beginHold = (d) => {
    stopHold();
    const first = valRef.current;
    setFromValue(first + d, true);
    if (valRef.current !== first) tickIf(valRef.current);
    hold.t = setTimeout(() => { hold.i = setInterval(() => { const before = valRef.current; setFromValue(before + d, false); if (valRef.current === before) stopHold(); else tickIf(valRef.current); }, 60); }, 380);
  };

  const beginEdit = () => { setText(String(val)); setEditing(true); };
  const endEdit = () => {
    setEditing(false);
    const n = parseFloat(String(text).replace(",", "."));
    if (!isNaN(n)) setFromValue(n);
  };

  const edited = val !== def;
  const shown = (signed && val > 0 ? "+" : "") + val + suffix;
  return (
    <View style={st.slRow}>
      {showLabel ? <Text style={st.slLabelTop} numberOfLines={1}>{label}</Text> : null}
      <View style={st.slBody}>
        {editing ? (
          <View style={[st.slValue, { borderColor: C.primary }]}>
            <TextInput autoFocus selectTextOnFocus value={text} onChangeText={setText} onSubmitEditing={endEdit} onBlur={endEdit} keyboardType="numeric" returnKeyType="done" maxLength={5} selectionColor={C.primary} style={st.slInput} />
          </View>
        ) : (
          <Pressable onPress={beginEdit} hitSlop={6} style={[st.slValue, edited && st.slValueOn]}>
            <Text style={[st.slValueText, edited && { color: C.primary }]}>{shown}</Text>
          </Pressable>
        )}
        <Pressable accessibilityRole="button" accessibilityLabel={"Reset " + label} disabled={!edited} hitSlop={8} onPress={() => setFromValue(def)} style={[st.slReset, { marginLeft: 6, marginRight: 6 }, !edited && { opacity: 0.32 }]}>
          <AppIcon name="restart_alt" size={18} color={C.muted} />
        </Pressable>
        <Pressable accessibilityLabel="Decrease" disabled={val <= min} onPressIn={() => beginHold(-1)} onPressOut={stopHold} style={[st.slBtn, val <= min && { opacity: 0.3 }]}>
          <AppIcon name="remove" size={22} color={C.text} />
        </Pressable>
        <View {...pan.panHandlers} onLayout={e => setW(e.nativeEvent.layout.width)} style={st.slRuler}>
          {W > 0 && (
            <>
              <Animated.View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, transform: [{ translateX: x }] }}>
                <RulerTicks min={min} max={max} tu={tu} />
              </Animated.View>
              <RulerFade W={W} />
              <View pointerEvents="none" style={[st.slMark, { left: W / 2 - 2 }]} />
            </>
          )}
        </View>
        <Pressable accessibilityLabel="Increase" disabled={val >= max} onPressIn={() => beginHold(1)} onPressOut={stopHold} style={[st.slBtn, val >= max && { opacity: 0.3 }]}>
          <AppIcon name="add" size={22} color={C.text} />
        </Pressable>
      </View>
    </View>
  );
});

function TabScroll({ children, center }) {
  return (
    <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}
      contentContainerStyle={[st.tabBody, center && { flexGrow: 1, justifyContent: "center" }]}>
      {children}
    </ScrollView>
  );
}

// ---------- Layout system used by every tool tab and by "Your design" ----------
// Section : title + free content (galleries, swatches)
// Group   : title + one card; rows inside the card are separated by hairlines. A Group can carry an on/off switch in its
//           header (toggle): the card only opens while it is on, so options never show for something that is switched off.
// Row     : one setting. Label left + compact control right; long controls drop under the label (stacked).
// Nest    : darker inset for options that depend on a switch row inside a Group.
function SectionHeader({ title, hint, right }) {
  return (
    <View style={st.secHead}>
      <View style={{ flex: 1, paddingRight: 10 }}>
        <Text style={st.secTitle} numberOfLines={1}>{title}</Text>
        {!!hint && <Text style={st.secHint}>{hint}</Text>}
      </View>
      {right}
    </View>
  );
}
function Section({ title, hint, right, children }) {
  return (
    <View>
      <SectionHeader title={title} hint={hint} right={right} />
      {children}
    </View>
  );
}
const Toggle = memo(function Toggle({ value, onChange, label }) {
  const a = useRef(new Animated.Value(value ? 1 : 0)).current;
  useEffect(() => { Animated.timing(a, { toValue: value ? 1 : 0, duration: 160, easing: EASE_OUT, useNativeDriver: true }).start(); }, [value, a]);
  const move = { transform: [{ translateX: a.interpolate({ inputRange: [0, 1], outputRange: [0, 20] }) }] };
  return (
    <Pressable accessibilityRole="switch" accessibilityLabel={label} accessibilityState={{ checked: !!value }} hitSlop={8} onPress={() => onChange(!value)} style={st.tgTrack}>
      <Animated.View pointerEvents="none" style={[st.tgOn, { opacity: a }]} />
      <Animated.View pointerEvents="none" style={[st.tgThumb, move]} />
      <Animated.View pointerEvents="none" style={[st.tgThumb, st.tgThumbOn, move, { opacity: a }]} />
    </Pressable>
  );
});
function Group({ title, hint, right, toggle, edited, children }) {
  const open = !toggle || toggle.value;
  return (
    <View>
      <View style={st.secHead}>
        <View style={{ flex: 1, paddingRight: 10 }}>
          <Text style={st.secTitle} numberOfLines={1}>{title}</Text>
          {!!hint && (!toggle || !toggle.value) && <Text style={st.secHint}>{hint}</Text>}
        </View>
        {right}
        {!!edited && <Text style={st.secEdited}>{edited} edited</Text>}
        {toggle && <Toggle value={toggle.value} onChange={toggle.onChange} label={title} />}
      </View>
      {open && (
        <View style={st.group}>
          <View style={st.groupInner}>{children}</View>
        </View>
      )}
    </View>
  );
}
function Row({ label, hint, stacked, children }) {
  if (stacked) {
    return (
      <View style={st.row}>
        <Text style={st.rowLabel}>{label}</Text>
        {!!hint && <Text style={st.rowHint}>{hint}</Text>}
        <View style={{ marginTop: 10 }}>{children}</View>
      </View>
    );
  }
  return (
    <View style={[st.row, st.rowInline]}>
      <View style={{ flex: 1, paddingRight: 12 }}>
        <Text style={st.rowLabel} numberOfLines={1}>{label}</Text>
        {!!hint && <Text style={st.rowHint} numberOfLines={2}>{hint}</Text>}
      </View>
      {children}
    </View>
  );
}
function Nest({ children }) { return <View style={st.nest}>{children}</View>; }
const ResetBtn = memo(function ResetBtn({ show, onPress }) {
  if (!show) return null;
  return (
    <Press onPress={onPress} style={st.ghostBtn}>
      <AppIcon name="restart_alt" size={15} color={C.muted} />
      <Text style={st.ghostBtnText}>Reset</Text>
    </Press>
  );
});

// ---------- image with live effects (used by the preview and by the preset thumbnails) ----------
let VG_ID = 0;
function fxFilter(fx) {
  const f = [];
  if (fx.exposure) f.push({ brightness: 1 + (fx.exposure / 100) * 0.5 });
  if (fx.contrast) f.push({ contrast: 1 + (fx.contrast / 100) * 0.5 });
  if (fx.saturation) f.push({ saturate: 1 + fx.saturation / 100 });
  if (fx.blur) f.push({ blur: (fx.blur / 100) * 8 });
  return f;
}
const FxImage = memo(function FxImage({ uri, fx, blurRadius }) {
  const vgId = useRef("vg" + (++VG_ID)).current;
  const filter = fxFilter(fx);
  const fill = StyleSheet.absoluteFill;
  return (
    <View pointerEvents="none" style={fill}>
      <View style={[fill, filter.length ? { filter } : null]}>
        <Image source={{ uri }} style={fill} resizeMode="cover" blurRadius={blurRadius || 0} />
      </View>
      {fx.warmth !== 0 && <View style={[fill, { backgroundColor: fx.warmth > 0 ? "#FF8A2B" : "#2B8AFF", opacity: (Math.abs(fx.warmth) / 100) * 0.3 }]} />}
      {fx.tint !== 0 && <View style={[fill, { backgroundColor: fx.tint > 0 ? "#FF3DBE" : "#3DDC84", opacity: (Math.abs(fx.tint) / 100) * 0.25 }]} />}
      {fx.fade > 0 && <View style={[fill, { backgroundColor: "#E8E4EE", opacity: (fx.fade / 100) * 0.4 }]} />}
      {fx.vignette > 0 && (
        <Svg width="100%" height="100%" style={fill}>
          <Defs>
            <RadialGradient id={vgId} cx="50%" cy="50%" rx="72%" ry="72%">
              <Stop offset="0.42" stopColor="#000" stopOpacity="0" />
              <Stop offset="1" stopColor="#000" stopOpacity={(fx.vignette / 100) * 0.8} />
            </RadialGradient>
          </Defs>
          <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${vgId})`} />
        </Svg>
      )}
    </View>
  );
});

// wallpaper layer of the phone preview: Adjust transforms (native) + Effects (state)
function PreviewWallpaper({ uri, hidden }) {
  const fx = useEditor(s => s.fx);
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: hidden ? 0 : 1 }]}>
      <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ translateX: motion.tx }, { translateY: motion.ty }, { scale: motion.scale }, { rotate: motionRot }] }]}>
        <FxImage uri={uri} fx={fx} />
      </Animated.View>
    </View>
  );
}

// ---------- clock of a GitHub wallpaper (meta.json): drag to move, drag the right edge to resize ----------
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad2 = (n) => String(n).padStart(2, "0");
// splits the time into its groups following the format: HH H hh h (hours) · mm m (minutes) · ss s (seconds) · anything else = separator
function clockTime(fmt, d) {
  const H = d.getHours(), h12 = H % 12 || 12, m = d.getMinutes(), sc = d.getSeconds();
  const map = { HH: [pad2(H), "h"], H: [String(H), "h"], hh: [pad2(h12), "h"], h: [String(h12), "h"], mm: [pad2(m), "m"], m: [String(m), "m"], ss: [pad2(sc), "s"], s: [String(sc), "s"] };
  const out = { groups: [], h: null, m: null, s: null, sep: "" };
  let sepSeen = false;
  String(fmt || "HHmm").replace(/HH|H|hh|h|mm|m|ss|s|[^HhmsS]+/g, (t) => {
    const e = map[t];
    if (e) { out.groups.push({ t: e[0], g: e[1] }); if (out[e[1]] == null) out[e[1]] = e[0]; }
    else { out.groups.push({ t, g: "sep" }); if (!sepSeen) { out.sep = t; sepSeen = true; } }
    return t;
  });
  return out;
}
function fmtTime(fmt, d) { return clockTime(fmt, d).groups.map(g => g.t).join(""); }
function fmtDate(fmt, d) {
  const map = { dddd: DAY_NAMES[d.getDay()], ddd: DAY_NAMES[d.getDay()].slice(0, 3), MMMM: MONTH_NAMES[d.getMonth()], MMM: MONTH_NAMES[d.getMonth()].slice(0, 3), D: String(d.getDate()) };
  return String(fmt || "dddd D MMMM").replace(/dddd|ddd|MMMM|MMM|D/g, t => map[t]);
}

// =====================================================================================
//  DATE ENGINE: Gregorian / Shamsi (Jalali) / Hijri calendars and the text the date is made of
// =====================================================================================
const FA_MONTHS = ["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور", "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"];
const FA_DAYS = ["یکشنبه", "دوشنبه", "سه\u200Cشنبه", "چهارشنبه", "پنج\u200Cشنبه", "جمعه", "شنبه"];   // Sunday first
const FA_DAYS_S = ["ی", "د", "س", "چ", "پ", "ج", "ش"];
const AR_MONTHS = ["محرم", "صفر", "ربيع الأول", "ربيع الآخر", "جمادى الأولى", "جمادى الآخرة", "رجب", "شعبان", "رمضان", "شوال", "ذو القعدة", "ذو الحجة"];
const AR_DAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const AR_DAYS_S = ["أحد", "إثنين", "ثلاثاء", "أربعاء", "خميس", "جمعة", "سبت"];
// Shamsi: the arithmetic 33-year-cycle algorithm (same as jalaali-js), exact for the years that matter
const _dv = (a, b) => Math.trunc(a / b), _md = (a, b) => a - Math.trunc(a / b) * b;
const JAL_BREAKS = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];
function jalCal(jy) {
  const bl = JAL_BREAKS.length, gy = jy + 621;
  let leapJ = -14, jp = JAL_BREAKS[0], jump = 0, n, i;
  for (i = 1; i < bl; i++) {
    const jm = JAL_BREAKS[i];
    jump = jm - jp;
    if (jy < jm) break;
    leapJ += _dv(jump, 33) * 8 + _dv(_md(jump, 33), 4);
    jp = jm;
  }
  n = jy - jp;
  leapJ += _dv(n, 33) * 8 + _dv(_md(n, 33) + 3, 4);
  if (_md(jump, 33) === 4 && jump - n === 4) leapJ += 1;
  const leapG = _dv(gy, 4) - _dv((_dv(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;
  if (jump - n < 6) n = n - jump + _dv(jump + 4, 33) * 33;
  let leap = _md(_md(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;
  return { leap, gy, march };
}
const g2d = (gy, gm, gd) => {
  let d = _dv((gy + _dv(gm - 8, 6) + 100100) * 1461, 4) + _dv(153 * _md(gm + 9, 12) + 2, 5) + gd - 34840408;
  d = d - _dv(_dv(gy + 100100 + _dv(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
};
const d2g = (jdn) => {
  let j = 4 * jdn + 139361631;
  j = j + _dv(_dv(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = _dv(_md(j, 1461), 4) * 5 + 308;
  const gd = _dv(_md(i, 153), 5) + 1, gm = _md(_dv(i, 153), 12) + 1, gy = _dv(j, 1461) - 100100 + _dv(8 - gm, 6);
  return { gy, gm, gd };
};
function jalaliOf(date) {
  const jdn = g2d(date.getFullYear(), date.getMonth() + 1, date.getDate());
  let jy = d2g(jdn).gy - 621;
  const r = jalCal(jy), jdn1f = g2d(jy + 621, 3, r.march);
  let k = jdn - jdn1f, jm, jd;
  if (k >= 0) {
    if (k <= 185) return { y: jy, m: 1 + _dv(k, 31), d: _md(k, 31) + 1 };
    k -= 186;
  } else {
    jy -= 1; k += 179;
    if (r.leap === 1) k += 1;
  }
  jm = 7 + _dv(k, 30); jd = _md(k, 30) + 1;
  return { y: jy, m: jm, d: jd };
}
// Hijri: the system calendar (Umm al-Qura) when the device has it, otherwise the tabular civil calendar (can differ by a day)
function hijriOf(date) {
  try {
    const f = new Intl.DateTimeFormat("en-u-ca-islamic-umalqura-nu-latn", { day: "numeric", month: "numeric", year: "numeric" });
    const p = f.formatToParts(date), g = (t) => Number((p.find(x => x.type === t) || {}).value);
    const y = g("year"), m = g("month"), d = g("day");
    if (y > 1300 && y < 1700 && m >= 1 && m <= 12 && d >= 1 && d <= 30) return { y, m, d };
  } catch (e) { /* no Intl calendar support: use the tabular one */ }
  const jd = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000 + 2440587.5;
  const EP = 1948439.5, toJd = (y, m, d) => d + Math.ceil(29.5 * (m - 1)) + (y - 1) * 354 + Math.floor((3 + 11 * y) / 30) + EP - 1;
  const y = Math.floor((30 * (jd - EP) + 10646) / 10631);
  const m = Math.min(12, Math.ceil((jd - (29 + toJd(y, 1, 1))) / 29.5) + 1);
  return { y, m, d: jd - toJd(y, m, 1) + 1 };
}
function dateParts(cal, date) {
  const wi = date.getDay();
  if (cal === "jalali") { const j = jalaliOf(date); return { wd: FA_DAYS[wi], wdS: FA_DAYS_S[wi], day: j.d, month: j.m, monthName: FA_MONTHS[j.m - 1], monthShort: FA_MONTHS[j.m - 1], year: j.y }; }
  if (cal === "hijri") { const h = hijriOf(date); return { wd: AR_DAYS[wi], wdS: AR_DAYS_S[wi], day: h.d, month: h.m, monthName: AR_MONTHS[h.m - 1], monthShort: AR_MONTHS[h.m - 1], year: h.y }; }
  const mi = date.getMonth();
  return { wd: DAY_NAMES[wi], wdS: DAY_NAMES[wi].slice(0, 3), day: date.getDate(), month: mi + 1, monthName: MONTH_NAMES[mi], monthShort: MONTH_NAMES[mi].slice(0, 3), year: date.getFullYear() };
}
const DATE_ORDERS = { dmy: ["day", "month", "year"], mdy: ["month", "day", "year"], ymd: ["year", "month", "day"], ydm: ["year", "day", "month"] };
// o = { cal, what: all | weekday | date, order, month: name | short | number, weekday: full | short, vertical }
// -> the lines the clock renderer draws: [[ {t, acc} ... ] ...]   (acc = the day number, it gets the accent colour of two-tone)
function dateLines(o, date, dots) {
  const cal = o.cal === "jalali" || o.cal === "hijri" ? o.cal : "gregorian", rtl = cal !== "gregorian";
  const P = dateParts(cal, date), pad = (n) => (n < 10 ? "0" + n : String(n));
  const numeric = dots || o.month === "number";
  const val = { day: numeric ? pad(P.day) : String(P.day), month: numeric ? pad(P.month) : (o.month === "short" ? P.monthShort : P.monthName), year: String(P.year) };
  const seq = [];   // logical reading order
  if (dots && o.what === "weekday") seq.push({ k: "day", t: pad(P.day) });   // the dot-matrix font has digits only
  else {
    if (o.what !== "date" && !dots) seq.push({ k: "wd", t: o.weekday === "short" ? P.wdS : P.wd });
    if (o.what !== "weekday") {
      // vertical: only two orders (day / month / year  or  year / month / day, top to bottom), for every calendar; horizontal: the usual orders
      const ord = o.vertical ? (o.vorder === "ymd" ? DATE_ORDERS.ymd : DATE_ORDERS.dmy) : (rtl ? DATE_ORDERS.dmy : DATE_ORDERS[o.order] || DATE_ORDERS.dmy);
      ord.forEach(k => seq.push({ k, t: val[k] }));
    }
  }
  if (o.vertical) {   // one letter / digit per line, a blank line between the words
    const lines = [];
    seq.forEach((g, gi) => {
      if (gi && !dots) lines.push([{ t: " ", acc: false }]);
      Array.from(g.t).forEach(ch => lines.push([{ t: ch, acc: g.k === "day" }]));
    });
    return lines;
  }
  const vis = rtl ? seq.slice().reverse() : seq;   // Shamsi / Hijri read right to left: the first word ends up on the right
  const sep = dots ? ":" : "/";
  return [vis.map((g, i) => {
    const nx = vis[i + 1];
    return { t: g.t + (nx ? (numeric && g.k !== "wd" && nx.k !== "wd" ? sep : " ") : ""), acc: g.k === "day" };
  })];
}
const dateOptsFromDesign = (d) => ({
  cal: d.dateCal, what: d.dateWhat, order: d.dateOrder, vorder: d.dateVOrder, month: d.dateMonth, weekday: d.dateWeekday, vertical: d.dateDir === "vertical",
  size: d.dateSize, spacing: d.dateSpacing, stretch: d.dateStretch, widthScale: d.dateWidthScale, rotate: d.dateRotate
});
// the design the date is drawn with: the clock's own design (so every look is inherited) + the few things that belong to the date
function dateDesign(base, o) {
  const vert = !!o.vertical, rtl = o.cal === "jalali" || o.cal === "hijri";
  return {
    ...base, showDate: "off", layout: vert ? "stacked" : "inline", size: o.size / 0.68 / (vert ? 0.9 : 1),
    spacing: rtl && !vert ? 0 : o.spacing,   // letter spacing would break the joined Arabic-script letters
    stretch: o.stretch, widthScale: o.widthScale, rotate: o.rotate,
    lineGap: 0, groupGap: 0, lineShift: 0, offsetX: 0, offsetY: 0, panel: "off", top: 0, seconds: "off"
  };
}
// the date block. `o.size * k` is the font size in px; `now` lets the wallpaper clock share its own time
function DateFace({ d, color, k, o, now }) {
  const [tick, setTick] = useState(() => new Date());
  useEffect(() => { if (now) return undefined; const t = setInterval(() => setTick(new Date()), 60000); return () => clearInterval(t); }, [now]);
  const [box, setBox] = useState(null);
  const onBox = useCallback((l) => setBox(b => (b && Math.abs(b.w - l.width) < 0.5 && Math.abs(b.h - l.height) < 0.5 ? b : { w: l.width, h: l.height })), []);
  const date = now || tick;
  const lines = dateLines(o, date, d.font === "dots");
  const face = <ClockFace d={dateDesign(normDesign(d), o)} color={color} k={k} textLines={lines} onBox={o.rotate ? onBox : undefined} />;
  if (!o.rotate) return face;
  // a rotated block keeps the space of its rotated outline, so it never overlaps the clock
  const r = (o.rotate * Math.PI) / 180, ca = Math.abs(Math.cos(r)), sa = Math.abs(Math.sin(r));
  const W = box ? box.w * ca + box.h * sa : undefined, H = box ? box.w * sa + box.h * ca : undefined;
  // The face sits in a wide row so it always keeps its natural size. Before, this absolute child had no width and only got the
  // room the rotated frame leaves (narrower than the text), so the text wrapped and its last characters were cut off.
  return (
    <View style={{ width: W, height: H, alignItems: "center", justifyContent: "center" }}>
      <View style={box ? { position: "absolute", left: (W - box.w) / 2, top: (H - box.h) / 2, width: 6000, flexDirection: "row", alignItems: "flex-start" } : null}>{face}</View>
    </View>
  );
}
// some fonts draw taller than the space they report, so their clock box gets extra height (multiplier of the font size)
const CLOCK_BOX_HEIGHT = { OppoClock: 3.1 };
// extra room left and right of the digits, as a multiple of the font size (other fonts get a fixed 20)
const CLOCK_BOX_PAD = { OppoClock: 0.32 };
// where the visible digits sit inside the text box (fractions of the font size), measured from a screenshot:
// left/right = gap between the digits and the measured text width, top/bottom = gap inside the box height.
// margin = the equal air left around the digits on all four sides of the dashed frame. Tune these if a side looks off.
const CLOCK_INK = { OppoClock: { left: 0.145, right: 0, top: 0.173, bottom: 0.927, margin: 0.2 } };

// =====================================================================================
//  WALLPAPER CLOCK CONTRACT  —  meta.json  ->  clock.style          (full reference: clock_style_contract.md)
//  <<CLOCK_CONTRACT_START>>
//  clock.color / clock.color2 / clock.opacity / clock.font / clock.weight / clock.align keep working (shorthand).
//  Everything else lives under clock.style. Units: sizes are in "em" (1 = the clock's font size) so a clock looks the
//  same at any size; angles are degrees; percentages are 0-100. Unknown keys and bad values are ignored and reported
//  with console.warn in dev builds, so the contract can grow without breaking old files.
//
//  style = {
//    version: 1,
//    look: "solid" | "glass",                       glass is EXCLUSIVE: it ignores body.color2, body.fade and stroke (it has its own glass.stroke)
//    layout: "inline" | "stacked",                  stacked = hours above minutes
//    numerals: "latn" | "fa" | "ar",
//    letterSpacing, groupGap, lineGap, shadow,      em   (shadow can also be { on, radius })
//    transform: { on, rotate, skew, stretch, widthScale },
//    body:   { color, twoTone: { on, color, target: "minutes" | "hours" }, fade: GRADIENT },     (color2 / color2Target = older spelling, still read)
//    stroke:  { on, width, color, opacity, fade: GRADIENT }, a contour added around the digits (own colour / own fade; opacity 0-100)
//    glass:   { opacity, blur, lightAngle, edge, edgeWidth, stroke: { on, width, color, opacity }, blend: "normal" | "overlay", blendAmount,
//             light: { on, sides: "one" | "both", opacity, width }, dark: { on, sides: "one" | "both", opacity, width } }
//  }
//  glass.stroke = contour around every glass digit (width in em like style.stroke, opacity 0-100); glass.overlay = { on, amount } (older spelling: blend / blendAmount)
//  GRADIENT = { on, colors: [2..6 hex], angle, scope: "all" | "each" }
//
//  DATE: meta.json "date" = { show, above, x, y, size, style }. The date takes font, colours and EVERY look from the clock
//  (fade, stroke, glass...). Only these are its own:  see parseDateStyle() below.
//  Body fade and stroke fade are two independent gradients.
// =====================================================================================
const CK_WARN = (path, msg) => { if (typeof __DEV__ !== "undefined" && __DEV__) console.warn("[meta.clock] " + path + ": " + msg); };
const CK_HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const ckObj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);
const ckColor = (v, path) => {
  if (v == null || v === "") return null;
  if (typeof v === "string" && CK_HEX.test(v.trim())) {
    let h = v.trim().slice(1);
    if (h.length === 3) h = h.split("").map(x => x + x).join("");
    return "#" + h.toUpperCase();
  }
  CK_WARN(path, "invalid color " + JSON.stringify(v) + " (use #RGB or #RRGGBB)");
  return null;
};
const ckNum = (v, def, lo, hi, path) => {
  if (v == null) return def;
  if (typeof v !== "number" || !isFinite(v)) { CK_WARN(path, "expected a number"); return def; }
  if (v < lo || v > hi) CK_WARN(path, "value " + v + " is outside " + lo + ".." + hi + " (clamped)");
  return Math.min(hi, Math.max(lo, v));
};
const ckEnum = (v, list, def, path) => {
  if (v == null) return def;
  if (list.includes(v)) return v;
  CK_WARN(path, "must be one of: " + list.join(" | "));
  return def;
};
const ckBool = (v, def, path) => {
  if (v == null) return def;
  if (v === true || v === "on") return true;
  if (v === false || v === "off") return false;
  CK_WARN(path, "expected true or false");
  return def;
};
const ckKeys = (o, allowed, path) => Object.keys(o).forEach(k => { if (!allowed.includes(k)) CK_WARN(path + "." + k, "unknown key (ignored)"); });
function ckFade(f, path) {
  if (f == null) return null;
  const o = ckObj(f);
  if (!o) { CK_WARN(path, "must be an object { colors, angle, scope }"); return null; }
  ckKeys(o, ["on", "colors", "angle", "scope"], path);
  if (!ckBool(o.on, true, path + ".on")) return null;
  const colors = (Array.isArray(o.colors) ? o.colors : []).slice(0, 6).map((x, i) => ckColor(x, path + ".colors[" + i + "]")).filter(Boolean);
  if (colors.length < 2) { CK_WARN(path + ".colors", "needs at least 2 valid colors (fade ignored)"); return null; }
  const a = ckNum(o.angle, 180, -720, 720, path + ".angle");
  return { colors, angle: ((a % 360) + 360) % 360, scope: ckEnum(o.scope, ["all", "each"], "all", path + ".scope") };
}
const CK_CACHE = new WeakMap();
function parseClockStyle(c) {
  const key = c && typeof c === "object" ? c : null;
  if (key && CK_CACHE.has(key)) return CK_CACHE.get(key);
  const cl = key || {};
  if (cl.style != null && !ckObj(cl.style)) CK_WARN("style", "must be an object");
  const s = ckObj(cl.style) || {};
  ckKeys(s, ["version", "look", "layout", "numerals", "letterSpacing", "groupGap", "lineGap", "shadow", "transform", "body", "stroke", "glass"], "style");
  if (s.version != null && s.version !== 1) CK_WARN("style.version", "only version 1 is known; reading the file as version 1");
  const look = ckEnum(s.look, ["solid", "glass"], "solid", "style.look"), isGlass = look === "glass";
  const layout = ckEnum(s.layout, ["inline", "stacked"], "inline", "style.layout");
  const numerals = ckEnum(s.numerals, ["latn", "fa", "ar"], "latn", "style.numerals");
  const letterSpacing = ckNum(s.letterSpacing, 0, -0.2, 0.5, "style.letterSpacing");
  const groupGap = ckNum(s.groupGap, 0, -0.2, 1, "style.groupGap");
  const lineGap = ckNum(s.lineGap, 0, -0.5, 1, "style.lineGap");
  const shObj = ckObj(s.shadow);
  if (shObj) ckKeys(shObj, ["on", "radius"], "style.shadow");
  const shadow = shObj ? (ckBool(shObj.on, true, "style.shadow.on") ? ckNum(shObj.radius, 0.06, 0, 0.3, "style.shadow.radius") : 0) : ckNum(s.shadow, 0, 0, 0.3, "style.shadow");
  // ---- body: colours and the body fade ----
  if (s.body != null && !ckObj(s.body)) CK_WARN("style.body", "must be an object");
  const body = ckObj(s.body) || {};
  ckKeys(body, ["color", "color2", "color2Target", "twoTone", "fade"], "style.body");
  const color = ckColor(body.color != null ? body.color : cl.color, "style.body.color");
  const ttO = ckObj(body.twoTone);
  if (body.twoTone != null && !ttO) CK_WARN("style.body.twoTone", "must be an object { on, color, target }");
  if (ttO) ckKeys(ttO, ["on", "color", "target"], "style.body.twoTone");
  const ttOn = ttO ? ckBool(ttO.on, true, "style.body.twoTone.on") : true;
  const color2 = ttO
    ? (ttOn ? ckColor(ttO.color != null ? ttO.color : (body.color2 != null ? body.color2 : cl.color2), "style.body.twoTone.color") : null)
    : ckColor(body.color2 != null ? body.color2 : cl.color2, "style.body.color2");
  const target = ckEnum(ttO ? ttO.target : body.color2Target, ["minutes", "hours"], "minutes", ttO ? "style.body.twoTone.target" : "style.body.color2Target") === "hours" ? "h" : "m";
  const fade = ckFade(body.fade, "style.body.fade");
  // ---- stroke (contour with its own colour / fade) ----
  let width = null;
  let sColor = null, sFade = null, sOpacity = 100;
  if (s.stroke != null && !ckObj(s.stroke)) CK_WARN("style.stroke", "must be an object { width, color, fade }");
  const stObj = ckObj(s.stroke);
  if (stObj) {
    ckKeys(stObj, ["on", "width", "color", "fade", "opacity"], "style.stroke");
    if (ckBool(stObj.on, true, "style.stroke.on")) {
      if (stObj.width != null) width = ckNum(stObj.width, width, 0.005, 0.3, "style.stroke.width");
      sColor = ckColor(stObj.color, "style.stroke.color");
      sFade = ckFade(stObj.fade, "style.stroke.fade");
      sOpacity = ckNum(stObj.opacity, 100, 0, 100, "style.stroke.opacity");
      if (!sColor && !sFade) CK_WARN("style.stroke", "needs a color or a fade to be visible");
    }
  }
  const strokeOn = !!(sColor || sFade);
  // ---- glass ----
  if (s.glass != null && !ckObj(s.glass)) CK_WARN("style.glass", "must be an object");
  const g = ckObj(s.glass) || {};
  ckKeys(g, ["opacity", "blur", "lightAngle", "edge", "edgeWidth", "stroke", "blend", "blendAmount", "overlay", "light", "dark"], "style.glass");
  const edgeSpec = (o, name) => {
    if (o != null && !ckObj(o)) CK_WARN("style.glass." + name, "must be an object { on, sides, opacity, width }");
    const e = ckObj(o) || {};
    ckKeys(e, ["on", "sides", "opacity", "width"], "style.glass." + name);
    return {
      on: ckBool(e.on, true, "style.glass." + name + ".on") ? "on" : "off",
      sides: ckEnum(e.sides, ["one", "both"], "one", "style.glass." + name + ".sides"),
      a: e.opacity != null ? ckNum(e.opacity, null, 0, 100, "style.glass." + name + ".opacity") : null,
      w: e.width != null ? ckNum(e.width, null, 0, 100, "style.glass." + name + ".width") : null
    };
  };
  const gLight = edgeSpec(g.light, "light"), gDark = edgeSpec(g.dark, "dark");
  if (g.stroke != null && !ckObj(g.stroke)) CK_WARN("style.glass.stroke", "must be an object { on, width, color, opacity }");
  const gsO = ckObj(g.stroke);
  if (gsO) ckKeys(gsO, ["on", "width", "color", "opacity"], "style.glass.stroke");
  const gStrokeOn = !!gsO && ckBool(gsO.on, true, "style.glass.stroke.on");
  const gStrokeW = gsO && gsO.width != null ? ckNum(gsO.width, null, 0.005, 0.3, "style.glass.stroke.width") : null;
  const gStrokeColor = gsO ? ckColor(gsO.color, "style.glass.stroke.color") : null;
  const gStrokeOp = gsO ? ckNum(gsO.opacity, 60, 0, 100, "style.glass.stroke.opacity") : 60;
  const ovO = ckObj(g.overlay);
  if (ovO) ckKeys(ovO, ["on", "amount"], "style.glass.overlay");
  const gBlend = ovO ? (ckBool(ovO.on, true, "style.glass.overlay.on") ? "overlay" : "normal") : ckEnum(g.blend, ["normal", "overlay"], "normal", "style.glass.blend");
  const gBlendAmt = ovO ? ckNum(ovO.amount, CLOCK_CLASSIC.glassBlendAmt, 0, 100, "style.glass.overlay.amount") : ckNum(g.blendAmount, CLOCK_CLASSIC.glassBlendAmt, 0, 100, "style.glass.blendAmount");
  if (!isGlass && ckObj(s.glass)) CK_WARN("style.glass", 'ignored unless style.look is "glass"');
  if (!isGlass && fade && color2) CK_WARN("style.body", "body.fade replaces body.color2 (the gradient paints the whole body)");
  if (isGlass && (color2 || fade || strokeOn)) CK_WARN("style", "glass is exclusive: body.color2, body.fade and stroke are ignored (glass has its own style.glass.stroke)");
  // ---- whole-clock transform ----
  if (s.transform != null && !ckObj(s.transform)) CK_WARN("style.transform", "must be an object");
  const t0 = ckObj(s.transform) || {};
  ckKeys(t0, ["on", "rotate", "skew", "stretch", "widthScale"], "style.transform");
  const t = ckBool(t0.on, true, "style.transform.on") ? t0 : {};
  const rotate = ckNum(t.rotate, 0, -180, 180, "style.transform.rotate");
  const skew = ckNum(t.skew, 0, -45, 45, "style.transform.skew");
  const stretch = ckNum(t.stretch, 1, 0.5, 3, "style.transform.stretch");
  const widthScale = ckNum(t.widthScale, 1, 0.5, 3, "style.transform.widthScale");
  // Plain Text can do: colour, colour2, letterSpacing, numerals, shadow. Everything else goes to the app's clock renderer.
  const face = isGlass || strokeOn || !!fade || layout === "stacked" || groupGap !== 0 || lineGap !== 0
    || rotate !== 0 || skew !== 0 || stretch !== 1 || widthScale !== 1;
  const U = layout === "stacked" ? 61.2 : 68;   // design units per font size (the renderer sizes everything from these)
  const design = {
    ...CLOCK_CLASSIC,
    layout, look, font: cl.font || "sans", weight: cl.weight || 400, size: 100, top: 0, showDate: "off",
    align: ckEnum(cl.align, ["left", "center", "right"], "center", "clock.align"),
    opacity: Math.round(ckNum(cl.opacity, 1, 0, 1, "clock.opacity") * 100),
    spacing: letterSpacing * U, groupGap: groupGap * U, lineGap: lineGap * U, shadow: shadow * U, numerals,
    seconds: /s/.test(String(cl.format || "")) ? "on" : "off",
    rotate, skew, stretch: stretch * 100, widthScale: widthScale * 100,
    twoTone: !isGlass && color2 ? "on" : "off", accent: color2 || CLOCK_CLASSIC.accent, toneOn: target === "h" ? "hour" : "min", toneA: "",
    fadeOn: !isGlass && fade ? "on" : "off",
    fadeC1: fade ? fade.colors[0] : CLOCK_CLASSIC.fadeC1, fadeC2: fade ? fade.colors[fade.colors.length - 1] : CLOCK_CLASSIC.fadeC2,
    fadeStops: fade ? fade.colors : null, fadeAngle: fade ? fade.angle : 180, fadeScope: fade ? fade.scope : "all",
    strokeOn: !isGlass && strokeOn ? "on" : "off", strokeColor: sColor || "#000000", strokeOpacity: sOpacity,
    sFadeOn: !isGlass && sFade ? "on" : "off",
    sC1: sFade ? sFade.colors[0] : CLOCK_CLASSIC.sC1, sC2: sFade ? sFade.colors[sFade.colors.length - 1] : CLOCK_CLASSIC.sC2,
    sStops: sFade ? sFade.colors : null, sAngle: sFade ? sFade.angle : 180, sScope: sFade ? sFade.scope : "all",
    stroke: (width != null ? width : 0.035) * U / 1.2,
    glass: ckNum(g.opacity, CLOCK_CLASSIC.glass, 0, 100, "style.glass.opacity"),
    glassBlur: ckNum(g.blur, CLOCK_CLASSIC.glassBlur, 0, 100, "style.glass.blur"),
    glassAngle: ckNum(g.lightAngle, CLOCK_CLASSIC.glassAngle, 0, 360, "style.glass.lightAngle"),
    glassEdge: ckNum(g.edge, CLOCK_CLASSIC.glassEdge, 0, 100, "style.glass.edge"),
    glassEdgeW: ckNum(g.edgeWidth, CLOCK_CLASSIC.glassEdgeW, 0, 100, "style.glass.edgeWidth"),
    glassStrokeOn: isGlass && gStrokeOn ? "on" : "off", glassStrokeColor: gStrokeColor || "#FFFFFF", glassStrokeOpacity: gStrokeOp,
    glassStrokeW: (gStrokeW != null ? gStrokeW : 0.035) * U / 1.2,
    glassLight: gLight.on, glassLightSides: gLight.sides, glassLightA: gLight.a, glassLightW: gLight.w,
    glassDark: gDark.on, glassDarkSides: gDark.sides, glassDarkA: gDark.a, glassDarkW: gDark.w,
    glassBlend: gBlend,
    glassBlendAmt: gBlendAmt
  };
  const out = {
    color, numerals, spacingEm: letterSpacing, shadowEm: shadow, face, design, unit: U,
    tone: !isGlass && color2 ? { color: color2, target } : null,
    seconds: /s/.test(String(cl.format || ""))
  };
  if (key) CK_CACHE.set(key, out);
  return out;
}

// ---------- date: meta.json "date" ----------
//  date = {
//    show: true | false,                     show / hide the date
//    above, x, y, size                       layer, position and font size (fraction of the screen height), as before
//    place: "free" | "above" | "below" | "left" | "right",   free = x / y as before; the others stick the date to that side of the clock (x / y ignored)
//    gap: 0 .. 0.2                           distance between clock and date, fraction of the screen height (only with place above / below / left / right)
//    style: {
//      version: 1,
//      calendar:  "gregorian" | "jalali" | "hijri",
//      display:   "all" | "weekday" | "date",              weekday + date | weekday only | day / month / year only
//      weekday:   "full" | "short",
//      month:     "name" | "short" | "number",             number = all numeric (18/10/2026)
//      order:     "dmy" | "mdy" | "ymd" | "ydm",           gregorian only (day in the middle = "ydm"); jalali / hijri keep their own order
//      direction: "horizontal" | "vertical",               vertical = one letter / digit per line, words separated by a gap
//      verticalOrder: "dmy" | "ymd",                       vertical only, top to bottom: day / month / year  or  year / month / day (weekday stays on top)
//      letterSpacing: em,
//      transform: { on, rotate, stretch, widthScale }
//    }
//  }
//  Font, weight, colours, opacity, fade, stroke, glass, numerals, align, shadow, skew: all taken from the clock.
const DATE_LEGACY_KEYS = ["font", "weight", "color", "opacity", "format"];
const DATE_CACHE = new WeakMap();
function parseDateStyle(dt) {
  const key = dt && typeof dt === "object" ? dt : null;
  if (key && DATE_CACHE.has(key)) return DATE_CACHE.get(key);
  const dd = key || {};
  ckKeys(dd, ["show", "above", "x", "y", "size", "place", "gap", "style", ...DATE_LEGACY_KEYS], "date");
  DATE_LEGACY_KEYS.forEach(k => { if (dd[k] != null) CK_WARN("date." + k, "ignored: the date takes this from the clock"); });
  if (dd.style != null && !ckObj(dd.style)) CK_WARN("date.style", "must be an object");
  const s = ckObj(dd.style) || {};
  ckKeys(s, ["version", "calendar", "display", "weekday", "month", "order", "direction", "verticalOrder", "letterSpacing", "transform"], "date.style");
  if (s.version != null && s.version !== 1) CK_WARN("date.style.version", "only version 1 is known; reading the file as version 1");
  const t0 = ckObj(s.transform) || {};
  ckKeys(t0, ["on", "rotate", "stretch", "widthScale"], "date.style.transform");
  const t = ckBool(t0.on, true, "date.style.transform.on") ? t0 : {};
  const out = {
    cal: ckEnum(s.calendar, ["gregorian", "jalali", "hijri"], "gregorian", "date.style.calendar"),
    what: ckEnum(s.display, ["all", "weekday", "date"], "all", "date.style.display"),
    weekday: ckEnum(s.weekday, ["full", "short"], "full", "date.style.weekday"),
    month: ckEnum(s.month, ["name", "short", "number"], "name", "date.style.month"),
    order: ckEnum(s.order, ["dmy", "mdy", "ymd", "ydm"], "dmy", "date.style.order"),
    vertical: ckEnum(s.direction, ["horizontal", "vertical"], "horizontal", "date.style.direction") === "vertical",
    vorder: ckEnum(s.verticalOrder, ["dmy", "ymd"], "dmy", "date.style.verticalOrder"),   // only used when direction is vertical
    place: ckEnum(dd.place, ["free", "above", "below", "left", "right"], "free", "date.place"),
    gap: ckNum(dd.gap, 0, 0, 0.2, "date.gap"),
    spacingEm: ckNum(s.letterSpacing, 0.04, -0.2, 0.5, "date.style.letterSpacing"),
    rotate: ckNum(t.rotate, 0, -180, 180, "date.style.transform.rotate"),
    stretch: ckNum(t.stretch, 1, 0.5, 3, "date.style.transform.stretch"),
    widthScale: ckNum(t.widthScale, 1, 0.5, 3, "date.style.transform.widthScale")
  };
  if (out.place !== "free" && (dd.x != null || dd.y != null)) CK_WARN("date.x / date.y", "ignored: the date is placed next to the clock (date.place)");
  if (s.order != null && out.cal !== "gregorian") CK_WARN("date.style.order", "ignored: the Shamsi and Hijri calendars keep their own order");
  if (key) DATE_CACHE.set(key, out);
  return out;
}
//  <<CLOCK_CONTRACT_END>>
const RemoteClock = memo(function RemoteClock({ w, W, H, anim }) {
  useClockFontsReady();
  const c = w.meta.clock || {}, dt = w.meta.date;
  const color = useEditor(s => s.clockColor);
  const sty = parseClockStyle(c);   // clock.style from meta.json (see the contract above)
  const baseSize = c.size || 0.16, baseX = c.x == null ? 0.5 : c.x, baseY = c.y == null ? 0.29 : c.y;
  const [pos, setPos] = useState({ x: baseX, y: baseY, size: baseSize });
  const [tw, setTw] = useState(0);
  const [unitW, setUnitW] = useState(0); // natural text width per 1px of font size (measured by a hidden twin Text)
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => new Date());
  // the gesture works on this ref (updated instantly by the handlers); React state only mirrors it for drawing,
  // so a late or stale render can never put the clock back on an older spot
  const live = useRef({ x: baseX, y: baseY, size: baseSize });
  const rcStore = useEditor(s => s.rc);
  useEffect(() => {   // undo / redo / reset put another position in the store: follow it
    const tg = rcStore || { x: baseX, y: baseY, size: baseSize }, l = live.current;
    if (tg.x !== l.x || tg.y !== l.y || tg.size !== l.size) { live.current = { ...tg }; setPos({ ...tg }); }
  }, [rcStore, baseX, baseY, baseSize]);
  const twRef = useRef(0); twRef.current = tw;
  const dims = useRef({ W, H, boxH: 1 }); dims.current.W = W; dims.current.H = H;
  // drag and resize each keep their own start snapshot (a shared one could be overwritten by a second finger -> NaN -> crash)
  const dragStart = useRef(null), resizeStart = useRef(null);
  useEffect(() => { const t = setInterval(() => setNow(new Date()), sty.seconds ? 1000 : 10000); return () => clearInterval(t); }, [sty.seconds]);
  const commit = () => { setPos({ ...live.current }); editor.set({ rc: { ...live.current } }); };
  const drag = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => { dragStart.current = { ...live.current }; setBusy(true); },
    onPanResponderMove: (_, g) => {
      const a = dragStart.current, d = dims.current;
      if (!a) return;
      const z = viewScaleNow();
      live.current = { ...live.current, x: clamp(a.x + g.dx / z / d.W, 0, 1), y: clamp(a.y + g.dy / z / d.H, 0, 1) };
      commit();
    },
    onPanResponderRelease: () => { commit(); setBusy(false); },
    onPanResponderTerminate: () => { commit(); setBusy(false); }
  }), []);
  const resize = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => { resizeStart.current = { size: live.current.size, tw: Math.max(40, twRef.current), bh: Math.max(20, fin(dims.current.boxH, 20)) }; setBusy(true); },
    onPanResponderMove: (_, g) => {
      const a = resizeStart.current;
      if (!a) return;
      // corner drag: right/down grows, left/up shrinks; the clock stays centered
      const hw = a.tw / 2, hh = a.bh / 2; // smooth in every direction (no jump when the move turns from sideways to up / down)
      const proj = ((hw + g.dx / viewScaleNow()) * hw + (hh + g.dy / viewScaleNow()) * hh) / (hw * hw + hh * hh);
      if (!isFinite(proj)) return;
      live.current = { ...live.current, size: clamp(a.size * proj, 0.04, 0.5) };
      commit();
    },
    onPanResponderRelease: () => { commit(); setBusy(false); },
    onPanResponderTerminate: () => { commit(); setBusy(false); }
  }), []);

  clockCenter.x = pos.x; clockCenter.y = pos.y;
  const fs = pos.size * H;
  const boxH = fs * (c.lineHeight || CLOCK_BOX_HEIGHT[c.font] || 1.35);
  const rf = resolveFont(c.font, c.weight || 400);
  const ratio = pos.size / baseSize;
  const dateOn = !!dt && dt.show !== false;
  const dsty = dateOn ? parseDateStyle(dt) : null;   // date.style from meta.json: everything else comes from the clock
  const dateFs = dateOn ? (dt.size || 0.025) * H * ratio : 0;
  const dateO = dsty && { cal: dsty.cal, what: dsty.what, order: dsty.order, vorder: dsty.vorder, month: dsty.month, weekday: dsty.weekday, vertical: dsty.vertical, size: 68, spacing: dsty.spacingEm * 68, stretch: dsty.stretch * 100, widthScale: dsty.widthScale * 100, rotate: dsty.rotate };
  const dateBoxH = dateFs * 1.5;
  const dateX = pos.x + ((dt && dt.x != null ? dt.x : baseX) - baseX) * ratio;
  const dateY = pos.y + ((dt && dt.y != null ? dt.y : baseY + 0.1) - baseY) * ratio;
  const edge = busy ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.45)";
  const padX = CLOCK_BOX_PAD[c.font] != null ? fs * CLOCK_BOX_PAD[c.font] : 20;
  const ct = clockTime(c.format, now);
  const timeText = numeralize(ct.groups.map(g => g.t).join(""), sty.numerals);
  // plain (non-SVG) text: two-colour digits are nested <Text> spans
  const plainKids = sty.tone
    ? ct.groups.map((g, i) => <Text key={i} style={g.g === sty.tone.target || (g.g === "s" && sty.tone.target === "m") ? { color: sty.tone.color } : null}>{numeralize(g.t, sty.numerals)}</Text>)
    : timeText;
  const plainFx = {
    ...(sty.spacingEm ? { letterSpacing: sty.spacingEm * fs } : null),
    ...(sty.shadowEm > 0 ? { textShadowColor: "rgba(0,0,0,0.55)", textShadowRadius: sty.shadowEm * fs, textShadowOffset: { width: 0, height: 1 } } : null)
  };
  // Android clips text to the text's own box (padding excluded), and this font draws wider than its advance widths.
  // So the Text itself is made wider than its content and centered, instead of using padding.
  const wide = CLOCK_BOX_PAD[c.font] != null; // only fonts listed in CLOCK_BOX_PAD use the measured wide box
  const ink = CLOCK_INK[c.font];
  const natW = unitW * fs;
  const inkMode = !!ink && unitW > 0;
  const mg = ink ? ink.margin * fs : 0;
  const frameW = inkMode ? natW - (ink.left + ink.right) * fs + 2 * mg : undefined;
  const frameH = inkMode ? boxH - (ink.top + ink.bottom) * fs + 2 * mg : boxH; // the dashed frame hugs the digits
  dims.current.boxH = frameH;
  const textBoxW = wide && unitW > 0 ? unitW * fs + 2 * padX : undefined;
  // the date: free (x / y of meta.json) or stuck to a side of the clock (date.place + date.gap)
  let dateWrapStyle = { position: "absolute", left: dateX * W - W, width: 2 * W, top: dateY * H - dateBoxH / 2, height: dateBoxH, alignItems: "center", justifyContent: "center" };
  if (dsty && dsty.place !== "free") {
    const cx = pos.x * W, cTop = pos.y * H - frameH / 2, gp = dsty.gap * H * ratio;
    if (dsty.place === "above") dateWrapStyle = { position: "absolute", left: cx - W, width: 2 * W, bottom: H - (cTop - gp), alignItems: "center" };
    else if (dsty.place === "below") dateWrapStyle = { position: "absolute", left: cx - W, width: 2 * W, top: cTop + frameH + gp, alignItems: "center" };
    else if (dsty.place === "left") dateWrapStyle = { position: "absolute", left: -W, width: Math.max(0, W + cx - tw / 2 - gp), top: cTop, height: frameH, alignItems: "flex-end", justifyContent: "center" };
    else dateWrapStyle = { position: "absolute", left: cx + tw / 2 + gp, width: 2 * W, top: cTop, height: frameH, alignItems: "flex-start", justifyContent: "center" };
  }
  const HANDLE = 44, SPARE = 24; // extra height under the box so the corner handle stays inside the touchable area
  return (
    <Animated.View pointerEvents="box-none" style={[StyleSheet.absoluteFill, { opacity: anim.opacity, transform: [{ translateY: anim.translateY }, { scale: anim.scale }] }]}>
      {dateOn && (
        <View pointerEvents="none" style={dateWrapStyle}>
          <DateFace d={sty.design} color={color} k={dateFs / 68} o={dateO} now={now} />
        </View>
      )}
      <View pointerEvents="box-none" style={{ position: "absolute", left: pos.x * W - W, width: 2 * W, top: pos.y * H - frameH / 2, height: frameH + SPARE, alignItems: "center", justifyContent: "flex-start" }}>
        {wide && <View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, width: 6 * W, opacity: 0 }}>
          <Text numberOfLines={1} onTextLayout={e => { const l = e.nativeEvent.lines && e.nativeEvent.lines[0]; if (l && fs > 0) { const u = l.width / fs; setUnitW(prev => Math.abs(prev - u) > 0.002 ? u : prev); } }} style={{ fontSize: fs, fontFamily: rf.fontFamily, fontWeight: rf.fontWeight, includeFontPadding: false, writingDirection: "ltr", ...plainFx }}>{timeText}</Text>
        </View>}
        <View {...drag.panHandlers} hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }} onLayout={e => setTw(e.nativeEvent.layout.width)} style={{ height: frameH, width: frameW, justifyContent: "center", borderWidth: 1.5, borderStyle: "dashed", borderColor: edge, borderRadius: 10 }}>
          <Text numberOfLines={1} style={{ color, opacity: sty.face ? 0 : (c.opacity == null ? 1 : c.opacity), ...plainFx, fontSize: fs, lineHeight: boxH, fontFamily: rf.fontFamily, fontWeight: rf.fontWeight, includeFontPadding: false, textAlignVertical: "center", writingDirection: "ltr", ...(inkMode ? { position: "absolute", left: mg - ink.left * fs - padX, top: mg - ink.top * fs, width: natW + 2 * padX, textAlign: "center" } : wide ? { textAlign: "center", width: textBoxW } : { paddingHorizontal: padX }) }}>{plainKids}</Text>
          {/* stroke / fade / glass / stacked / transforms: drawn by the app's own clock renderer, centred in the same frame
              (the plain Text above stays in the layout, invisible, so the frame and the drag / resize handles keep their size) */}
          {sty.face && (
            <View pointerEvents="none" style={{ position: "absolute", top: 0, bottom: 0, left: -W, right: -W, alignItems: "center", justifyContent: "center" }}>
              <ClockFace d={sty.design} color={color} k={fs / sty.unit} live={ct} />
            </View>
          )}
        </View>
        {/* resize handle: a rounded corner bracket on the bottom-right corner of the dashed frame */}
        <View {...resize.panHandlers} style={{ position: "absolute", left: W + tw / 2 + 3 - HANDLE, top: frameH + 3 - HANDLE, width: HANDLE, height: HANDLE }}>
          <View style={{ position: "absolute", right: 3, bottom: 3, width: 24, height: 24, borderRightWidth: 4, borderBottomWidth: 4, borderBottomRightRadius: 14, borderColor: busy ? C.primary : "#FFFFFF" }} />
        </View>
      </View>
    </Animated.View>
  );
});
// the app's own clock design, unless this wallpaper's own clock (meta.json) is selected
function ClockLayer({ remote, W, H, k, anim }) {
  const id = useEditor(s => s.clockId);
  if (id === "remote" && remote && remote.meta && remote.meta.clock) return <RemoteClock key={remote.id} w={remote} W={W} H={H} anim={anim} />;
  return <MovableClock W={W} H={H} k={k} anim={anim} />;
}
// the app's own clock designs (any wallpaper): drag the clock to move it, drag the corner bracket to resize it.
// Both change the design's own offset / size values (editor.cm), so every look keeps drawing itself correctly.
const MovableClock = memo(function MovableClock({ W, H, k, anim }) {
  const base = useActiveDesign();
  const cm = useEditor(s => s.cm);
  const d = useMemo(() => applyClockMove(base, cm), [base, cm]);
  const [box, setBox] = useState(null);   // clock bounds as laid out by ClockFace
  const [busy, setBusy] = useState(false);
  const abstract = !!d.arrange && d.arrange !== "flow";
  const svgMode = isStyledLook(d);
  const fr = box && !abstract ? {
    l: box.x + (d.offsetX / 100) * W,
    t: (H * d.top) / 100 + box.y + (d.offsetY / 100) * W,
    w: box.width, h: box.height
  } : null;
  if (fr && W > 0 && H > 0) { clockCenter.x = (fr.l + fr.w / 2) / W; clockCenter.y = (fr.t + fr.h / 2) / H; }
  const geo = useRef(null);
  geo.current = fr ? { w: fr.w, h: fr.h, W, H, align: d.align, svgMode } : null;
  // drag and resize each keep their own start snapshot: with one shared ref a second finger overwrote it,
  // the other gesture then read undefined fields -> NaN scale -> native crash
  const dragStart = useRef(null), resizeStart = useRef(null);
  const drag = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => { dragStart.current = { ...editor.get().cm }; setBusy(true); },
    onPanResponderMove: (_, g) => {
      const a = dragStart.current, q = geo.current; if (!a || !q) return;
      const z = viewScaleNow();
      editor.set({ cm: { ...editor.get().cm, x: clamp(a.x + g.dx / z / q.W, -0.9, 0.9), y: clamp(a.y + g.dy / z / q.H, -0.9, 0.9) } });
    },
    onPanResponderRelease: () => setBusy(false),
    onPanResponderTerminate: () => setBusy(false)
  }), []);
  const resize = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => {
      const q = geo.current || { w: 100, h: 50, W: 315, H: 682, align: "center", svgMode: false };
      const cm0 = editor.get().cm;
      resizeStart.current = { x: fin(cm0.x), y: fin(cm0.y), s: fin(cm0.s, 1), bw: Math.max(30, fin(q.w, 100)), bh: Math.max(20, fin(q.h, 50)), align: q.align, W: Math.max(1, fin(q.W, 315)), H: Math.max(1, fin(q.H, 682)) };
      setBusy(true);
    },
    onPanResponderMove: (_, g) => {
      const a = resizeStart.current;
      if (!a) return;
      // The corner is dragged around the clock's center. The scale is the projection of the new corner on the old corner direction:
      // it changes smoothly with the finger, whichever way it moves (no jump when the move turns from sideways to up / down).
      const hw = a.bw / 2, hh = a.bh / 2;
      const proj = ((hw + g.dx / viewScaleNow()) * hw + (hh + g.dy / viewScaleNow()) * hh) / (hw * hw + hh * hh);
      if (!isFinite(proj)) return;
      // The clock is laid out without any width limit, so it really grows. It can grow until it fills the screen width.
      // (maxW was never defined here -> ReferenceError on every resize; that was the crash)
      const maxW = a.W;
      const sMax = a.bw >= maxW ? a.s : Math.min(4, a.s * maxW / a.bw);
      const s = clamp(a.s * proj, 0.4, Math.max(0.4, sMax));
      const grow = s / a.s - 1;
      // the clock grows from its top (and from its left / right edge when aligned that way): shift it back so the center stays put
      const dy = -(a.bh * grow) / 2 / a.H;
      const dx = a.align === "center" ? 0 : (a.align === "left" ? -1 : 1) * (a.bw * grow) / 2 / a.W;
      editor.set({ cm: { x: clamp(a.x + dx, -0.9, 0.9), y: clamp(a.y + dy, -0.9, 0.9), s } });
    },
    onPanResponderRelease: () => setBusy(false),
    onPanResponderTerminate: () => setBusy(false)
  }), []);

  const OUT = 6, HANDLE = 44;
  const edge = busy ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.45)";
  const fl = fr ? fr.l - OUT : 0, ft = fr ? fr.t - OUT : 0, fw = fr ? fr.w + 2 * OUT : 0, fh = fr ? fr.h + 2 * OUT : 0;
  return (
    <>
      <EditorClock k={k} anim={anim} onBox={setBox} />
      {fr && (
        <Animated.View pointerEvents="box-none" style={[StyleSheet.absoluteFill, { opacity: anim.opacity }]}>
          <View {...drag.panHandlers} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={{ position: "absolute", left: fl, top: ft, width: fw, height: fh, borderWidth: 1.5, borderStyle: "dashed", borderColor: edge, borderRadius: 10 }} />
          <View {...resize.panHandlers} style={{ position: "absolute", left: fl + fw + 3 - HANDLE, top: ft + fh + 3 - HANDLE, width: HANDLE, height: HANDLE }}>
            <View style={{ position: "absolute", right: 3, bottom: 3, width: 24, height: 24, borderRightWidth: 4, borderBottomWidth: 4, borderBottomRightRadius: 14, borderColor: busy ? C.primary : "#FFFFFF" }} />
          </View>
        </Animated.View>
      )}
    </>
  );
});

// layers that sit in front of the clock (everything after the layer named by clock.above)
function foregroundLayers(w) {
  const layers = (w && w.meta && w.meta.layers) || [];
  const at = layers.findIndex(l => l.id === (w.meta.clock && w.meta.clock.above));
  return layers.slice(at >= 0 ? at + 1 : 1).map(l => releaseUrl(l.file));
}
// same transform + filters as the background so the two stay aligned in Adjust/Effects
function PreviewForeground({ w, hidden, uri: photoUri }) {
  const fx = useEditor(s => s.fx);
  const pos = useEditor(s => s.depth);
  const dUri = useDepth(s => s.uri), dLayers = useDepth(s => s.layers);
  const uris = useMemo(() => foregroundLayers(w), [w]);
  const filter = fxFilter(fx);
  // analyzed in the Depth tab: the photo clipped by the union of the Over layers' masks (same small mask the wallpaper uses)
  const analyzed = !!DepthCore && dUri === photoUri && dLayers.length > 0;
  const maskUri = useMemo(() => {
    if (!analyzed) return null;
    try { const b = DepthCore.tools.encodeForegroundMask({ layers: depthLayersWithPos(dLayers, pos) }, { output: "base64" }); return b ? (b.startsWith("data:") ? b : "data:image/png;base64," + b) : null; }
    catch (e) { return null; }
  }, [analyzed, dLayers, pos]);
  if (analyzed) {
    if (!maskUri || !MaskedViewC) return null;
    return (
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: hidden ? 0 : 1 }]}>
        <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ translateX: motion.tx }, { translateY: motion.ty }, { scale: motion.scale }, { rotate: motionRot }] }]}>
          <View style={[StyleSheet.absoluteFill, filter.length ? { filter } : null]}>
            <MaskedViewC style={StyleSheet.absoluteFill} maskElement={<Image source={{ uri: maskUri }} style={StyleSheet.absoluteFill} resizeMode="cover" />}>
              <Image source={{ uri: photoUri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
            </MaskedViewC>
          </View>
        </Animated.View>
      </View>
    );
  }
  if (!uris.length) return null;
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: hidden ? 0 : 1 }]}>
      <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ translateX: motion.tx }, { translateY: motion.ty }, { scale: motion.scale }, { rotate: motionRot }] }]}>
        <View style={[StyleSheet.absoluteFill, filter.length ? { filter } : null]}>
          {uris.map(uri => <Image key={uri} source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />)}
        </View>
      </Animated.View>
    </View>
  );
}

// ---------- clock rendering (preview + style cards share it) ----------
// 5x7 dot-matrix digits (Nothing-style). ":" is a single narrow column.
const DOT_GLYPHS = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  ":": ["0", "0", "1", "0", "1", "0", "0"]
};
function DotLine({ text, from, color, accent, pitch, spacing, shape, ghost, op }) {
  const dia = pitch * 0.74;
  const gap = Math.max(0, pitch * 1.5 + spacing);
  const els = [];
  let x = 0;
  text.split("").forEach((ch, gi) => {
    const g = DOT_GLYPHS[ch];
    if (!g) return;
    const cols = g[0].length;
    const fill = gi >= from ? accent : color;
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < cols; c++) {
        const on = g[r][c] === "1";
        if (!on && (!ghost || ch === ":")) continue;
        const px = x + c * pitch, py = r * pitch;
        const o = on ? 1 : 0.14;
        els.push(shape === "square"
          ? <Rect key={gi + "-" + r + "-" + c} x={px} y={py} width={dia} height={dia} rx={dia * 0.14} fill={fill} opacity={o} />
          : <Circle key={gi + "-" + r + "-" + c} cx={px + dia / 2} cy={py + dia / 2} r={dia / 2} fill={fill} opacity={o} />);
      }
    }
    x += (cols - 1) * pitch + dia + gap;
  });
  return <Svg width={Math.max(1, x - gap)} height={6 * pitch + dia} style={{ opacity: op }}>{els}</Svg>;
}

// What the glass looks through: the wallpaper of the frame the clock is drawn in (phone preview or a style card)
const GlassCtx = React.createContext(null);
function EditorGlassFrame({ frameRef, w, h, uri, children }) {
  const fx = useEditor(s => s.fx);
  const value = useMemo(() => ({ frameRef, w, h, uri, fx, dim: 0, moving: true }), [frameRef, w, h, uri, fx]);
  return <GlassCtx.Provider value={value}>{children}</GlassCtx.Provider>;
}

// Glass text. Every glyph (digits, ":" and the date letters) gets its own edge light and dark edge:
// the lit edge is "text minus the same text pushed away from the light", the dark edge is the opposite,
// so the effect follows each shape separately, at any angle.
function GlassSvg({ uid, d, k, parts, nz, common, lh, width, op, color, acc, inLine }) {
  const g = React.useContext(GlassCtx);
  const ref = useRef(null);
  const [pos, setPos] = useState({ x: 0, y: 0, w: 0 });
  const measure = useCallback(() => {
    const node = ref.current, frame = g && g.frameRef && g.frameRef.current;
    if (!node || !frame || !node.measureLayout) return;
    try {
      node.measureLayout(frame, (x, y, w) => {
        setPos(p => (Math.abs(p.x - x) < 0.5 && Math.abs(p.y - y) < 0.5 && Math.abs(p.w - w) < 0.5 ? p : { x, y, w }));
      }, () => {});
    } catch (e) { /* ignore */ }
  }, [g]);
  useEffect(() => { measure(); }); // the box moves when any slider changes: re-measure after each commit (state only changes when the position did)
  const t = d.glass / 100, bl = d.glassBlur / 100, ed = d.glassEdge / 100;
  const gsOn = d.glassStrokeOn === "on" && d.glassStrokeOpacity > 0, gsW = Math.max(0.5, fin(d.glassStrokeW * k * 1.2, 1));   // same width scale as the normal stroke
  const gx = d.groupGap * k;
  const needSpans = gx > 0 || (color !== acc && parts.some(p => p.acc)); // otherwise ONE plain string: all layers line up exactly
  const full = parts.map(p => nz(p.t)).join("");
  const T = (props, perPart) => (
    <SvgText {...common} {...props}>
      {needSpans
        ? parts.map((p, i) => <TSpan key={i} dx={i && gx ? gx : undefined} letterSpacing={common.letterSpacing} {...(perPart ? perPart(p) : null)}>{nz(p.t)}</TSpan>)
        : full}
    </SvgText>
  );
  const topA = 0.12 + 0.8 * t, botA = 0.02 + 0.73 * t;
  const th = (d.glassAngle * Math.PI) / 180, sx = Math.sin(th), sy = -Math.cos(th);   // unit vector pointing to the light
  const edgeWOf = (pct) => Math.max(0.5, (0.4 + 3.6 * (pct / 100)) * k * 1.3);   // thickness of a light / dark edge
  // Edges are always INLINE: they are cut out of the glyph itself (never drawn outside the digit).
  // Two independent edges, each can sit on one side or on both. Where both want the same side, the LIGHT edge wins.
  const lightP = d.glassLight === "off" ? null : { c: "#FFFFFF", a: (d.glassLightA != null ? d.glassLightA : d.glassEdge) / 100, w: edgeWOf(d.glassLightW != null ? d.glassLightW : d.glassEdgeW) };
  const darkP = d.glassDark === "off" ? null : { c: "#000000", a: (d.glassDarkA != null ? d.glassDarkA : d.glassEdge) / 100, w: edgeWOf(d.glassDarkW != null ? d.glassDarkW : d.glassEdgeW) };
  const litP = lightP || (darkP && d.glassDarkSides === "both" ? darkP : null);                 // side facing the light
  const oppP = lightP && d.glassLightSides === "both" ? lightP : darkP;                         // side facing away from the light
  const edgeSides = [{ key: "L", p: litP, dir: -1 }, { key: "O", p: oppP, dir: 1 }].filter(e => e.p && e.p.a > 0);
  const STEPS = g && !g.moving ? 2 : 4;                       // style cards use fewer steps (cheaper)
  const steps = Array.from({ length: STEPS }, (_, i) => i + 1);
  // per-strip opacity: stacked strips compose as 1-(1-a)^n, a bit above ed/STEPS keeps the strongest edge close to the chosen value
  const stepAOf = (a) => Math.min(1, (a * 1.45) / STEPS);
  const colors = color === acc ? [color] : [color, acc];
  const gid = (c) => uid + "b" + c.replace("#", "");
  const bodyFill = (c) => "url(#" + gid(c) + ")";
  const maskBox = { maskUnits: "userSpaceOnUse", x: "0", y: "0", width, height: lh };
  // ---- blurred wallpaper seen only through the glyph shapes ----
  const fill = StyleSheet.absoluteFill;
  const blurPx = g ? Math.min(40, bl * 36 * (g.w / 315)) : 0;
  const ready = !!g && pos.w > 0 && blurPx > 0.5 && !!MaskedViewC;
  let backdrop = null;
  if (ready) {
    const tx = (d.offsetX / 100) * 315 * k, ty = (d.offsetY / 100) * 315 * k;   // the clock's own move
    const sX = inLine ? d.widthScale / 100 : 1, sY = inLine ? d.stretch / 100 : 1; // stretch is undone so the picture is not squashed
    const alignOff = d.align === "left" ? 0 : d.align === "right" ? pos.w : pos.w / 2;
    const wrap = { position: "absolute", left: -(pos.x + tx), top: -(pos.y + ty), width: g.w, height: g.h, transform: [{ scaleX: 1 / sX }, { scaleY: 1 / sY }], transformOrigin: (pos.x + tx + alignOff) + "px " + (pos.y + ty + lh / 2) + "px" };
    const ovl = d.glassBlend === "overlay";   // overlay: the sharp wallpaper is drawn first, the blurred copy is blended over it (mixBlendMode needs RN 0.76+ new architecture; older builds just show the normal blur)
    const layer = (blur) => {
      const im = <FxImage uri={g.uri} fx={g.fx} blurRadius={blur} />;
      return g.moving
        ? <Animated.View style={[fill, { transform: [{ translateX: motion.tx }, { translateY: motion.ty }, { scale: motion.scale }, { rotate: motionRot }] }]}>{im}</Animated.View>
        : im;
    };
    backdrop = (
      <MaskedViewC style={fill} pointerEvents="none" maskElement={
        <View style={{ flex: 1, backgroundColor: "transparent" }}>
          <Svg width={width} height={lh}>{T({ fill: "#000000" })}</Svg>
        </View>
      }>
        <View style={fill}>
          <View pointerEvents="none" style={[wrap, ovl ? { isolation: "isolate" } : null]}>
            {ovl && layer(0)}
            {ovl
              ? <View pointerEvents="none" style={[fill, { mixBlendMode: "overlay", opacity: clamp(d.glassBlendAmt / 100, 0, 1) }]}>{layer(blurPx)}</View>
              : layer(blurPx)}
            {g.dim > 0 && <View style={[fill, { backgroundColor: "#000", opacity: g.dim }]} />}
          </View>
        </View>
      </MaskedViewC>
    );
  }
  return (
    <View ref={ref} collapsable={false} onLayout={measure} style={{ width, height: lh, opacity: op }}>
    {backdrop}
    <Svg width={width} height={lh} style={fill}>
      <Defs>
        {colors.map(c => (
          <LinearGradient key={c} id={gid(c)} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2={lh}>
            <Stop offset="0" stopColor={c} stopOpacity={topA} />
            <Stop offset="1" stopColor={c} stopOpacity={botA} />
          </LinearGradient>
        ))}
        {/* Soft edges: STEPS nested strips, every one starting exactly at the glyph boundary on the lit (or dark) side and
            reaching 1/STEPS, 2/STEPS ... of the thickness inward. Stacked, they fade out gradually towards the inside, and
            because all of them are anchored to the boundary the edge never drifts away from the digit when the thickness changes. */}
        {edgeSides.map(e => steps.map(m => (
          <Mask key={e.key + m} id={uid + e.key + m} {...maskBox}>
            {T({ fill: "#FFFFFF" })}
            <G transform={[{ translateX: e.dir * sx * e.p.w * m / STEPS }, { translateY: e.dir * sy * e.p.w * m / STEPS }]}>{T({ fill: "#000000" })}</G>
          </Mask>
        )))}
      </Defs>
      {needSpans ? T({ fill: "none" }, p => ({ fill: bodyFill(p.acc ? acc : color) })) : T({ fill: bodyFill(color) })}
      {[...edgeSides].reverse().map(e => steps.map(m => <React.Fragment key={"e" + e.key + m}>{T({ fill: e.p.c, fillOpacity: stepAOf(e.p.a), mask: "url(#" + uid + e.key + m + ")" })}</React.Fragment>))}
      {/* stroke: centred on the border of every digit, own colour / width / opacity */}
      {gsOn && T({ fill: "none", stroke: d.glassStrokeColor || "#FFFFFF", strokeOpacity: clamp(fin(d.glassStrokeOpacity, 60) / 100, 0, 1), strokeWidth: gsW, strokeLinejoin: "round" })}
    </Svg>
    </View>
  );
}
// a piece of date text drawn as glass (box is sized from the text length, the text sits inside it by alignment)
function GlassText({ uid, d, k, text, fs, weight, spacing, color, op, align }) {
  const lh = fs * 1.35;
  const w = Math.max(fs, text.length * fs * 0.75 + fs * 0.4);
  const a = align === "left" ? "start" : align === "right" ? "end" : "middle";
  const x = align === "left" ? 2 : align === "right" ? w - 2 : w / 2;
  const common = { x, y: lh / 2 + fs * 0.36, fontSize: fs, fontWeight: weight, letterSpacing: spacing, textAnchor: a };
  return <GlassSvg uid={uid} d={d} k={k} parts={[{ t: text, acc: false }]} nz={(v) => v} common={common} lh={lh} width={w} op={op} color={color} acc={color} />;
}

// Glass text drawn with SVG (gradient fill + soft light / dark edges + optional stroke)
function SvgLine({ uid, parts, d, color, acc, k, fs, lh, rf, nz, op, width }) {
  const anchor = d.align === "left" ? "start" : d.align === "right" ? "end" : "middle";
  const ax = d.align === "left" ? 3 : d.align === "right" ? "100%" : "50%";
  const by = lh / 2 + fs * 0.36; // baseline that centres the digits vertically
  const common = { x: ax, y: by, fontSize: fs, fontFamily: rf.fontFamily, fontWeight: rf.fontWeight, letterSpacing: d.spacing * k, textAnchor: anchor };
  return <GlassSvg uid={uid} d={d} k={k} parts={parts} nz={nz} common={common} lh={lh} width={width} op={op} color={color} acc={acc} inLine />;
}

// ---------- every non-glass look in ONE renderer: solid / stroke / fade / two-tone, freely combined ----------
// Each digit is its own <SvgText> placed at a measured x (the widths of the text prefixes are measured with hidden RN Texts,
// so the layout is exactly the one the plain Text uses). No <TSpan> is used at all: that was what shifted the clock to the right
// and left a gap after the colon in the old Fade modes.
const lineChars = (parts, nz) => {
  const out = [];
  parts.forEach((p, pi) => Array.from(nz(p.t)).forEach(ch => out.push({ ch, pi, acc: !!p.acc })));
  return out;
};
function gradDef(id, c1, c2, angle, cx, cy, bw, bh, stops) {
  const th = (fin(angle, 180) * Math.PI) / 180, dx = Math.sin(th), dy = -Math.cos(th);
  const half = Math.max(1, Math.abs((bw / 2) * dx) + Math.abs((bh / 2) * dy));
  return (
    <LinearGradient key={id} id={id} gradientUnits="userSpaceOnUse" x1={fin(cx - dx * half)} y1={fin(cy - dy * half)} x2={fin(cx + dx * half)} y2={fin(cy + dy * half)}>
      {(stops && stops.length > 1 ? stops : [c1, c2]).map((c, i, a) => <Stop key={i} offset={String(i / (a.length - 1))} stopColor={c} stopOpacity="1" />)}
    </LinearGradient>
  );
}
// Arabic-script letters (not the digits): a word drawn letter by letter would lose its joined shapes, so it is drawn as one string
const ARABIC_LETTER = /[\u0621-\u065F\u066E-\u06D3\u06FA-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u200C]/;
const StyledLine = memo(function StyledLine({ uid, d, parts, pw, fs, lh, rf, nz, k, color, tone, acc, base, op, block }) {
  const chars = useMemo(() => lineChars(parts, nz), [parts, nz]);
  const N = chars.length;
  const gapPx = fin(d.groupGap * k);
  const pre = (i) => { const v = pw && pw[i] != null ? pw[i] : i * fs * 0.62; return fin(v, i * fs * 0.62); };
  const xs = chars.map((c, i) => pre(i) + gapPx * c.pi);
  const cws = chars.map((c, i) => Math.max(1, pre(i + 1) - pre(i)));
  const lw = Math.max(1, pre(N) + gapPx * Math.max(0, parts.length - 1));
  // segments: one per character, except a word / run of Arabic-script letters (kept together, spaces inside a phrase included)
  const segs = [];
  for (let i = 0; i < N;) {
    let j = i + 1;
    if (ARABIC_LETTER.test(chars[i].ch)) {
      while (j < N && chars[j].pi === chars[i].pi && (ARABIC_LETTER.test(chars[j].ch) || (chars[j].ch === " " && j + 1 < N && chars[j + 1].pi === chars[i].pi && ARABIC_LETTER.test(chars[j + 1].ch)))) j++;
    }
    segs.push({ a: i, b: j, rtl: j - i > 1 || ARABIC_LETTER.test(chars[i].ch) });
    i = j;
  }
  const segW = (sg) => (sg.b - sg.a === 1 ? cws[sg.a] : xs[sg.b - 1] + cws[sg.b - 1] - xs[sg.a]);
  const strokeOn = d.strokeOn === "on";
  const fadeOn = d.fadeOn === "on", sFadeOn = strokeOn && d.sFadeOn === "on";
  const sw = Math.max(0.5, fin(d.stroke * k * 1.2, 1));
  const PX = Math.ceil(fs * 0.3 + sw), PY = Math.ceil(fs * 0.12 + sw);
  const by = PY + lh / 2 + fs * 0.36;
  const inkH = Math.max(1, fs * 0.74);
  // geometry of the gradient: whole clock (block given by the clock, or this line) or every digit on its own
  const own = { cx: lw / 2, cy: lh / 2, bw: lw, bh: inkH };
  const blk = block || own;
  const defs = [];
  const addGrad = (tag, on, c1, c2, angle, scope, stops) => {
    if (!on) return;
    if (scope === "each") segs.forEach((sg, j) => defs.push(gradDef(uid + tag + j, c1, c2, angle, PX + xs[sg.a] + segW(sg) / 2, PY + lh / 2, segW(sg), inkH, stops)));
    else defs.push(gradDef(uid + tag, c1, c2, angle, PX + blk.cx, PY + blk.cy, blk.bw, blk.bh, stops));
  };
  addGrad("B", fadeOn, d.fadeC1, d.fadeC2, d.fadeAngle, d.fadeScope, d.fadeStops);
  addGrad("S", sFadeOn, d.sC1, d.sC2, d.sAngle, d.sScope, d.sStops);
  const bodyPaint = (c, j) => (fadeOn ? "url(#" + uid + "B" + (d.fadeScope === "each" ? j : "") + ")" : (tone && c.acc ? acc : base));
  const strokePaint = (c, j) => (sFadeOn ? "url(#" + uid + "S" + (d.sScope === "each" ? j : "") + ")" : (d.strokeColor || color));
  const common = (sg) => (sg.b - sg.a > 1 || sg.rtl
    ? { x: PX + xs[sg.a] + segW(sg) / 2, y: by, fontSize: fs, fontFamily: rf.fontFamily, fontWeight: rf.fontWeight, textAnchor: "middle" }
    : { x: PX + xs[sg.a], y: by, fontSize: fs, fontFamily: rf.fontFamily, fontWeight: rf.fontWeight, textAnchor: "start" });
  const word = (sg) => chars.slice(sg.a, sg.b).map(c => c.ch).join("");
  return (
    <View pointerEvents="none" style={{ width: lw, height: lh }}>
      <Svg width={lw + 2 * PX} height={lh + 2 * PY} style={{ position: "absolute", left: -PX, top: -PY, opacity: op }}>
        {defs.length > 0 && <Defs>{defs}</Defs>}
        {segs.map((sg, j) => <SvgText key={"f" + j} {...common(sg)} fill={bodyPaint(chars[sg.a], j)}>{word(sg)}</SvgText>)}
        {strokeOn && segs.map((sg, j) => <SvgText key={"s" + j} {...common(sg)} fill="none" stroke={strokePaint(chars[sg.a], j)} strokeWidth={sw} strokeOpacity={clamp(fin(d.strokeOpacity, 100) / 100, 0, 1)} strokeLinejoin="round">{word(sg)}</SvgText>)}
      </Svg>
    </View>
  );
});

// one line of the clock; `s` stretches it vertically, `w` horizontally (anchored to the alignment side)
function StretchBox({ h, s, w, origin, dx, mt, full, children }) {
  return (
    <View style={{ marginTop: mt, height: h * s, justifyContent: "center", alignSelf: full ? "stretch" : undefined, transform: dx ? [{ translateX: dx }] : undefined }}>
      <View style={{ height: h, transform: [{ scaleY: s }, { scaleX: w }], transformOrigin: origin }}>{children}</View>
    </View>
  );
}
const hexA = (hex, a) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return "rgba(0,0,0," + a + ")";
  const n = parseInt(m[1], 16);
  return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
};
const rootTransform = (d, k) => [
  { translateX: (d.offsetX / 100) * 315 * k }, { translateY: (d.offsetY / 100) * 315 * k },
  { rotate: d.rotate + "deg" }, { skewX: d.skew + "deg" }
];


let CF_UID = 0;
function ClockFace({ d: dIn, color, k, mini, onBox, live, textLines }) {
  useClockFontsReady();
  const d = normDesign(dIn); // older saved designs miss the new fields / use the old look names
  const uid = useRef("cf" + (++CF_UID) + "_").current;
  // measured widths of the text prefixes of every line: pw[line][n] = width of the first n characters.
  // The SVG looks (glass / stroke / fade) are placed from these, so they sit exactly where the plain Text would.
  const [pw, setPw] = useState({});
  const dots = d.font === "dots";
  const isGlass = d.look === "glass" && !dots;
  const svgMode = isStyledLook(d);
  const rf = resolveFont(d.font, d.weight);
  const base = 68 * (d.size / 100) * k;
  const op = d.opacity / 100;
  const stacked = d.layout === "stacked";
  const fs = stacked ? base * 0.9 : base;
  const lh = stacked ? base * 0.9 : base * 1.06;
  const s = d.stretch / 100;
  const wS = d.widthScale / 100;
  const origin = d.align === "left" ? "0% 50%" : d.align === "right" ? "100% 50%" : "50% 50%";
  const tone = !isGlass && d.twoTone === "on";            // glass is independent: no two-tone
  const toneHour = d.toneOn === "hour";
  const acc = tone ? d.accent : color;
  const baseCol = tone && d.toneA ? d.toneA : color;     // colour of the digits that are not the accent
  const nz = (str) => (dots ? str : numeralize(str, d.numerals));
  const sec = d.seconds === "on";
  // live = { h, m, s, sep } (strings) -> a wallpaper clock from meta.json shows the real time; without it the sample 09:41 is drawn
  // hours "off" = "9": only the first digit from the left is dropped, and only when it is a zero (09 -> 9, 00 -> 0, 10 stays 10)
  const noZero = d.hours === "off" || (d.hours === "auto" && !stacked);
  const stripZ = (h) => (noZero ? String(h).replace(/^0(?=\d)/, "") : h);
  const Hh = stripZ(live ? live.h : "09");
  const sepCh = live ? live.sep : (d.sep === "none" ? "" : d.sep === "dot" ? (dots ? ":" : "\u00B7") : ":");
  const mTxt = live ? (live.m == null ? "" : live.m) : "41";
  const hp = { t: stacked ? Hh : Hh + sepCh, acc: toneHour };
  const mp = { t: stacked || !sec ? mTxt : mTxt + sepCh, acc: !toneHour };
  const sp = { t: live && live.s != null ? live.s : "50", acc: !toneHour };
  const lines = textLines || (stacked ? [[hp], [mp], ...(sec ? [[sp]] : [])] : [sec ? [hp, mp, sp] : [hp, mp]]);   // textLines: the date block draws its own text
  const gapPx = d.groupGap * k;
  const gap = (stacked ? -base * 0.06 : 0) + d.lineGap * k;
  const shadow = d.shadow > 0 && !svgMode ? { textShadowColor: "rgba(0,0,0,0.55)", textShadowRadius: d.shadow * k, textShadowOffset: { width: 0, height: 1 } } : null;
  const time = { color: baseCol, opacity: op, fontFamily: rf.fontFamily, fontWeight: rf.fontWeight, letterSpacing: d.spacing * k, includeFontPadding: false, writingDirection: "ltr", ...shadow };
  const dpos = d.datePos === "below" || d.datePos === "left" || d.datePos === "right" ? d.datePos : "above";   // above | below | left | right
  const below = dpos === "below", beside = dpos === "left" || dpos === "right";
  const dateOn = !textLines && d.showDate === "on" && !mini;
  const gapD = d.dateGap * k;
  const dateEl = dateOn ? (
    <View style={{ marginBottom: dpos === "above" ? gapD : 0, marginTop: below ? gapD : 0, marginRight: dpos === "left" ? gapD : 0, marginLeft: dpos === "right" ? gapD : 0, alignItems: ALIGN[d.align] }}>
      <DateFace d={d} color={color} k={k} o={dateOptsFromDesign(d)} />
    </View>
  ) : null;
  const colStyle = { alignItems: ALIGN[d.align] };
  const lineStr = (parts) => parts.map(p => nz(p.t)).join("");
  // measured width of a whole line (null until the hidden twin Text has been laid out)
  const fullW = (li) => { const arr = pw[li]; const n = lineChars(lines[li], nz).length; return arr && arr[n] != null ? arr[n] : null; };
  // "whole clock" gradients: centre of the gradient = centre of ALL lines together, expressed in each line's own coordinates
  const inkH = fs * 0.74;
  const lineWs = lines.map((parts, li) => { const fw = fullW(li); return (fw != null ? fw : fs * 0.62 * lineStr(parts).length) + gapPx * (parts.length - 1); });
  const colW0 = Math.max(...lineWs);
  const offs = lineWs.map((w, li) => (d.align === "left" ? 0 : d.align === "right" ? colW0 - w : (colW0 - w) / 2) + li * d.lineShift * k);
  const minX = Math.min(...offs), maxX = Math.max(...lineWs.map((w, li) => offs[li] + w));
  const totalH = lines.length * lh * s + (lines.length - 1) * gap;
  const blockFor = (li) => (lines.length < 2 ? null : {
    cx: (minX + maxX) / 2 - offs[li],
    cy: (totalH / 2 - li * (lh * s + gap) - (lh * s) / 2) / s + lh / 2,
    bw: Math.max(1, maxX - minX),
    bh: Math.max(1, totalH / s - (lh - inkH))
  });
  const col = (
    <View style={colStyle}>
      {dpos === "above" && dateEl}
      {lines.map((parts, li) => {
        let h, inner;
        if (dots) {
          const pitch = fs * 0.108;
          h = 6 * pitch + pitch * 0.74;
          const mk = (p, i) => (
            <View key={i} style={{ marginLeft: i ? Math.max(0, pitch * 1.5 + d.spacing * k + gapPx) : 0 }}>
              <DotLine text={p.t} from={p.acc && tone ? 0 : 999} color={baseCol} accent={d.accent} pitch={pitch} spacing={d.spacing * k} shape={d.dotShape} ghost={d.ghost === "on"} op={op} />
            </View>
          );
          inner = parts.length > 1 ? <View style={{ flexDirection: "row" }}>{parts.map(mk)}</View> : mk(parts[0], 0);
        } else if (!svgMode) {
          h = lh;
          inner = gapPx && parts.length > 1 ? (
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              {parts.map((p, i) => <Text key={i} style={[time, { fontSize: fs, lineHeight: lh, marginLeft: i ? gapPx : 0 }, p.acc && tone ? { color: acc } : null]}>{nz(p.t)}</Text>)}
            </View>
          ) : (
            <Text style={[time, { fontSize: fs, lineHeight: lh }]}>
              {parts.map((p, i) => (p.acc && tone ? <Text key={i} style={{ color: acc }}>{nz(p.t)}</Text> : nz(p.t)))}
            </Text>
          );
        } else {
          h = lh;
          if (isGlass) {
            const fw = fullW(li);
            const lw = (fw != null ? fw : fs * 0.62 * lineStr(parts).length) + fs * 0.16 + gapPx * (parts.length - 1);
            inner = <SvgLine uid={uid} parts={parts} d={d} color={color} acc={color} k={k} fs={fs} lh={lh} rf={rf} nz={nz} op={op} width={Math.max(1, Math.ceil(fin(lw, 1)))} />;
          } else {
            inner = <StyledLine uid={uid + li + "_"} d={d} parts={parts} pw={pw[li]} fs={fs} lh={lh} rf={rf} nz={nz} k={k} color={color} tone={tone} acc={acc} base={baseCol} op={op} block={blockFor(li)} />;
          }
        }
        return <StretchBox key={li} h={h} s={s} w={wS} origin={origin} dx={li * d.lineShift * k} mt={li ? gap : 0}>{inner}</StretchBox>;
      })}
      {below && dateEl}
    </View>
  );
  // left / right: the date and the clock side by side, centred on each other
  const content = beside ? <View style={{ flexDirection: "row", alignItems: "center" }}>{dpos === "left" && dateEl}{col}{dpos === "right" && dateEl}</View> : col;
  const pa = d.panelOpacity / 100;
  const panelStyle = d.panel === "on"
    ? { padding: d.panelPad * k, borderRadius: d.panelRadius * k, backgroundColor: d.panelTone === "light" ? "rgba(255,255,255," + pa + ")" : d.panelTone === "accent" ? hexA(d.accent, pa) : "rgba(0,0,0," + pa + ")" }
    : null;
  return (
    <View onLayout={onBox ? (e => onBox(e.nativeEvent.layout)) : undefined} style={{ alignItems: ALIGN[d.align], transform: rootTransform(d, k) }}>
      <View style={[{ alignItems: ALIGN[d.align] }, panelStyle]}>{content}</View>
      {svgMode && (
        // invisible copies of the time text (one per prefix of every line), only to learn exactly where every digit starts
        <View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, width: 6000, opacity: 0, alignItems: "flex-start" }}>
          {lines.map((parts, li) => {
            const cs = lineChars(parts, nz).map(c => c.ch);
            return cs.map((_, j) => (
              <Text key={li + "-" + j} allowFontScaling={false}
                onLayout={(e) => {
                  const w = e.nativeEvent.layout.width;
                  if (!isFinite(w)) return;
                  setPw(m => {
                    const cur = m[li];
                    if (cur && cur[j + 1] != null && Math.abs(cur[j + 1] - w) < 0.5) return m;
                    const nx = cur ? cur.slice() : [];
                    nx[0] = 0; nx[j + 1] = w;
                    return { ...m, [li]: nx };
                  });
                }}
                style={{ fontFamily: rf.fontFamily, fontWeight: rf.fontWeight, fontSize: fs, letterSpacing: d.spacing * k, includeFontPadding: false, writingDirection: "ltr" }}>
                {cs.slice(0, j + 1).join("")}
              </Text>
            ));
          })}
        </View>
      )}
    </View>
  );
}
const EditorClock = memo(function EditorClock({ k, anim, onBox }) {
  const base = useActiveDesign();
  const cm = useEditor(s => s.cm);
  const d = useMemo(() => applyClockMove(base, cm), [base, cm]);
  const color = useEditor(s => s.clockColor);
  const abstract = !!d.arrange && d.arrange !== "flow";
  // The clock's area reaches far past the screen on the sides it can grow to, so a big clock is never wrapped or cut.
  // Left aligned: grows to the right, right aligned: grows to the left, centered: grows both ways.
  const EXTRA = 4 * 315 * k;
  const padL = d.align === "left" ? 22 * k : 0, padR = d.align === "right" ? 22 * k : 0;
  const offL = abstract || d.align === "left" ? 0 : -EXTRA;      // left edge of the area, relative to the screen
  const offR = abstract || d.align === "right" ? 0 : -EXTRA;
  const reportBox = useCallback((b) => { if (onBox) onBox({ ...b, x: b.x + offL }); }, [onBox, offL]);
  return (
    <Animated.View pointerEvents="none" style={{ position: "absolute", top: abstract ? 0 : `${d.top}%`, left: offL, right: offR, paddingLeft: abstract ? 0 : padL, paddingRight: abstract ? 0 : padR, alignItems: abstract ? "flex-start" : ALIGN[d.align], opacity: anim.opacity, transform: [{ translateY: anim.translateY }, { scale: anim.scale }] }}>
      <ClockFace d={d} color={color} k={k} onBox={reportBox} />
    </Animated.View>
  );
});

// ---------- sheet sub-page header (Back on the left, optional Save on the right) ----------
function SubHeader({ title, onBack, onSave, saveLabel = "Save" }) {
  return (
    <View style={st.subHeader}>
      <Press onPress={onBack} style={st.subBack}><AppIcon name="arrow_back" size={20} color={C.text} /></Press>
      <Text style={st.subTitle} numberOfLines={1}>{title}</Text>
      {onSave ? <Press onPress={onSave} style={st.subSave} dim><Text style={st.subSaveText}>{saveLabel}</Text></Press> : null}
    </View>
  );
}

// Horizontal tab strip with a sliding underline (used by "Your design")
const TabStrip = memo(function TabStrip({ tabs, value, onChange, dots }) {
  const [W, setW] = useState(0);
  const idx = Math.max(0, tabs.findIndex(t => t[0] === value));
  const a = useRef(new Animated.Value(idx)).current;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; a.setValue(idx); return; }
    Animated.spring(a, { toValue: idx, ...SPRING }).start();
  }, [idx, a]);
  const w = W / tabs.length;
  return (
    <View onLayout={e => setW(e.nativeEvent.layout.width)} style={st.tabStrip}>
      {tabs.map(([v, label]) => (
        <Pressable key={v} accessibilityRole="tab" accessibilityState={{ selected: v === value }} onPress={() => onChange(v)} style={st.tabItem}>
          <View style={st.tabLabelRow}>
            <Text numberOfLines={1} style={[st.tabText, v === value && { color: C.text }]}>{label}</Text>
            {!!(dots && dots[v]) && <View style={st.tabDot} />}
          </View>
        </Pressable>
      ))}
      {w > 0 && <Animated.View pointerEvents="none" style={[st.tabInd, { width: w - 20, left: 10, transform: [{ translateX: a.interpolate({ inputRange: [0, 1], outputRange: [0, w] }) }] }]} />}
    </View>
  );
});


// The clock of a server / GitHub wallpaper (meta.json) turned into an ordinary design with the same values, so it can be
// shown as a style card and opened with "Customize". Everything that scales with the font (spacing, gaps, shadow, stroke, date size ...)
// is multiplied by m, the ratio between the size meta.json draws the clock at and the size a design is drawn at.
function remoteClockDesign(meta, over) {
  const c = (meta && meta.clock) || {}, dt = meta && meta.date;
  const sty = parseClockStyle(c);
  const U = sty.unit;
  const size = (over && over.size) || c.size || 0.16;
  const cx = over && over.x != null ? over.x : (c.x == null ? 0.5 : c.x);
  const cy = over && over.y != null ? over.y : (c.y == null ? 0.29 : c.y);
  const m = (size * CLOCK_ASPECT * 315) / U;
  const stacked = sty.design.layout === "stacked";
  const rows = stacked ? (sty.design.seconds === "on" ? 3 : 2) : 1;
  // rough height of the drawn clock as a fraction of the screen height (used to turn "centre y" into "distance from top")
  const fsH = size;                                   // font size as a fraction of H
  const clockH = (stacked ? (rows * 0.9 - (rows - 1) * 0.06) * (68 / U) : 1.06) * fsH * (sty.design.stretch / 100);
  const fm = String(c.format || "HHmm");                       // "HH:mm", "h:mm", "HHmm" ...
  const sepTok = (fm.match(/[^HhmsS]+/) || [""])[0].trim();
  const d = {
    ...sty.design,
    weight: String(c.weight || 400),
    hours: /HH|hh/.test(fm) ? "on" : "off",
    sep: sepTok === "" ? "none" : sepTok === ":" ? "colon" : "dot"
  };
  // date: the wallpaper's own date settings -> the design's date settings
  const dateOn = !!dt && dt.show !== false;
  d.showDate = dateOn ? "on" : "off";
  let top = cy - clockH / 2;
  if (dateOn) {
    const ds = parseDateStyle(dt);
    const dFs = dt.size || 0.025;                      // fraction of H
    const dSize = (dFs / size) * U;                    // date size in design units (before the m scaling)
    let pos = ds.place, gap = ds.gap;
    if (pos === "free") {
      const dy = (dt.y != null ? dt.y : cy + 0.1) - cy;
      pos = dy < 0 ? "above" : "below";
      gap = Math.max(0, Math.abs(dy) - clockH / 2 - dFs * 0.7);
    }
    d.dateCal = ds.cal; d.dateWhat = ds.what; d.dateWeekday = ds.weekday; d.dateMonth = ds.month; d.dateOrder = ds.order;
    d.dateDir = ds.vertical ? "vertical" : "horizontal"; d.dateVOrder = ds.vorder;
    d.datePos = pos;
    d.dateSize = dSize;
    d.dateSpacing = ds.spacingEm * dSize;
    d.dateGap = (gap / size) * U;
    d.dateStretch = ds.stretch * 100; d.dateWidthScale = ds.widthScale * 100; d.dateRotate = ds.rotate;
    if (pos === "above") top -= dFs * 1.3 + gap;
  }
  const out = applyClockMove({ ...d, size: 100, offsetX: 0, offsetY: 0 }, { x: 0, y: 0, s: m });
  out.offsetX = (cx - 0.5) * 100;
  out.top = Math.round(top * 1000) / 10;
  out.offsetY = 0;
  return normDesign(out);
}

// ---------- CLOCK tab ----------
const CC_W = 96, CC_H = 104;
const CARD_FX = { ...FX_DEFAULT };
const ClockCard = memo(function ClockCard({ name, d, color, uri, selected, onSelect, onCustomize }) {
  const frameRef = useRef(null);
  const glassValue = useMemo(() => ({ frameRef, w: CC_W, h: CC_H, uri, fx: CARD_FX, dim: 0, moving: false }), [uri]);
  return (
    <View style={st.ccWrap}>
      <Press onPress={onSelect} style={[st.cc, selected && st.ccOn]}>
        <View ref={frameRef} collapsable={false} style={StyleSheet.absoluteFill}>
          <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
          <GlassCtx.Provider value={glassValue}>
            <View pointerEvents="none" style={d.arrange && d.arrange !== "flow" ? { position: "absolute", left: 0, top: 0 } : { position: "absolute", left: 6, right: 6, top: (d.top / 100) * CC_H }}>
              <ClockFace d={d} color={color} k={(d.arrange && d.arrange !== "flow" ? CC_W - 4 : CC_W) / 315} mini />
            </View>
          </GlassCtx.Provider>
        </View>
        {selected && (
          <View style={st.ccFoot}>
            <Pressable accessibilityRole="button" accessibilityLabel="Edit" onPress={onCustomize} hitSlop={4} style={({ pressed }) => [st.ccBtn, pressed && { opacity: 0.7 }]}>
              <Text numberOfLines={1} style={st.ccBtnText}>Edit</Text>
            </Pressable>
            <View style={st.ccCheck}><AppIcon name="check" size={14} color={C.primary} /></View>
          </View>
        )}
      </Press>
      <Text numberOfLines={1} style={[st.ccName, selected && { color: C.primary }]}>{name}</Text>
    </View>
  );
});

// The 16 ready styles, sorted into four families so the gallery is short and easy to scan
const CLOCK_CATS = [
  ["all", "All", null],
  ["glass", "Glass", ["glass", "tallglass", "clearglass", "frost"]],
  ["classic", "Classic", ["rounded", "editorial", "oneserif", "persian"]],
  ["bold", "Bold", ["rhombus", "magazine", "fullstretch", "wide", "widestack"]],
  ["tech", "Tech", ["dots", "dotstack", "metro"]]
];


// colours the clock is drawn with right now (gradient stops, two-tone, or the one clock colour)
function clockColorsOf(d, color) {
  const base = String(color || "#FFFFFF").toUpperCase();
  if (!d || d.look === "glass") return [base];
  if (d.fadeOn === "on") {
    const st = Array.isArray(d.fadeStops) && d.fadeStops.length >= 2 ? d.fadeStops : [d.fadeC1, d.fadeC2];
    return st.map(c => String(c).toUpperCase());
  }
  if (d.twoTone === "on") {
    const b = d.toneA ? String(d.toneA).toUpperCase() : base, a = String(d.accent).toUpperCase();
    return d.toneOn === "hour" ? [a, b] : [b, a];
  }
  return [base];
}
// square showing the colours: 1 = solid, 2 = split diagonally, 3+ = equal slices around the centre
const ColorSwatch = memo(function ColorSwatch({ colors, size = 32 }) {
  const n = colors.length, c = size / 2, r = size * 2;
  const pt = (deg) => { const a = deg * Math.PI / 180; return [c + r * Math.cos(a), c + r * Math.sin(a)]; };
  const a0 = n === 2 ? 135 : -90, step = 360 / n;
  return (
    <View style={{ width: size, height: size, overflow: "hidden", backgroundColor: colors[0] }}>
      {n > 1 && (
        <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
          {colors.map((col, i) => {
            const from = a0 + i * step, to = from + step;
            let dstr = "M" + c + " " + c;
            for (let g = from; g < to - 0.01; g += 30) { const [x, y] = pt(g); dstr += " L" + x.toFixed(2) + " " + y.toFixed(2); }
            const [ex, ey] = pt(to); dstr += " L" + ex.toFixed(2) + " " + ey.toFixed(2) + " Z";
            return <Path key={i} d={dstr} fill={col} />;
          })}
        </Svg>
      )}
    </View>
  );
});

const ClockTab = memo(function ClockTab({ uri, remote, onOpenDesign, onOpenColor }) {
  const clockId = useEditor(s => s.clockId);
  const custom = useEditor(s => s.custom);
  const color = useEditor(s => s.clockColor);
  const rc = useEditor(s => s.rc);
  const meta = remote && remote.meta && remote.meta.clock ? remote.meta : null;
  // the wallpaper's own clock as a normal style card (same values, can be edited)
  const ownDesign = useMemo(() => (meta ? remoteClockDesign(meta) : null), [meta]);
  const customize = (d) => { editor.set({ custom: normDesign(d), clockId: "custom" }); onOpenDesign(); };
  const customizeOwn = () => { customize(remoteClockDesign(meta, rc || undefined)); };   // keeps the place / size the user already gave it
  const activeD = clockId === "remote" && ownDesign ? ownDesign : clockId === "custom" && custom ? custom : (CLOCK_STYLES.find(x => x.id === clockId) || CLOCK_STYLES[0]).d;
  const swatchColors = clockColorsOf(activeD, color);
  return (
    <TabScroll>
      <View style={[st.fxHead, { minHeight: 36 }]}>
        <Text style={st.fxTitle}>Style</Text>
        <View style={st.ctRow}>
          <Press onPress={onOpenColor} scaleTo={0.9} style={st.ctBtn}>
            <AppIcon name="palette" size={18} color={C.text} />
          </Press>
          <View style={st.ctCur}><ColorSwatch colors={swatchColors} size={32} /></View>
        </View>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} nestedScrollEnabled style={st.hList} contentContainerStyle={st.hListContent}>
        {ownDesign && (
          <ClockCard name="Original" d={ownDesign} color={color} uri={uri} selected={clockId === "remote"}
            onSelect={() => editor.set({ clockId: "remote" })} onCustomize={customizeOwn} />
        )}
        {CLOCK_STYLES.map(({ id, name, d }) => (
          <ClockCard key={id} name={name} d={d} color={color} uri={uri} selected={clockId === id}
            onSelect={() => editor.set({ clockId: id })} onCustomize={() => customize(d)} />
        ))}
        {custom && (
          <ClockCard name="Custom" d={custom} color={color} uri={uri} selected={clockId === "custom"}
            onSelect={() => editor.set({ clockId: "custom" })} onCustomize={onOpenDesign} />
        )}
        <View style={st.ccWrap}>
          <Press onPress={() => customize(CLOCK_CLASSIC)} style={[st.cc, st.ccPlus]}>
            <View style={st.ccPlusIcon}><AppIcon name="add" size={24} color={C.text} /></View>
          </Press>
          <Text style={[st.ccName, { color: C.text }]}>{custom ? "New design" : "Your design"}</Text>
        </View>
      </ScrollView>

    </TabScroll>
  );
});

// ---------- "Your design" page (replaces the whole sheet except the handle) ----------
// Every property a clock face can use is editable here, so "Customize" on any ready style shows all of its tools.
const OPT_LAYOUT = [["inline", "Horizontal"], ["stacked", "Stacked"]];   // short labels -> fits on the same line as "Arrange"
const OPT_HOURS = [["on", "09"], ["off", "9"]];   // "9" = drop only the leading zero of the hour (12 h and 24 h alike)
const OPT_SEP = [["colon", ":"], ["dot", "\u00B7"], ["none", "None"]];
const OPT_DATE_CAL = [["gregorian", "Gregorian"], ["jalali", "Shamsi"], ["hijri", "Hijri"]];
const OPT_DATE_WHAT = [["all", "All"], ["weekday", "Weekday"], ["date", "D / M / Y"]];
const OPT_DATE_ORDER = [["dmy", "D M Y"], ["mdy", "M D Y"], ["ymd", "Y M D"], ["ydm", "Y D M"]];
const OPT_DATE_MONTH = [["name", "Name"], ["short", "Short"], ["number", "Number"]];
const OPT_DATE_WD = [["full", "Full"], ["short", "Short"]];
const OPT_DATE_DIR = [["horizontal", "Horizontal"], ["vertical", "Vertical"]];
const OPT_DATE_VORDER = [["dmy", "Day \u2192 Year"], ["ymd", "Year \u2192 Day"]];   // top to bottom
const OPT_DATEPOS = [["above", "Above"], ["below", "Below"], ["left", "Left"], ["right", "Right"]];
const OPT_FONT = [["sans", "Sans"], ["wide", "Wide"], ["quirk", "Quirky"], ["bebas", "Bebas"], ["script", "Handwritten"], ["maze", "Maze"], ["drip", "Drip"], ["serif", "Serif"], ["mono", "Mono"], ["condensed", "Narrow"], ["rounded", "Rounded"], ["grotesk", "Grotesk"], ["tall", "Tall"], ["display", "Display"], ["dots", "Dot matrix"]];
const OPT_WEIGHT = [["100", "Thin"], ["300", "Light"], ["400", "Regular"], ["700", "Bold"], ["900", "Black"]];
const OPT_DATE = [["on", "Show"], ["off", "Hide"]];
const OPT_ALIGN = [["left", "Left"], ["center", "Center"], ["right", "Right"]];
const OPT_LOOK = [["solid", "Solid"], ["glass", "Glass"]];
const OPT_TONEON = [["min", "Minutes"], ["hour", "Hours"]];
const OPT_SCOPE = [["all", "Whole clock"], ["each", "Each digit"]];
const OPT_DATEROT = [["none", "Normal"], ["up", "Up"], ["down", "Down"]];
const OPT_SIDE = [["left", "Left"], ["right", "Right"]];
const OPT_NUMERALS = [["latn", "123"], ["fa", "\u06F1\u06F2\u06F3"], ["ar", "\u0661\u0662\u0663"]];
const OPT_ONOFF = [["off", "Off"], ["on", "On"]];
const OPT_BLEND = [["normal", "Normal"], ["overlay", "Overlay"]];
const OPT_LIGHT_SIDES = [["one", "Lit side"], ["both", "Both sides"]];
const OPT_DARK_SIDES = [["one", "Opposite side"], ["both", "Both sides"]];
const OPT_DOT = [["round", "Round"], ["square", "Square"]];
const OPT_GHOST = [["on", "Show"], ["off", "Hide"]];
const setCustom = (k, v) => editor.set(s => ({ custom: { ...normDesign(s.custom), [k]: v } }));
const customValue = (s, k) => (s.custom ? normDesign(s.custom)[k] : CLOCK_CLASSIC[k]);
// short option lists sit on the same line as their label; long ones drop under it
const segWidth = (options) => options.reduce((a, o) => a + Math.max(52, String(o[1]).length * 7.4 + 24), 6);

const CustomSeg = memo(function CustomSeg({ k, options, label, hint }) {
  const v = useEditor(s => customValue(s, k));
  const w = segWidth(options);
  const inline = w <= 220;
  return (
    <Row label={label} hint={hint} stacked={!inline}>
      <Seg options={options} value={v} onChange={(nv) => setCustom(k, nv)} width={inline ? w : undefined} />
    </Row>
  );
});
// on / off option shown as a switch row
const CustomToggleRow = memo(function CustomToggleRow({ k, label, hint }) {
  const on = useEditor(s => customValue(s, k) === "on");
  const onChange = useCallback((v) => setCustom(k, v ? "on" : "off"), [k]);
  return <Row label={label} hint={hint}><Toggle value={on} onChange={onChange} label={label} /></Row>;
});
// on / off option that owns a block: the switch row sits on top and its options open underneath (on a darker inset) while it is on
const CustomToggleBlock = memo(function CustomToggleBlock({ k, title, hint, children }) {
  const on = useEditor(s => customValue(s, k) === "on");
  const onChange = useCallback((v) => setCustom(k, v ? "on" : "off"), [k]);
  return (
    <>
      <Row label={title} hint={hint}><Toggle value={on} onChange={onChange} label={title} /></Row>
      {on && <Nest>{children}</Nest>}
    </>
  );
});
function CardBox({ children }) { return <View style={st.group}><View style={st.groupInner}>{children}</View></View>; }
const CustomToggleGroup = memo(function CustomToggleGroup({ k, title, hint, children }) {
  return <CardBox><CustomToggleBlock k={k} title={title} hint={hint}>{children}</CustomToggleBlock></CardBox>;
});
// how many of these options differ from the defaults ("2 edited" in the group header); [key, fromKey] for options that start from another key
const useCustomEdited = (keys) => useEditor(s => {
  const c = s.custom;
  if (!c) return 0;
  let n = 0;
  for (const kk of keys) {
    const k = Array.isArray(kk) ? kk[0] : kk, f = Array.isArray(kk) ? kk[1] : kk;
    if (c[k] != null && c[k] !== CLOCK_CLASSIC[f]) n++;
  }
  return n;
});
function EGroup({ keys, ...rest }) { const n = useCustomEdited(keys); return <Group {...rest} edited={n} />; }
// a dot on a tab when something inside it was changed
const DESIGN_TAB_KEYS = {
  time: ["layout", "sep", "seconds", "hours", "numerals"],
  type: ["font", "weight", "dotShape", "ghost", "size", "stretch", "widthScale", "spacing", "groupGap", "lineGap", "lineShift"],
  look: ["look", "glass", "glassBlur", "glassBlend", "glassBlendAmt", "glassAngle", "glassLight", "glassLightSides", "glassLightA", "glassLightW", "glassDark", "glassDarkSides", "glassDarkA", "glassDarkW", "glassStrokeOn", "glassStrokeW", "glassStrokeOpacity", "glassStrokeColor", "twoTone", "toneOn", "accent", "toneA", "fadeOn", "fadeC1", "fadeC2", "fadeAngle", "fadeScope", "strokeOn", "stroke", "strokeOpacity", "strokeColor", "sFadeOn", "sC1", "sC2", "sAngle", "sScope", "opacity", "shadow", "panel", "panelTone", "panelOpacity", "panelRadius", "panelPad"],
  place: ["align", "top", "offsetX", "offsetY", "rotate", "skew"],
  date: ["showDate", "dateCal", "dateWhat", "dateWeekday", "dateMonth", "dateOrder", "dateVOrder", "dateDir", "datePos", "dateGap", "dateSize", "dateSpacing", "dateStretch", "dateWidthScale", "dateRotate"]
};
const designTabMask = (s) => {
  const c = s.custom;
  if (!c) return 0;
  let m = 0;
  Object.keys(DESIGN_TAB_KEYS).forEach((t, i) => {
    if (DESIGN_TAB_KEYS[t].some(k => c[k] != null && CLOCK_CLASSIC[k] !== undefined && c[k] !== CLOCK_CLASSIC[k])) m |= (1 << i);
  });
  return m;
};
// font gallery: every font shown as a sample of itself
const FontGrid = memo(function FontGrid({ k, options }) {
  useClockFontsReady();
  const v = useEditor(s => customValue(s, k));
  const mine = useUserFonts();
  const all = useMemo(() => [...options, ...mine.map(f => [f.id, f.name])], [options, mine]);
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} nestedScrollEnabled contentContainerStyle={st.fontStrip}>
      {all.map(([val, label]) => {
        const on = val === v;
        return (
          <Press key={val} onPress={() => setCustom(k, val)} style={[st.fontTile, on && st.fontTileOn]}>
            <View style={st.fontSampleBox}>
              {val === "dots"
                ? <Text numberOfLines={1} allowFontScaling={false} style={[st.fontSample, { letterSpacing: 3 }, on && { color: C.text }]}>{"\u2022\u2022\u2022"}</Text>
                : <Text numberOfLines={1} allowFontScaling={false} style={[st.fontSample, resolveFont(val, "400"), { lineHeight: 26, includeFontPadding: false }, on && { color: C.text }]}>09:41</Text>}
            </View>
            <Text numberOfLines={1} style={[st.fontName, on && { color: C.primary }]}>{label}</Text>
          </Press>
        );
      })}
    </ScrollView>
  );
});
// reads its start value when it mounts, so tools that appear later (glass, stroke...) start at the real value
// `from`: key to read the start value from while this key has no value of its own yet (glass edges follow glassEdge / glassEdgeW until touched)
const SLIDER_ICON = {
  size: "format_size", stretch: "height", widthScale: "swap_horiz", spacing: "format_letter_spacing", groupGap: "space_bar", lineGap: "format_line_spacing", lineShift: "subdirectory_arrow_right",
  glass: "opacity", glassBlur: "lens_blur", glassBlendAmt: "blur_on", glassAngle: "light_mode",
  glassLightA: "opacity", glassLightW: "line_weight", glassDarkA: "opacity", glassDarkW: "line_weight", glassStrokeW: "line_weight", glassStrokeOpacity: "opacity",
  fadeAngle: "rotate_right", stroke: "line_weight", strokeOpacity: "opacity", sAngle: "rotate_right",
  opacity: "opacity", shadow: "tonality", panelOpacity: "opacity", panelRadius: "rounded_corner", panelPad: "crop_square",
  top: "vertical_align_top", offsetX: "swap_horiz", offsetY: "swap_vert", rotate: "rotate_right", skew: "format_italic",
  dateGap: "space_bar", dateSize: "format_size", dateSpacing: "format_letter_spacing", dateStretch: "height", dateWidthScale: "swap_horiz", dateRotate: "rotate_right"
};
const CustomSlider = memo(function CustomSlider({ k, from, icon, ...rest }) {
  const rev = useHistRev(); // undo / redo: start again from the restored value
  const cur = editor.get().custom;   // re-read on every render; the slider only uses it when it (re)mounts, i.e. when `rev` changes
  const fb = from ? (cur && cur[from] != null ? cur[from] : CLOCK_CLASSIC[from]) : CLOCK_CLASSIC[k];
  const init = cur && cur[k] != null ? cur[k] : fb;
  const onChange = useCallback((v) => setCustom(k, v), [k]);
  return <ValueSlider key={rev} showLabel {...rest} initial={init} def={from ? CLOCK_CLASSIC[from] : CLOCK_CLASSIC[k]} onChange={onChange} />;
});
// colour picker row: ready swatches + a hex box (any colour). `clockOption` adds a "Clock" chip meaning "use the clock colour" (stored as "")
const COLOR_CHOICES = ["#FFFFFF", "#000000", "#D0BCFF", "#8AB4F8", "#81C995", "#FDD663", "#F6AE99", "#F28BCB", "#FF4B3E", "#C6F432", "#FF8A2B", "#3DDCFF"];
const ColorField = memo(function ColorField({ k, clockOption, label }) {
  const v = useEditor(s => String(customValue(s, k) || "").toUpperCase());
  const [text, setText] = useState(v);
  useEffect(() => { setText(v); }, [v]);
  const onText = (t) => {
    const up = t.toUpperCase();
    setText(up);
    const norm = up.startsWith("#") ? up : "#" + up;
    if (/^#[0-9A-F]{6}$/.test(norm)) setCustom(k, norm);
  };
  return (
    <Row label={label} stacked>
      <View style={{ gap: 10 }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} nestedScrollEnabled style={st.hBleed} contentContainerStyle={st.hBleedContent}>
          {clockOption && (
            <Press onPress={() => setCustom(k, "")} style={[st.chip, { marginRight: 8, alignSelf: "center" }, v === "" && st.chipOn]}>
              <Text style={[st.chipText, v === "" && { color: C.primary }]}>Clock</Text>
            </Press>
          )}
          {COLOR_CHOICES.map(c => (
            <Press key={c} onPress={() => setCustom(k, c)} style={[st.swOuter, v === c && st.swOuterOn]} scaleTo={0.88}>
              <View style={[st.swDot, { backgroundColor: c }]} />
            </Press>
          ))}
        </ScrollView>
        <View style={st.cpRow}>
          <View style={[st.cpSwatch, { backgroundColor: /^#[0-9A-F]{6}$/.test(v) ? v : "transparent" }]} />
          <View style={st.cpHexBox}>
            <TextInput value={text} onChangeText={onText} autoCapitalize="characters" autoCorrect={false} maxLength={7} selectionColor={C.primary} placeholder={clockOption ? "Clock colour" : "#RRGGBB"} placeholderTextColor={C.muted} style={st.cpHexInput} />
          </View>
        </View>
      </View>
    </Row>
  );
});
// shows its children only while `when(design)` is true (so the page lists just the tools the current face uses)
function Show({ when, children }) {
  const on = useEditor(s => when(normDesign(s.custom)));
  return on ? <>{children}</> : null;
}

// Five tabs, one job each:  Time (what the clock shows) · Type (font, size, spacing) · Look (colour, glass, outline)
// · Place (where it sits) · Date (everything about the date line)
const DESIGN_TABS = [["time", "Time"], ["type", "Type"], ["look", "Look"], ["place", "Place"], ["date", "Date"]];
const isFlow = d => d.arrange === "flow";
const hasGlyphFont = d => d.font !== "dots";
const canLook = d => isFlow(d) && hasGlyphFont(d);        // glass / gradient / outline need the glyph renderer
const isGlass = d => canLook(d) && d.look === "glass";


// Look / Time / Place / Date work like Effects > Tools: a row of chips, tap one to open its controls underneath (tap again to close).
// tool = [id, label, icon, when(design) | null, [keys it edits]]
const TIME_TOOLS = [
  ["layout", "Layout", "view_module", null, ["layout", "sep", "seconds"]],
  ["digits", "Digits", "schedule", null, ["hours", "numerals"]]
];
const LOOK_TOOLS = [
  ["glass", "Glass", "opacity", isGlass, ["glass", "glassBlur", "glassAngle", "glassBlend", "glassBlendAmt"]],
  ["edges", "Edges", "border_style", isGlass, ["glassLight", "glassLightSides", "glassLightA", "glassLightW", "glassDark", "glassDarkSides", "glassDarkA", "glassDarkW", "glassStrokeOn", "glassStrokeW", "glassStrokeOpacity", "glassStrokeColor"]],
  ["twoTone", "Two-tone", "palette", d => !isGlass(d), ["twoTone", "toneOn", "accent", "toneA"]],
  ["gradient", "Gradient", "tonality", d => canLook(d) && d.look !== "glass", ["fadeOn", "fadeC1", "fadeC2", "fadeAngle", "fadeScope"]],
  ["outline", "Outline", "line_weight", d => canLook(d) && d.look !== "glass", ["strokeOn", "stroke", "strokeOpacity", "strokeColor", "sFadeOn", "sC1", "sC2", "sAngle", "sScope"]],
  ["finish", "Finish", "auto_awesome", null, ["opacity", "shadow"]],
  ["panel", "Panel", "crop_square", isFlow, ["panel", "panelTone", "panelOpacity", "panelRadius", "panelPad"]]
];
const PLACE_TOOLS = [
  ["position", "Position", "open_with", null, ["align", "top", "offsetX", "offsetY"]],
  ["rotate", "Rotate", "rotate_right", null, ["rotate", "skew"]]
];
const DATE_TOOLS = [
  ["show", "Format", "calendar_today", null, ["dateCal", "dateWhat", "dateWeekday", "dateMonth", "dateOrder", "dateVOrder"]],
  ["placement", "Placement", "open_with", null, ["dateDir", "datePos", "dateGap"]],
  ["text", "Text", "text_fields", null, ["dateSize", "dateSpacing", "dateStretch", "dateWidthScale", "dateRotate"]]
];
function DesignTools({ tools, panes, disabledWhen }) {
  const [sel, setSel] = useState(null);
  const vis = useEditor(s => { const d = normDesign(s.custom); return tools.filter(t => !t[3] || t[3](d)).map(t => t[0]).join(","); });
  const chg = useEditor(s => { const c = s.custom; if (!c) return ""; return tools.filter(t => t[4].some(k => c[k] != null && CLOCK_CLASSIC[k] !== undefined && c[k] !== CLOCK_CLASSIC[k])).map(t => t[0]).join(","); });
  const ids = vis.split(",");
  const shown = tools.filter(t => ids.includes(t[0]));
  const changed = {};
  chg.split(",").forEach(k => { if (k) changed[k] = true; });
  const off = useEditor(s => (disabledWhen ? !!disabledWhen(normDesign(s.custom)) : false));   // chips stay visible but dimmed and locked
  const cur = !off && sel && ids.includes(sel) ? sel : null;
  return (
    <>
      <ToolChips tools={shown} selected={cur} changed={changed} onSelect={setSel} fill={shown.length <= 4} disabled={off} />
      {cur ? <CardBox>{panes[cur]}</CardBox> : null}
    </>
  );
}
const MaterialHead = memo(function MaterialHead() {
  const v = useEditor(s => customValue(s, "look"));
  return (
    <View style={st.fxHead}>
      <Text style={st.fxTitle}>Material</Text>
      <Seg options={OPT_LOOK} value={v} onChange={(nv) => setCustom("look", nv)} height={36} width={176} />
    </View>
  );
});

// Section title (left) + its main control (right), the same row as "Material" on the Look tab
const DesignHeadSeg = memo(function DesignHeadSeg({ title, k, options }) {
  const v = useEditor(s => customValue(s, k));
  return (
    <View style={st.fxHead}>
      <Text style={st.fxTitle}>{title}</Text>
      <Seg options={options} value={v} onChange={(nv) => setCustom(k, nv)} height={36} width={176} />
    </View>
  );
});
const DateHead = memo(function DateHead() {
  const on = useEditor(s => customValue(s, "showDate") === "on");
  const onChange = useCallback((v) => setCustom("showDate", v ? "on" : "off"), []);
  return (
    <View style={[st.fxHead, { minHeight: 36 }]}>
      <Text style={st.fxTitle}>Date</Text>
      <Toggle value={on} onChange={onChange} label="Show date" />
    </View>
  );
});
const FontHead = memo(function FontHead() {
  const [busy, setBusy] = useState(false);
  const onPress = async () => {
    if (busy) return;
    setBusy(true);
    try { const id = await addUserFont(); if (id) setCustom("font", id); } finally { setBusy(false); }
  };
  return (
    <View style={[st.fxHead, { minHeight: 36 }]}>
      <Text style={st.fxTitle}>Font</Text>
      <Press onPress={onPress} style={[st.tonalBtn, { height: 36, paddingHorizontal: 14, opacity: busy ? 0.5 : 1 }]}>
        <AppIcon name="add" size={18} color={C.text} />
        <Text style={st.tonalBtnText}>Add font</Text>
      </Press>
    </View>
  );
});

function DesignPage({ onBack }) {
  const [tab, setTab] = useState("time");
  const mask = useEditor(designTabMask);
  const dots = { time: !!(mask & 1), type: !!(mask & 2), look: !!(mask & 4), place: !!(mask & 8), date: !!(mask & 16) };
  const scroll = useRef(null);
  const go = useCallback((t) => { setTab(t); if (scroll.current) scroll.current.scrollTo({ y: 0, animated: false }); }, []);
  return (
    <View style={{ flex: 1 }}>
      <View style={st.subHeaderWrap}><SubHeader title="Your design" onBack={onBack} onSave={onBack} saveLabel="Done" /></View>
      <TabStrip tabs={DESIGN_TABS} value={tab} onChange={go} dots={dots} />
      <ScrollView ref={scroll} nestedScrollEnabled keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={st.designBody}>

        {tab === "time" && (
          <>
          <DesignHeadSeg title="Arrange" k="layout" options={OPT_LAYOUT} />
          <DesignTools tools={TIME_TOOLS} panes={{
            layout: (
              <>
                <Show when={d => d.layout === "inline"}>
                  <CustomSeg k="sep" label="Separator" options={OPT_SEP} />
                </Show>
                <Show when={isFlow}>
                  <CustomToggleRow k="seconds" label="Show seconds" />
                </Show>
              </>
            ),
            digits: (
              <>
                <CustomSeg k="hours" label="Hour digits" options={OPT_HOURS} />
                <Show when={hasGlyphFont}>
                  <CustomSeg k="numerals" label="Numerals" options={OPT_NUMERALS} />
                </Show>
              </>
            )
          }} />
          </>
        )}

        {tab === "type" && (
          <>
            <FontHead />
            <CardBox>
              <FontGrid k="font" options={OPT_FONT} />
              <Show when={hasGlyphFont}>
                <CustomSeg k="weight" label="Weight" options={OPT_WEIGHT} />
              </Show>
            </CardBox>
            <Show when={d => d.font === "dots"}>
              <Group title="Dots">
                <CustomSeg k="dotShape" label="Dot shape" options={OPT_DOT} />
                <CustomToggleRow k="ghost" label="Unlit dots" hint="Show the dots that are switched off" />
              </Group>
            </Show>
            <EGroup title="Size" keys={["size", "stretch", "widthScale"]}>
              <CustomSlider k="size" label="Size" min={50} max={160} suffix="%" />
              <Show when={isFlow}>
                <CustomSlider k="stretch" label="Height stretch" min={100} max={200} suffix="%" />
                <CustomSlider k="widthScale" label="Width stretch" min={50} max={160} suffix="%" />
              </Show>
            </EGroup>
            <EGroup title="Spacing" keys={["spacing", "groupGap", "lineGap", "lineShift"]}>
              <CustomSlider k="spacing" label="Between digits" min={-20} max={60} signed />
              <Show when={d => isFlow(d) && d.layout === "inline"}>
                <CustomSlider k="groupGap" label="Between hour and minute" min={0} max={80} />
              </Show>
              <Show when={d => isFlow(d) && d.layout === "stacked"}>
                <CustomSlider k="lineGap" label="Between lines" min={-60} max={60} signed />
                <CustomSlider k="lineShift" label="Line offset" min={-120} max={120} centered signed />
              </Show>
            </EGroup>
          </>
        )}

        {tab === "look" && (
          <>
            <Show when={canLook}><DesignHeadSeg title="Material" k="look" options={OPT_LOOK} /></Show>
            <DesignTools tools={LOOK_TOOLS} panes={{
              glass: (
                <>
                  <CustomSlider k="glass" label="Opacity" min={0} max={100} suffix="%" />
                  <CustomSlider k="glassBlur" label="Background blur" min={0} max={100} suffix="%" />
                  <CustomSlider k="glassAngle" label="Light direction" min={0} max={360} suffix={"\u00B0"} />
                  <CustomSeg k="glassBlend" label="Blur blend" options={OPT_BLEND} />
                  <Show when={d => d.glassBlend === "overlay"}>
                    <CustomSlider k="glassBlendAmt" label="Overlay strength" min={0} max={100} suffix="%" />
                  </Show>
                </>
              ),
              edges: (
                <>
                  <CustomToggleBlock k="glassLight" title="Light edge" hint="A bright edge on the side facing the light">
                    <CustomSeg k="glassLightSides" label="Show on" options={OPT_LIGHT_SIDES} />
                    <CustomSlider k="glassLightA" from="glassEdge" label="Opacity" min={0} max={100} suffix="%" />
                    <CustomSlider k="glassLightW" from="glassEdgeW" label="Thickness" min={0} max={100} suffix="%" />
                  </CustomToggleBlock>
                  <CustomToggleBlock k="glassDark" title="Dark edge" hint="A shadow edge on the side away from the light">
                    <CustomSeg k="glassDarkSides" label="Show on" options={OPT_DARK_SIDES} />
                    <CustomSlider k="glassDarkA" from="glassEdge" label="Opacity" min={0} max={100} suffix="%" />
                    <CustomSlider k="glassDarkW" from="glassEdgeW" label="Thickness" min={0} max={100} suffix="%" />
                  </CustomToggleBlock>
                  <CustomToggleBlock k="glassStrokeOn" title="Outline" hint="A line around every digit">
                    <CustomSlider k="glassStrokeW" label="Width" min={1} max={12} />
                    <CustomSlider k="glassStrokeOpacity" label="Opacity" min={0} max={100} suffix="%" />
                    <ColorField k="glassStrokeColor" label="Color" />
                  </CustomToggleBlock>
                </>
              ),
              twoTone: (
                <CustomToggleBlock k="twoTone" title="Two-tone" hint="Give hours and minutes different colors">
                  <CustomSeg k="toneOn" label="Accent on" options={OPT_TONEON} />
                  <ColorField k="accent" label="Accent color" />
                  <ColorField k="toneA" clockOption label="Other digits" />
                </CustomToggleBlock>
              ),
              gradient: (
                <CustomToggleBlock k="fadeOn" title="Gradient" hint="Blend two colors across the digits">
                  <ColorField k="fadeC1" label="Start color" />
                  <ColorField k="fadeC2" label="End color" />
                  <CustomSlider k="fadeAngle" label="Angle" min={0} max={360} suffix={"\u00B0"} />
                  <CustomSeg k="fadeScope" label="Apply to" options={OPT_SCOPE} />
                </CustomToggleBlock>
              ),
              outline: (
                <CustomToggleBlock k="strokeOn" title="Outline" hint="A line around every digit">
                  <CustomSlider k="stroke" label="Width" min={1} max={12} />
                  <CustomSlider k="strokeOpacity" label="Opacity" min={0} max={100} suffix="%" />
                  <ColorField k="strokeColor" label="Color" />
                  <CustomToggleRow k="sFadeOn" label="Gradient outline" hint="Give the outline its own two colors" />
                  <Show when={d => d.sFadeOn === "on"}>
                    <Nest>
                      <ColorField k="sC1" label="Start color" />
                      <ColorField k="sC2" label="End color" />
                      <CustomSlider k="sAngle" label="Angle" min={0} max={360} suffix={"\u00B0"} />
                      <CustomSeg k="sScope" label="Apply to" options={OPT_SCOPE} />
                    </Nest>
                  </Show>
                </CustomToggleBlock>
              ),
              finish: (
                <>
                  <CustomSlider k="opacity" label="Opacity" min={30} max={100} suffix="%" />
                  <Show when={d => !isFlow(d) || !isStyledLook(d)}>
                    <CustomSlider k="shadow" label="Shadow" min={0} max={20} />
                  </Show>
                </>
              ),
              panel: (
                <CustomToggleBlock k="panel" title="Backing panel" hint="A soft shape behind the clock">
                  <CustomSeg k="panelTone" label="Tone" options={[["dark", "Dark"], ["light", "Light"], ["accent", "Accent"]]} />
                  <CustomSlider k="panelOpacity" label="Opacity" min={5} max={90} suffix="%" />
                  <CustomSlider k="panelRadius" label="Corners" min={0} max={40} />
                  <CustomSlider k="panelPad" label="Padding" min={4} max={40} />
                </CustomToggleBlock>
              )
            }} />
          </>
        )}

        {tab === "place" && (
          <>
          <Show when={isFlow}><DesignHeadSeg title="Align" k="align" options={OPT_ALIGN} /></Show>
          <DesignTools tools={PLACE_TOOLS} panes={{
            position: (
              <>
                <Show when={isFlow}>
                  <CustomSlider k="top" label="Distance from top" min={4} max={70} suffix="%" />
                </Show>
                <CustomSlider k="offsetX" label="Left / right" min={-50} max={50} suffix="%" centered signed />
                <Show when={d => !isFlow(d)}>
                  <CustomSlider k="offsetY" label="Up / down" min={-30} max={30} suffix="%" centered signed />
                </Show>
              </>
            ),
            rotate: (
              <>
                <CustomSlider k="rotate" label="Rotate" min={-90} max={90} suffix={"\u00B0"} centered signed />
                <CustomSlider k="skew" label="Slant" min={-30} max={30} suffix={"\u00B0"} centered signed />
              </>
            )
          }} />
          </>
        )}

        {tab === "date" && (
          <>
          <DateHead />
          <DesignTools tools={DATE_TOOLS} disabledWhen={d => d.showDate !== "on"} panes={{
            show: (
              <>
                <CustomSeg k="dateCal" label="Calendar" options={OPT_DATE_CAL} />
                <CustomSeg k="dateWhat" label="Show" options={OPT_DATE_WHAT} />
                <Show when={d => d.dateWhat !== "date"}>
                  <CustomSeg k="dateWeekday" label="Weekday" options={OPT_DATE_WD} />
                </Show>
                <Show when={d => d.dateWhat !== "weekday"}>
                  <CustomSeg k="dateMonth" label="Month" options={OPT_DATE_MONTH} />
                  <Show when={d => d.dateCal === "gregorian" && d.dateDir !== "vertical"}>
                    <CustomSeg k="dateOrder" label="Order" options={OPT_DATE_ORDER} />
                  </Show>
                  <Show when={d => d.dateDir === "vertical"}>
                    <CustomSeg k="dateVOrder" label="Order, top to bottom" options={OPT_DATE_VORDER} />
                  </Show>
                </Show>
              </>
            ),
            placement: (
              <>
                <CustomSeg k="dateDir" label="Direction" hint="Vertical puts one letter per line" options={OPT_DATE_DIR} />
                <Show when={isFlow}>
                  <CustomSeg k="datePos" label="Position" options={OPT_DATEPOS} />
                  <CustomSlider k="dateGap" label="Distance from clock" min={0} max={40} />
                </Show>
              </>
            ),
            text: (
              <>
                <CustomSlider k="dateSize" label="Size" min={6} max={30} suffix="px" />
                <CustomSlider k="dateSpacing" label="Letter spacing" min={0} max={12} />
                <CustomSlider k="dateStretch" label="Height stretch" min={50} max={200} suffix="%" />
                <CustomSlider k="dateWidthScale" label="Width stretch" min={50} max={160} suffix="%" />
                <CustomSlider k="dateRotate" label="Rotate" min={-180} max={180} suffix={"\u00B0"} centered signed />
              </>
            )
          }} />
          </>
        )}
      </ScrollView>
    </View>
  );
}

// ---------- custom color picker page (SV square + hue bar + hex) ----------
function ColorPage({ onBack, onSave }) {
  const initial = useRef(String(editor.get().clockColor).toUpperCase()).current;
  const hsv = useRef(hexToHsv(initial) || { h: 0, s: 0, v: 1 }).current;
  const [hue, setHue] = useState(hsv.h);
  const [hex, setHex] = useState(initial);
  const [hexText, setHexText] = useState(initial);
  const [sv, setSv] = useState({ w: 0, h: 0 });
  const [hw, setHw] = useState(0);
  const svRef = useRef(sv); svRef.current = sv;
  const hwRef = useRef(hw); hwRef.current = hw;
  const svX = useRef(new Animated.Value(0)).current;
  const svY = useRef(new Animated.Value(0)).current;
  const hueX = useRef(new Animated.Value(0)).current;
  const svStart = useRef({ x: 0, y: 0 }).current;

  const emit = useRef(() => {
    const c = hsvToHex(hsv.h, hsv.s, hsv.v);
    setHex(c); setHexText(c);
    editor.set({ clockColor: c }); // live preview
  }).current;
  const setSV = useRef((px, py) => {
    const { w, h } = svRef.current;
    if (!w || !h) return;
    const cx = clamp(px, 0, w), cy = clamp(py, 0, h);
    svX.setValue(cx); svY.setValue(cy);
    hsv.s = cx / w; hsv.v = 1 - cy / h;
    emit();
  }).current;
  const setHueX = useRef((px) => {
    const w = hwRef.current;
    if (!w) return;
    const cx = clamp(px, 0, w);
    hueX.setValue(cx);
    hsv.h = Math.min(359.9, (cx / w) * 360);
    setHue(hsv.h);
    emit();
  }).current;

  const svPan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => { svStart.x = e.nativeEvent.locationX; svStart.y = e.nativeEvent.locationY; setSV(svStart.x, svStart.y); },
    onPanResponderMove: (_, g) => setSV(svStart.x + g.dx, svStart.y + g.dy)
  })).current;
  const hueStart = useRef(0);
  const huePan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => { hueStart.current = e.nativeEvent.locationX; setHueX(hueStart.current); },
    onPanResponderMove: (_, g) => setHueX(hueStart.current + g.dx)
  })).current;

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (sv.w && sv.h) { svX.setValue(hsv.s * sv.w); svY.setValue((1 - hsv.v) * sv.h); } }, [sv.w, sv.h]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (hw) hueX.setValue((hsv.h / 360) * hw); }, [hw]);

  // put a whole colour into every control (typing a hex, Reset)
  const applyHex = (norm, keepText) => {
    const p = hexToHsv(norm);
    if (!p) return;
    hsv.h = p.h; hsv.s = p.s; hsv.v = p.v;
    setHue(p.h); setHex(norm);
    if (!keepText) setHexText(norm);
    if (sv.w && sv.h) { svX.setValue(p.s * sv.w); svY.setValue((1 - p.v) * sv.h); }
    if (hw) hueX.setValue((p.h / 360) * hw);
    editor.set({ clockColor: norm });
  };
  const onHexText = (t) => {
    const up = t.toUpperCase();
    setHexText(up);
    const norm = up.startsWith("#") ? up : "#" + up;
    if (/^#[0-9A-F]{6}$/.test(norm)) applyHex(norm, true);
  };
  const changed = hex !== initial;

  return (
    <View style={st.cpWrap}>
      <SubHeader title="Custom color" onBack={onBack} onSave={onSave} saveLabel="Done" />
      <View style={[st.cpCard, { flex: 1 }]}>
        <View {...svPan.panHandlers} onLayout={e => setSv({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })} style={st.cpSv}>
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            <View style={[StyleSheet.absoluteFill, { borderRadius: R.sm, overflow: "hidden" }]}>
              <Svg width="100%" height="100%">
                <Defs>
                  <LinearGradient id="cpSat" x1="0" y1="0" x2="1" y2="0"><Stop offset="0" stopColor="#FFFFFF" /><Stop offset="1" stopColor={hsvToHex(hue, 1, 1)} /></LinearGradient>
                  <LinearGradient id="cpVal" x1="0" y1="0" x2="0" y2="1"><Stop offset="0" stopColor="#000000" stopOpacity="0" /><Stop offset="1" stopColor="#000000" stopOpacity="1" /></LinearGradient>
                </Defs>
                <Rect x="0" y="0" width="100%" height="100%" fill="url(#cpSat)" />
                <Rect x="0" y="0" width="100%" height="100%" fill="url(#cpVal)" />
              </Svg>
            </View>
            <Animated.View style={[st.cpThumb, { backgroundColor: hex, transform: [{ translateX: svX }, { translateY: svY }] }]} />
          </View>
        </View>
        <View {...huePan.panHandlers} onLayout={e => setHw(e.nativeEvent.layout.width)} style={st.cpHue}>
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            <View style={st.cpHueBar}>
              <Svg width="100%" height="100%">
                <Defs>
                  <LinearGradient id="cpHue" x1="0" y1="0" x2="1" y2="0">
                    <Stop offset="0" stopColor="#FF0000" /><Stop offset="0.1667" stopColor="#FFFF00" /><Stop offset="0.3333" stopColor="#00FF00" />
                    <Stop offset="0.5" stopColor="#00FFFF" /><Stop offset="0.6667" stopColor="#0000FF" /><Stop offset="0.8333" stopColor="#FF00FF" /><Stop offset="1" stopColor="#FF0000" />
                  </LinearGradient>
                </Defs>
                <Rect x="0" y="0" width="100%" height="100%" fill="url(#cpHue)" />
              </Svg>
            </View>
            <Animated.View style={[st.cpHueThumb, { transform: [{ translateX: hueX }] }]} />
          </View>
        </View>
      </View>
      <View style={st.cpCard}>
        <View style={st.cpRow}>
          <View style={[st.cpSwatch, { backgroundColor: hex }]} />
          <View style={st.cpHexBox}>
            <TextInput value={hexText} onChangeText={onHexText} autoCapitalize="characters" autoCorrect={false} maxLength={7} selectionColor={C.primary} placeholder="#RRGGBB" placeholderTextColor={C.muted} style={st.cpHexInput} />
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Reset color" disabled={!changed} hitSlop={6} onPress={() => applyHex(initial)} style={[st.cpReset, !changed && { opacity: 0.32 }]}>
            <AppIcon name="restart_alt" size={18} color={C.muted} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

// ---------- ADJUST tab ----------
// ---------- editor chrome: floating pills (zoom, undo / redo) and the "edited" dot on tool cards ----------
const TOOL_BITS = { Depth: 1, Adjust: 2, Clock: 4, Parallax: 8, Effects: 16 };
// one number says which tools hold changes (a dot appears on those cards)
const toolMaskOf = (s) => (
  (Object.keys(s.depth).length ? 1 : 0) |
  (s.adjust.scale !== 100 || s.adjust.x !== 0 || s.adjust.y !== 0 || (s.adjust.rotate || 0) !== 0 ? 2 : 0) |
  (s.custom || s.cm.x !== 0 || s.cm.y !== 0 || s.cm.s !== 1 || s.rc ? 4 : 0) |
  (s.parallax.speed !== 50 || s.parallax.amount !== 40 ? 8 : 0) |
  (Object.keys(s.fx).some(k => s.fx[k] !== 0) ? 16 : 0)
);
const ed = StyleSheet.create({
  pill: { flexDirection: "row", alignItems: "center", height: 40, borderRadius: R.sm, backgroundColor: C.scrim, borderWidth: 1, borderColor: C.hair, overflow: "hidden" },
  pillSolo: { width: 40, justifyContent: "center" },
  pillOn: { borderColor: C.primary },
  pillBtn: { width: 44, height: 40, alignItems: "center", justifyContent: "center" },
  pillDiv: { width: 1, height: 18, backgroundColor: C.outline },
  pillOff: { opacity: 0.38 },
  backBtn: { width: 40, height: 40, borderRadius: R.sm, backgroundColor: C.surface, borderWidth: 1, borderColor: C.hair, alignItems: "center", justifyContent: "center" },
  titleWrap: { marginLeft: 12, transform: [{ translateY: 0 }] },
  toolDot: { position: "absolute", top: -3, right: -6, width: 7, height: 7, borderRadius: 4, backgroundColor: C.primary }
});
const HistoryButtons = memo(function HistoryButtons() {
  const f = useHistFlags();
  const canUndo = (f & 1) !== 0, canRedo = (f & 2) !== 0;
  return (
    <View style={ed.pill}>
      <Pressable accessibilityRole="button" accessibilityLabel="Undo" disabled={!canUndo} onPress={undo} style={[ed.pillBtn, !canUndo && ed.pillOff]}>
        <AppIcon name="undo" size={21} color={C.text} />
      </Pressable>
      <View style={ed.pillDiv} />
      <Pressable accessibilityRole="button" accessibilityLabel="Redo" disabled={!canRedo} onPress={redo} style={[ed.pillBtn, !canRedo && ed.pillOff]}>
        <AppIcon name="redo" size={21} color={C.text} />
      </Pressable>
    </View>
  );
});

// ---------- ADJUST tab: zoom · position · rotation, all in one card ----------
const ADJ_TOOLS = [
  ["scale", "Zoom", "zoom_in", 50, 200, false, 100, "%"],
  ["x", "Left / right", "swap_horiz", -100, 100, true, 0, ""],
  ["y", "Up / down", "swap_vert", -100, 100, true, 0, ""],
  ["rotate", "Rotate", "rotate_right", -180, 180, true, 0, "\u00B0"]
];
const AdjustTab = memo(function AdjustTab({ pw, ph }) {
  const rev = useHistRev();
  const a = useEditor(s => s.adjust);
  const [sel, setSel] = useState(null);
  const save = (k, v) => editor.set(s => ({ adjust: { ...s.adjust, [k]: v } }));
  const onScale = useCallback((v) => { motion.scale.setValue(v / 100); save("scale", v); }, []);
  const onX = useCallback((v) => { motion.tx.setValue((v / 100) * (pw / 2)); save("x", v); }, [pw]);
  const onY = useCallback((v) => { motion.ty.setValue(-(v / 100) * (ph / 2)); save("y", v); }, [ph]); // right = up
  const onRot = useCallback((v) => { motion.rot.setValue(v); save("rotate", v); }, []);
  const handlers = { scale: onScale, x: onX, y: onY, rotate: onRot };
  const tool = ADJ_TOOLS.find(t => t[0] === sel);
  const changed = {};
  ADJ_TOOLS.forEach(t => { changed[t[0]] = (a[t[0]] == null ? t[6] : a[t[0]]) !== t[6]; });
  return (
    <TabScroll>
      <View style={[st.fxHead, { minHeight: 36 }]}><Text style={st.fxTitle}>Adjust</Text></View>
      <ToolChips tools={ADJ_TOOLS} selected={sel} changed={changed} onSelect={setSel} />
      {tool ? (
        <CardBox>
          <ValueSlider key={tool[0] + rev} label={tool[1]} min={tool[3]} max={tool[4]} initial={a[tool[0]] == null ? tool[6] : a[tool[0]]} def={tool[6]} suffix={tool[7]} centered={tool[5]} signed={tool[5]} onChange={handlers[tool[0]]} />
        </CardBox>
      ) : null}
    </TabScroll>
  );
});

// ---------- DEPTH tab (real analysis: zharph-core) ----------
const OPT_OVER = [["over", "Over"], ["under", "Under"]];
const DepthTab = memo(function DepthTab({ uri }) {
  const d = useDepth(s => s);
  const pos = useEditor(s => s.depth);
  const [barW, setBarW] = useState(0);
  const prog = useRef(new Animated.Value(0)).current;
  const status = d.uri === uri ? d.status : "idle";   // idle | scanning | done | error
  useEffect(() => {
    if (status !== "scanning") return;
    prog.setValue(0);
    const loop = Animated.loop(Animated.timing(prog, { toValue: 1, duration: 1600, easing: Easing.inOut(Easing.cubic), useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [status, prog]);
  if (status !== "done") {
    const scanning = status === "scanning";
    return (
      <TabScroll center>
        <View style={st.empty}>
          <View style={st.emptyIcon}><AppIcon name={scanning ? "layers" : "auto_awesome"} size={24} color={C.primary} /></View>
          <Text style={st.emptyTitle}>{scanning ? "Analyzing image" : "Separate the layers"}</Text>
          <Text style={st.emptySub}>{scanning ? (d.progress || "Analyzing...") : status === "error" ? "Analysis failed: " + d.error : "Find the depth layers so the clock can sit between them"}</Text>
          {scanning ? (
            <View onLayout={e => setBarW(e.nativeEvent.layout.width)} style={st.progTrack}>
              <Animated.View style={[st.progFill, { width: barW, transform: [{ translateX: prog.interpolate({ inputRange: [0, 1], outputRange: [-barW, 0] }) }] }]} />
            </View>
          ) : (
            <Press onPress={() => startDepthAnalysis(uri)} style={st.primaryBtn}><Text style={st.primaryBtnText}>{status === "error" ? "Try again" : "Analyze image"}</Text></Press>
          )}
        </View>
      </TabScroll>
    );
  }
  return (
    <TabScroll>
      <Group
        title={d.layers.length + " layers"}
        hint="Over puts a layer in front of the clock"
        right={<Press onPress={() => startDepthAnalysis(uri)} style={st.tonalBtn}><AppIcon name="refresh" size={15} color={C.text} /><Text style={st.tonalBtnText}>Re-analyze</Text></Press>}
      >
        {d.layers.map(l => (
          <View key={l.id} style={st.layerRow}>
            <View style={[st.layerThumb, { backgroundColor: l.color, opacity: 0.85 }]} />
            <Text style={st.layerName} numberOfLines={1}>{l.label + " · " + Math.round((l.area || 0) * 100) + "%"}</Text>
            <Seg height={32} width={116} options={OPT_OVER} value={pos[l.id] || "under"} onChange={(v) => editor.set(s => ({ depth: { ...s.depth, [l.id]: v } }))} />
          </View>
        ))}
      </Group>
    </TabScroll>
  );
});

// ---------- PARALLAX tab (UI sample only) ----------
const ParallaxTab = memo(function ParallaxTab() {
  const rev = useHistRev();
  const [rk, setRk] = useState(0);
  const p = editor.get().parallax;
  const nDirty = useEditor(s => (s.parallax.speed !== 50 ? 1 : 0) + (s.parallax.amount !== 40 ? 1 : 0));
  const save = (k) => (v) => editor.set(s => ({ parallax: { ...s.parallax, [k]: v } }));
  const onSpeed = useRef(save("speed")).current;
  const onAmount = useRef(save("amount")).current;
  const reset = () => { editor.set({ parallax: { speed: 50, amount: 40 } }); setRk(n => n + 1); };
  return (
    <TabScroll>
      <Group title="Motion" hint="Control how the wallpaper layers move" edited={nDirty}>
        <ValueSlider key={"sp" + rev + "_" + rk} showLabel label="Speed" min={0} max={100} initial={p.speed} def={50} suffix="%" onChange={onSpeed} />
        <ValueSlider key={"am" + rev + "_" + rk} showLabel label="Amount" min={0} max={100} initial={p.amount} def={40} suffix="%" onChange={onAmount} />
      </Group>
    </TabScroll>
  );
});

// ---------- Coming soon placeholder (Parallax is disabled for now; ParallaxTab above is kept intact) ----------
const PARALLAX_COMING_SOON = true;
const ComingSoonTab = memo(function ComingSoonTab({ title }) {
  return (
    <View style={st.soonWrap}>
      <AppIcon name="schedule" size={30} color={C.muted} />
      <Text style={st.soonTitle}>{title}</Text>
      <Text style={st.soonText}>Coming soon</Text>
    </View>
  );
});

// ---------- EFFECTS tab: presets, or tools sorted into Light · Color · Finish ----------
const OPT_FX = [["presets", "Presets"], ["tools", "Tools"]];
const PresetCard = memo(function PresetCard({ p, uri, selected }) {
  return (
    <View style={st.pcard}>
      <Press onPress={() => editor.set({ fx: { ...p.fx }, presetId: p.id })} style={[st.pthumb, selected && st.ccOn]}>
        <FxImage uri={uri} fx={p.fx} />
      </Press>
      <Text numberOfLines={1} style={[st.ccName, selected && { color: C.primary }]}>{p.name}</Text>
    </View>
  );
});
// Row of tool chips: tap one to show its ruler, tap it again to hide it. A coral dot = this tool has been changed.
const ToolChips = memo(function ToolChips({ tools, selected, changed, onSelect, fill = false, disabled = false }) {
  const chips = tools.map(([k, label, icon]) => {
    const on = selected === k && !disabled;
    const body = (
      <>
        <AppIcon name={icon} size={22} color={on ? C.primary : C.muted} active={on} />
        <Text numberOfLines={1} style={[st.toolChipText, on && { color: C.primary }]}>{label}</Text>
        {changed[k] && !disabled ? <View style={st.toolChipDot} /> : null}
      </>
    );
    const fillStyle = fill ? { width: "100%" } : null;
    if (disabled) return <View key={k} style={[st.toolChip, fillStyle, fill && { flex: 1 }, { opacity: 0.38 }]}>{body}</View>;
    return (
      <Press key={k} wrapStyle={fill ? { flex: 1 } : undefined} onPress={() => onSelect(on ? null : k)} style={[st.toolChip, fillStyle, on && st.toolChipOn]}>{body}</Press>
    );
  });
  if (fill) return <View style={{ flexDirection: "row", gap: 8 }}>{chips}</View>;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} nestedScrollEnabled style={st.toolChipsList} contentContainerStyle={st.toolChipsContent}>
      {chips}
    </ScrollView>
  );
});
const FxAllTools = memo(function FxAllTools({ rev, rk, h, fx }) {
  const [sel, setSel] = useState(null);
  const tool = FX_TOOLS.find(t => t[0] === sel);
  const changed = {};
  FX_TOOLS.forEach(t => { changed[t[0]] = fx[t[0]] !== 0; });
  return (
    <>
      <ToolChips tools={FX_TOOLS} selected={sel} changed={changed} onSelect={setSel} />
      {tool ? (
        <View style={st.group}>
          <View style={st.groupInner}>
            <ValueSlider key={tool[0] + "_" + rev + "_" + rk} label={tool[1]} min={tool[3]} max={tool[4]} initial={fx[tool[0]]} def={0} centered={tool[5]} signed={tool[5]} onChange={h(tool[0])} />
          </View>
        </View>
      ) : null}
    </>
  );
});
const EffectsTab = memo(function EffectsTab({ uri }) {
  const [mode, setMode] = useState("presets");
  const [rk, setRk] = useState(0);
  const presetId = useEditor(s => s.presetId);
  const fx = useEditor(s => s.fx);
  const rev = useHistRev();
  const cache = useRef({}).current;
  const h = (k) => cache[k] || (cache[k] = (v) => editor.set(s => ({ fx: { ...s.fx, [k]: v }, presetId: null })));
  const bump = useCallback(() => setRk(n => n + 1), []);
  return (
    <TabScroll>
      <View style={st.fxHead}>
        <Text style={st.fxTitle}>Effects</Text>
        <Seg options={OPT_FX} value={mode} onChange={setMode} height={36} width={176} />
      </View>
      {mode === "presets" ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} nestedScrollEnabled style={st.hList} contentContainerStyle={st.hListContent}>
          {FX_PRESETS.map(p => <PresetCard key={p.id} p={p} uri={uri} selected={presetId === p.id} />)}
        </ScrollView>
      ) : (
        <FxAllTools rev={rev} rk={rk} h={h} fx={fx} />
      )}
    </TabScroll>
  );
});

// =====================================================================================
//  Editor styles. One rhythm: 20 page margin · 20 between groups · 16 inside rows.
//  Surfaces: sheet C.surface2  >  group card C.surface  >  inset controls C.bg.  Coral only means "on / selected / main action".
// =====================================================================================
const st = StyleSheet.create({
  soonWrap: { flex: 1, alignItems: "center", justifyContent: "center", gap: 6, paddingBottom: 24 },
  soonTitle: { fontFamily: F.display, color: C.text, fontSize: 15, marginTop: 4 },
  soonText: { fontFamily: F.body, color: C.muted, fontSize: 13 },
  tabBody: { paddingHorizontal: 20, paddingTop: 4, paddingBottom: 36, gap: 20 },
  // headers
  secHead: { flexDirection: "row", alignItems: "center", minHeight: 30, marginBottom: 8, gap: 8 },
  secTitle: { fontFamily: F.display, color: C.text, fontSize: 14 },
  secHint: { fontFamily: F.body, color: C.muted, fontSize: 12, marginTop: 2, lineHeight: 16 },
  // group card + rows
  group: { backgroundColor: C.surface, borderRadius: R.md, borderWidth: 1, borderColor: C.hair, overflow: "hidden" },
  groupInner: { marginTop: -1 },
  row: { paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1, borderTopColor: C.hair },
  rowInline: { flexDirection: "row", alignItems: "center", minHeight: 54 },
  rowLabel: { fontFamily: F.bold, color: C.text, fontSize: 13 },
  rowHint: { fontFamily: F.body, color: C.muted, fontSize: 12, marginTop: 2, lineHeight: 16 },
  nest: { backgroundColor: "rgba(0,0,0,0.18)" },
  // buttons
  tonalBtn: { height: 30, paddingHorizontal: 12, borderRadius: R.sm, backgroundColor: C.surface, borderWidth: 1, borderColor: C.outline, flexDirection: "row", alignItems: "center", gap: 6 },
  tonalBtnText: { fontFamily: F.bold, color: C.text, fontSize: 12 },
  ghostBtn: { height: 28, paddingHorizontal: 8, flexDirection: "row", alignItems: "center", gap: 4 },
  ghostBtnText: { fontFamily: F.bold, color: C.muted, fontSize: 12 },
  primaryBtn: { marginTop: 18, height: 42, paddingHorizontal: 24, borderRadius: R.sm, backgroundColor: C.primary, alignItems: "center", justifyContent: "center" },
  primaryBtnText: { fontFamily: F.bold, color: C.onPrimary, fontSize: 14 },
  // horizontal lists
  hList: { marginHorizontal: -20 },
  hListContent: { paddingHorizontal: 20 },
  hBleed: { marginHorizontal: -16 },
  hBleedContent: { paddingHorizontal: 16 },
  // tab strip ("Your design")
  tabStrip: { flexDirection: "row", height: 40, marginHorizontal: 20, marginBottom: 12, borderBottomWidth: 1, borderBottomColor: C.outline },
  tabItem: { flex: 1, alignItems: "center", justifyContent: "center" },
  tabText: { fontFamily: F.bold, color: C.muted, fontSize: 13 },
  tabLabelRow: { flexDirection: "row", alignItems: "center" },
  tabDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.primary, marginLeft: 5, marginTop: 1 },
  tabInd: { position: "absolute", bottom: -1, height: 2, borderRadius: 1, backgroundColor: C.primary },
  // segmented (inset control: darker than the card it sits on)
  seg: { flexDirection: "row", backgroundColor: C.bg, borderWidth: 1, borderColor: C.hair, padding: 2 },
  segItem: { flex: 1, alignItems: "center", justifyContent: "center" },
  segText: { fontFamily: F.bold, color: C.muted, fontSize: 12 },
  // switch
  tgTrack: { width: 46, height: 28, borderRadius: 9, backgroundColor: C.bg, borderWidth: 1, borderColor: C.outline },
  tgOn: { position: "absolute", left: -1, right: -1, top: -1, bottom: -1, borderRadius: 9, borderWidth: 1, borderColor: C.primary, backgroundColor: C.primarySoft },
  tgThumb: { position: "absolute", left: 2, top: 3, width: 20, height: 20, borderRadius: 6, backgroundColor: C.muted },
  tgThumbOn: { backgroundColor: C.primary },
  // slider (each slider is one row of its group)
  slRow: { borderTopWidth: 1, borderTopColor: C.hair },
  slReset: { width: 28, height: 28, alignItems: "center", justifyContent: "center", marginRight: -4 },
  slValue: { minWidth: 54, height: 28, paddingHorizontal: 10, borderRadius: R.sm, backgroundColor: C.bg, borderWidth: 1, borderColor: C.hair, alignItems: "center", justifyContent: "center" },
  slValueOn: { backgroundColor: "rgba(255,122,89,0.12)", borderColor: "rgba(255,122,89,0.5)" },
  slValueText: { fontFamily: F.bold, color: C.text, fontSize: 13, includeFontPadding: false },
  slInput: { fontFamily: F.bold, padding: 0, margin: 0, minWidth: 44, textAlign: "center", color: C.text, fontSize: 13, includeFontPadding: false },
  slBody: { flexDirection: "row", alignItems: "center", height: 58, paddingLeft: 10, paddingRight: 8, backgroundColor: RULER_FADE },
  slLabelTop: { fontFamily: F.bold, color: C.text, fontSize: 13, paddingHorizontal: 16, paddingTop: 10, backgroundColor: RULER_FADE },
  slBtn: { width: 40, height: 44, alignItems: "center", justifyContent: "center" },
  slRuler: { flex: 1, height: RULER_H, overflow: "hidden" },
  slMark: { position: "absolute", top: 3, width: 4, height: 34, borderRadius: 2, backgroundColor: C.primary },
  secEdited: { fontFamily: F.body, color: C.muted, fontSize: 12 },
  // tool chips (Effects > Tools, Adjust)
  toolChipsList: { flexGrow: 0 },   // no negative margin: the row is cut exactly at the page margins (20px), like the cards below it
  toolChipsContent: { gap: 8 },
  toolChip: { width: 80, height: 58, paddingHorizontal: 4, paddingVertical: 8, borderRadius: R.sm, backgroundColor: C.surface, borderWidth: 1, borderColor: C.hair, alignItems: "center", justifyContent: "center", gap: 5 },
  toolChipOn: { backgroundColor: C.primarySoft, borderColor: "rgba(255,122,89,0.55)" },
  toolChipText: { fontFamily: F.semi, color: C.muted, fontSize: 12, includeFontPadding: false },
  toolChipDot: { position: "absolute", top: 6, right: 6, width: 7, height: 7, borderRadius: 4, backgroundColor: C.primary },
  // clock cards
  ccWrap: { width: CC_W, marginRight: 10 },
  cc: { width: CC_W, height: CC_H, borderRadius: R.md, overflow: "hidden", borderWidth: 2, borderColor: C.outline, backgroundColor: C.surface },
  ccOn: { borderColor: C.primary },
  ccName: { fontFamily: F.bold, color: C.muted, fontSize: 12, textAlign: "center", marginTop: 8 },
  ccFoot: { position: "absolute", left: 6, right: 6, bottom: 6, flexDirection: "row", alignItems: "center", gap: 4 },
  ccBtn: { flex: 1, height: 24, borderRadius: R.xs, backgroundColor: "rgba(16,14,14,0.78)", borderWidth: 1, borderColor: "rgba(242,235,231,0.18)", alignItems: "center", justifyContent: "center" },
  ccBtnText: { fontFamily: F.bold, color: C.text, fontSize: 10, includeFontPadding: false },
  ccCheck: { width: 24, height: 24, borderRadius: R.xs, backgroundColor: "#3F2721", borderWidth: 1, borderColor: "#6A3A2D", alignItems: "center", justifyContent: "center" },
  ctRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  ctBtn: { width: 34, height: 34, borderRadius: R.sm, backgroundColor: C.surface, borderWidth: 1, borderColor: C.outline, alignItems: "center", justifyContent: "center" },
  ctCur: { width: 34, height: 34, borderRadius: R.sm, borderWidth: 1, borderColor: C.outline, overflow: "hidden", alignItems: "center", justifyContent: "center" },
  ccPlus: { borderStyle: "dashed", alignItems: "center", justifyContent: "center" },
  ccPlusIcon: { width: 44, height: 44, borderRadius: R.sm, backgroundColor: C.surface3, alignItems: "center", justifyContent: "center" },
  chip: { height: 34, paddingHorizontal: 14, borderRadius: R.sm, backgroundColor: C.bg, borderWidth: 1, borderColor: C.hair, alignItems: "center", justifyContent: "center" },
  chipOn: { backgroundColor: C.primarySoft, borderColor: "rgba(255,122,89,0.35)" },
  chipText: { fontFamily: F.bold, color: C.muted, fontSize: 12 },
  // font gallery
  fontStrip: { flexDirection: "row", gap: 8, padding: 12 },
  fontTile: { width: 84, height: 68, paddingHorizontal: 4, borderRadius: R.sm, backgroundColor: C.bg, borderWidth: 1, borderColor: C.hair, alignItems: "center", justifyContent: "center", gap: 4 },
  fontTileOn: { backgroundColor: C.primarySoft, borderColor: "rgba(255,122,89,0.45)" },
  fontSampleBox: { height: 30, alignSelf: "stretch", alignItems: "center", justifyContent: "center", overflow: "hidden" },
  fontSample: { color: C.muted, fontSize: 18, lineHeight: 26, textAlign: "center", includeFontPadding: false },
  fontName: { fontFamily: F.semi, color: C.muted, fontSize: 11, lineHeight: 14, textAlign: "center", includeFontPadding: false },
  // color swatches
  swOuter: { width: 40, height: 40, borderRadius: R.sm, borderWidth: 2, borderColor: "transparent", alignItems: "center", justifyContent: "center", marginRight: 6 },
  swOuterOn: { borderColor: C.primary },
  swDot: { width: 30, height: 30, borderRadius: R.xs, borderWidth: 1, borderColor: "rgba(255,255,255,0.18)", alignItems: "center", justifyContent: "center", overflow: "hidden" },
  // sub pages
  subHeaderWrap: { paddingHorizontal: 20 },
  subHeader: { height: 44, flexDirection: "row", alignItems: "center", gap: 12 },
  subBack: { width: 36, height: 36, borderRadius: 18, backgroundColor: C.surface, borderWidth: 1, borderColor: C.hair, alignItems: "center", justifyContent: "center" },
  subTitle: { fontFamily: F.display, color: C.text, fontSize: 16, flex: 1 },
  subSave: { height: 34, paddingHorizontal: 18, borderRadius: R.sm, backgroundColor: C.primary, alignItems: "center", justifyContent: "center" },
  subSaveText: { fontFamily: F.bold, color: C.onPrimary, fontSize: 13 },
  designBody: { paddingHorizontal: 20, paddingTop: 0, paddingBottom: 40, gap: 20 },
  // color picker
  cpWrap: { flex: 1, paddingHorizontal: 20, paddingBottom: 16, gap: 12 },
  cpCard: { backgroundColor: C.surface, borderRadius: R.md, borderWidth: 1, borderColor: C.hair, padding: 12 },
  cpSv: { flex: 1, minHeight: 80 },
  cpReset: { width: 38, height: 38, borderRadius: R.sm, backgroundColor: C.bg, borderWidth: 1, borderColor: C.hair, alignItems: "center", justifyContent: "center", marginLeft: 8 },
  cpThumb: { position: "absolute", left: -11, top: -11, width: 22, height: 22, borderRadius: 11, borderWidth: 3, borderColor: "#FFFFFF", elevation: 3 },
  cpHue: { height: 30, marginTop: 12 },
  cpHueBar: { position: "absolute", left: 0, right: 0, top: 4, height: 22, borderRadius: R.sm, overflow: "hidden" },
  cpHueThumb: { position: "absolute", left: -5, top: 0, width: 10, height: 30, borderRadius: 5, backgroundColor: "#FFFFFF", borderWidth: 1, borderColor: "rgba(0,0,0,0.35)", elevation: 3 },
  cpRow: { flexDirection: "row", alignItems: "center" },
  cpSwatch: { width: 38, height: 38, borderRadius: R.sm, borderWidth: 1, borderColor: "rgba(255,255,255,0.2)", marginRight: 12 },
  cpHexBox: { flex: 1, height: 38, borderRadius: R.sm, backgroundColor: C.bg, borderWidth: 1, borderColor: C.hair, justifyContent: "center", paddingHorizontal: 16 },
  cpHexInput: { fontFamily: F.display, padding: 0, margin: 0, color: C.text, fontSize: 14, letterSpacing: 1, includeFontPadding: false },
  // depth
  empty: { alignItems: "center", paddingHorizontal: 12 },
  emptyIcon: { width: 52, height: 52, borderRadius: R.md, backgroundColor: C.primarySoft, alignItems: "center", justifyContent: "center", marginBottom: 14 },
  emptyTitle: { fontFamily: F.display, color: C.text, fontSize: 15 },
  emptySub: { fontFamily: F.body, color: C.muted, fontSize: 12, marginTop: 4, lineHeight: 17, textAlign: "center", maxWidth: 260 },
  progTrack: { alignSelf: "stretch", height: 4, borderRadius: 2, backgroundColor: TRACK, overflow: "hidden", marginTop: 22 },
  progFill: { height: 4, borderRadius: 2, backgroundColor: C.primary },
  layerRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10, paddingHorizontal: 12, borderTopWidth: 1, borderTopColor: C.hair },
  layerThumb: { width: 40, height: 40, borderRadius: 8, overflow: "hidden", backgroundColor: C.surface2 },
  layerName: { fontFamily: F.bold, color: C.text, fontSize: 13, flex: 1, marginLeft: 12 },
  fxHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  fxTitle: { fontFamily: F.display, color: C.text, fontSize: 20, letterSpacing: -0.3 },
  // effects presets
  pcard: { width: 76, marginRight: 10 },
  pthumb: { width: 76, height: 96, borderRadius: R.md, overflow: "hidden", borderWidth: 2, borderColor: C.outline, backgroundColor: C.surface }
});

// =====================================================================================
//  SETTINGS PAGE — profile, account (sign in / sign out), preferences, about
//  State that must survive tab switches (user, prefs) lives in <App/>; the sheets keep their own form state.
// =====================================================================================
// =====================================================================================
//  WALLPAPER CARD OVERLAY — short black -> transparent gradient with the wallpaper name (left)
//  and a Save button (right, 2-column grid only). Parallax wallpapers get a small badge on top.
// =====================================================================================
// Bookmark glyph reuses the rounded icon path (outline when unsaved, coral fill when saved).
const BOOKMARK_PATH = ICONS.bookmark;
// TODO: sample only — these wallpapers get the Parallax badge. Replace with a real flag on your wallpaper data.
const PARALLAX_SAMPLE = new Set(["Alpine dusk", "Blue hour", "Forest light", "Emerald lake", "Canyon glow", "Cloud summit", "Snow valley"]);

// Glass surface used by the small buttons on wallpaper cards (same blur + tint as the bottom nav).
// Android with the new BlurTargetView can't blur inside its own target, so there it falls back to a translucent dark tint.
const GlassBox = memo(function GlassBox({ style, children }) {
  const real = !!BlurViewC && BLUR_OK && !(BlurTargetC && Platform.OS === "android");
  return (
    <View style={[{ overflow: "hidden", backgroundColor: real ? "transparent" : "rgba(16,14,14,0.55)", borderWidth: 1, borderColor: C.hair }, style]}>
      {real ? <BlurViewC pointerEvents="none" intensity={50} tint="dark" experimentalBlurMethod="dimezisBlurView" style={StyleSheet.absoluteFill} /> : null}
      {real ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: NAV_TINT }]} /> : null}
      {children}
    </View>
  );
});

const SaveButton = memo(function SaveButton({ active, onPress, size }) {
  const sc = useRef(new Animated.Value(1)).current;
  const press = () => {
    // the one place in the app with a small, pleasant wobble: the moment something gets saved
    if (!active) { sc.stopAnimation(); sc.setValue(0.8); Animated.spring(sc, { toValue: 1, stiffness: 420, damping: 13, mass: 1, useNativeDriver: true }).start(); }
    onPress();
  };
  const box = 30;   // same square as the Parallax badge
  return (
    <Pressable onPress={press} hitSlop={{ top: 12, bottom: 12, left: 12, right: 8 }} accessibilityRole="button" accessibilityLabel={active ? "Remove from saved" : "Save"} accessibilityState={{ selected: active }}>
      <Animated.View style={{ transform: [{ scale: sc }] }}>
        <GlassBox style={{ width: box, height: box, borderRadius: R.xs, alignItems: "center", justifyContent: "center" }}>
          <Svg width={18} height={18} viewBox="0 0 24 24"><Path d={BOOKMARK_PATH} fill={active ? C.primary : "none"} stroke={active ? C.primary : C.text} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /></Svg>
        </GlassBox>
      </Animated.View>
    </Pressable>
  );
});

// Home card: light press feedback, plain fade-in the first time a card appears (no jump, no stretch).
const SEEN_CARDS = new Set();
const CARD_RATIO = 9 / 16; // every wallpaper card is the same size
const WallCard = React.forwardRef(function WallCard({ cardKey, onPress, style, children }, ref) {
  const sc = useRef(new Animated.Value(1)).current;
  const fade = useRef(new Animated.Value(SEEN_CARDS.has(cardKey) ? 1 : 0)).current;
  useEffect(() => {
    if (SEEN_CARDS.has(cardKey)) return;
    SEEN_CARDS.add(cardKey);
    Animated.timing(fade, { toValue: 1, duration: 240, easing: EASE_OUT, useNativeDriver: true }).start();
  }, [cardKey, fade]);
  return (
    <Pressable
      ref={ref} collapsable={false} style={style} onPress={onPress}
      onPressIn={() => { sc.stopAnimation(); Animated.timing(sc, { toValue: 0.98, duration: 90, easing: EASE_OUT, useNativeDriver: true }).start(); }}
      onPressOut={() => { sc.stopAnimation(); Animated.spring(sc, { toValue: 1, ...SPRING }).start(); }}
    >
      <Animated.View style={{ opacity: fade, transform: [{ scale: sc }] }}>{children}</Animated.View>
    </Pressable>
  );
});

const CardOverlay = memo(function CardOverlay({ id, title, saved, onSave, compact }) {
  return (
    <View pointerEvents="box-none" style={[s.cardOverlay, compact && { height: 44 }]}>
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Svg width="100%" height="100%" viewBox="0 0 10 56" preserveAspectRatio="none">
          <Defs><LinearGradient id="cardShade" x1="0" y1="0" x2="0" y2="1"><Stop offset="0" stopColor="#000000" stopOpacity="0" /><Stop offset="1" stopColor="#000000" stopOpacity="0.8" /></LinearGradient></Defs>
          <Rect x="0" y="0" width="10" height="56" fill="url(#cardShade)" />
        </Svg>
      </View>
      <View pointerEvents="box-none" style={[s.cardStats, compact ? { paddingHorizontal: 6, paddingBottom: 6, minHeight: 24 } : { paddingHorizontal: 8, paddingBottom: 8, gap: 8 }]}>
        <Text numberOfLines={1} style={[s.cardTitle, compact && { fontSize: 11 }]}>{title}</Text>
        {!compact && <SaveButton active={saved} onPress={() => onSave(id)} size={26} />}
      </View>
    </View>
  );
});

// One grid card. Memoized, so toggling a bookmark or opening a sheet no longer re-renders every card in the grid.
const GridCard = memo(function GridCard({ d, onOpen, saved, onSave, compact }) {
  const ref = useRef(null);
  const press = useCallback(() => onOpen(d.wp, ref), [onOpen, d.wp]);
  return (
    <WallCard cardKey={d.key} ref={ref} style={s.wall} onPress={press}>
      <Image source={{ uri: d.thumb }} style={[s.photo, { aspectRatio: CARD_RATIO }]} />
      <CardOverlay id={d.overlayId} title={d.title} saved={saved} onSave={onSave} compact={compact} />
      {d.parallax && <ParallaxBadge compact={compact} />}
    </WallCard>
  );
}, (a, b) => a.onOpen === b.onOpen && a.onSave === b.onSave && a.saved === b.saved && a.compact === b.compact
  && a.d.key === b.d.key && a.d.thumb === b.d.thumb && a.d.title === b.d.title && a.d.parallax === b.d.parallax
  && a.d.wp.uri === b.d.wp.uri && a.d.wp.remote === b.d.wp.remote);

const ParallaxBadge = memo(function ParallaxBadge({ compact }) {
  return (
    <GlassBox style={[s.parallaxBadge, compact && { width: 24, height: 24, borderRadius: R.xs, top: 6, right: 6 }]}>
      <AppIcon name="3d_rotation" size={compact ? 15 : 18} color="#FFFFFF" />
    </GlassBox>
  );
});

const APP_VERSION = "1.0.0";
// TODO: replace with your real links
const LINKS = {
  privacy: "https://zharph.app/privacy",
  terms: "https://zharph.app/terms",
  support: "mailto:support@zharph.app",
  rate: "https://zharph.app"
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const initialsOf = (name) => (name || "").trim().split(/\s+/).slice(0, 2).map(w => (w[0] || "").toUpperCase()).join("") || "?";
const openLink = (url) => Linking.openURL(url).catch(() => Alert.alert("Can't open link", "Please try again later."));

const st2 = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.55)" },
  sheet: { backgroundColor: C.surface2, borderTopLeftRadius: R.lg, borderTopRightRadius: R.lg, borderWidth: 1, borderBottomWidth: 0, borderColor: C.hair, paddingHorizontal: 20, paddingTop: 10, paddingBottom: 28 },
  handle: { alignSelf: "center", width: 36, height: 4, borderRadius: 2, backgroundColor: C.muted, opacity: 0.5, marginBottom: 16 },
  sheetTitle: { fontFamily: F.display, color: C.text, fontSize: 21,  letterSpacing: -0.4 },
  sheetSub: { fontFamily: F.body, color: C.muted, fontSize: 13, lineHeight: 19, marginTop: 6, marginBottom: 18 },
  field: { flexDirection: "row", alignItems: "center", height: 54, borderRadius: R.sm, backgroundColor: C.surface, borderWidth: 1, borderColor: C.outline, paddingLeft: 16, paddingRight: 8, gap: 12, marginBottom: 12 },
  fieldInput: { fontFamily: F.body, flex: 1, color: C.text, fontSize: 15, height: 54, padding: 0 },
  fieldError: { fontFamily: F.body, color: C.danger, fontSize: 12, flex: 1 },
  errorRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: -6, marginBottom: 10, marginLeft: 6 },
  eye: { width: 38, height: 38, alignItems: "center", justifyContent: "center" },
  cta: { height: 52, borderRadius: R.sm, backgroundColor: C.primary, alignItems: "center", justifyContent: "center", marginTop: 6, flexDirection: "row", gap: 10 },
  ctaOff: { opacity: 0.45 },
  ctaText: { fontFamily: F.bold, color: C.onPrimary, fontSize: 15, },
  linkRow: { alignItems: "center", paddingVertical: 12 },
  linkText: { fontFamily: F.bold, color: C.text, fontSize: 13, },
  guestCard: { alignItems: "center", backgroundColor: C.surface, borderRadius: R.md, borderWidth: 1, borderColor: C.hair, padding: 24, marginBottom: 24 },
  guestIcon: { width: 76, height: 76, borderRadius: R.md, backgroundColor: C.surface2, alignItems: "center", justifyContent: "center", marginBottom: 16 },
  orRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 14 },
  orLine: { flex: 1, height: 1, backgroundColor: C.hair },
  orText: { fontFamily: F.body, color: C.muted, fontSize: 12 },
  googleBtn: { height: 52, borderRadius: R.sm, backgroundColor: C.surface, borderWidth: 1, borderColor: C.outline, alignItems: "center", justifyContent: "center", marginTop: 14, flexDirection: "row", gap: 10 },
  googleG: { fontFamily: F.bold, color: C.text, fontSize: 18 },
  googleText: { fontFamily: F.bold, color: C.text, fontSize: 15 },
});

function SheetModal({ visible, onClose, children }) {
  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1, justifyContent: "flex-end" }}>
        <Pressable accessibilityLabel="Close" style={st2.backdrop} onPress={onClose} />
        <View style={st2.sheet}>
          <View style={st2.handle} />
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function SettingsField({ icon, error, right, inputRef, editable = true, ...inputProps }) {
  return (
    <>
      <View style={[st2.field, !!error && { borderColor: C.danger }, !editable && { opacity: 0.6 }]}>
        <AppIcon name={icon} size={20} color={C.muted} />
        <TextInput ref={inputRef} editable={editable} placeholderTextColor="#8A7F79" selectionColor={C.primary} style={st2.fieldInput} {...inputProps} />
        {right}
      </View>
      {!!error && <View style={st2.errorRow}><AppIcon name="info" size={14} color={C.danger} /><Text style={st2.fieldError}>{error}</Text></View>}
    </>
  );
}

// Sign in / create account sheet
function AuthSheet({ visible, mode, setMode, onClose, onSubmit }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const emailRef = useRef(null);
  const passRef = useRef(null);
  const signup = mode === "signup";

  useEffect(() => { setErrors({}); setBusy(false); setShowPw(false); if (!visible) setPassword(""); }, [visible]);
  useEffect(() => { setErrors({}); }, [mode]);

  const submit = async () => {
    if (busy) return;
    const e = {};
    if (signup && !name.trim()) e.name = "Enter your name";
    if (!EMAIL_RE.test(email.trim())) e.email = "Enter a valid email address";
    if (!password) e.password = "Enter your password";
    else if (signup && password.length < 8) e.password = "Use at least 8 characters";
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try { await onSubmit({ mode, name: name.trim(), email: email.trim().toLowerCase(), password }); }
    catch (err) { setErrors({ form: err?.message || "Something went wrong. Please try again." }); }
    finally { setBusy(false); }
  };
  const google = async () => {
    if (busy) return;
    setBusy(true); setErrors({});
    try { if (await signInWithGoogle()) onClose(); }
    catch (err) { setErrors({ form: err?.message || "Google sign-in failed. Please try again." }); }
    finally { setBusy(false); }
  };
  const forgot = async () => {
    if (!EMAIL_RE.test(email.trim())) { setErrors({ email: "Enter your email first, then tap Forgot password" }); return; }
    try { await resetPassword(email.trim().toLowerCase()); } catch (e) { /* same message either way, so we never reveal which emails exist */ }
    Alert.alert("Check your inbox", `If an account exists for ${email.trim()}, a reset link is on its way.`);
  };

  return (
    <SheetModal visible={visible} onClose={busy ? () => {} : onClose}>
      <Text style={st2.sheetTitle}>{signup ? "Create your account" : "Welcome back"}</Text>
      <Text style={st2.sheetSub}>{signup ? "Save wallpapers and keep your settings in sync on every device." : "Sign in to sync your saved wallpapers and settings."}</Text>
      {signup && <SettingsField icon="person" value={name} onChangeText={setName} placeholder="Full name" autoCapitalize="words" returnKeyType="next" onSubmitEditing={() => emailRef.current?.focus()} error={errors.name} />}
      <SettingsField inputRef={emailRef} icon="mail" value={email} onChangeText={setEmail} placeholder="Email" keyboardType="email-address" autoCapitalize="none" autoCorrect={false} returnKeyType="next" onSubmitEditing={() => passRef.current?.focus()} error={errors.email} />
      <SettingsField
        inputRef={passRef} icon="lock" value={password} onChangeText={setPassword} placeholder="Password" secureTextEntry={!showPw} autoCapitalize="none" autoCorrect={false} returnKeyType="done" onSubmitEditing={submit} error={errors.password}
        right={<Pressable hitSlop={8} accessibilityLabel={showPw ? "Hide password" : "Show password"} onPress={() => setShowPw(v => !v)} style={st2.eye}><AppIcon name={showPw ? "visibility_off" : "visibility"} size={20} color={C.muted} /></Pressable>}
      />
      {!!errors.form && <View style={[st2.errorRow, { marginTop: 0 }]}><AppIcon name="info" size={14} color={C.danger} /><Text style={st2.fieldError}>{errors.form}</Text></View>}
      {!signup && <Pressable onPress={forgot} hitSlop={6} style={{ alignSelf: "flex-end", marginTop: -2, marginBottom: 8 }}><Text style={st2.linkText}>Forgot password?</Text></Pressable>}
      <Pressable disabled={busy} onPress={submit} style={[st2.cta, busy && st2.ctaOff]}>
        {busy && <ActivityIndicator size="small" color={C.onPrimary} />}
        <Text style={st2.ctaText}>{busy ? (signup ? "Creating account…" : "Signing in…") : (signup ? "Create account" : "Sign in")}</Text>
      </Pressable>
      {GOOGLE_ENABLED && <>
        <View style={st2.orRow}><View style={st2.orLine} /><Text style={st2.orText}>or</Text><View style={st2.orLine} /></View>
        <Pressable disabled={busy} onPress={google} accessibilityRole="button" style={[st2.googleBtn, busy && st2.ctaOff]}>
          <Text style={st2.googleG}>G</Text>
          <Text style={st2.googleText}>Continue with Google</Text>
        </Pressable>
      </>}
      <Pressable disabled={busy} onPress={() => setMode(signup ? "signin" : "signup")} style={st2.linkRow}>
        <Text style={{ color: C.muted, fontSize: 13 }}>{signup ? "Already have an account? " : "New to Zharph? "}<Text style={st2.linkText}>{signup ? "Sign in" : "Create account"}</Text></Text>
      </Pressable>
    </SheetModal>
  );
}

// Opened when the user comes back from the "reset password" email link
function NewPasswordSheet({ visible, onClose }) {
  const [pw, setPw] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (visible) { setPw(""); setErr(""); setShowPw(false); } }, [visible]);
  const save = async () => {
    if (busy) return;
    if (pw.length < 8) { setErr("Use at least 8 characters"); return; }
    setBusy(true); setErr("");
    try { await setNewPassword(pw); onClose(); Alert.alert("Password updated", "You're signed in with your new password."); }
    catch (e) { setErr(e?.message || "Couldn't update the password. Please try again."); }
    finally { setBusy(false); }
  };
  return (
    <SheetModal visible={visible} onClose={busy ? () => {} : onClose}>
      <Text style={st2.sheetTitle}>Choose a new password</Text>
      <Text style={st2.sheetSub}>Pick something you haven't used before. At least 8 characters.</Text>
      <SettingsField
        icon="lock" value={pw} onChangeText={setPw} placeholder="New password" secureTextEntry={!showPw} autoCapitalize="none" autoCorrect={false} returnKeyType="done" onSubmitEditing={save} error={err}
        right={<Pressable hitSlop={8} accessibilityLabel={showPw ? "Hide password" : "Show password"} onPress={() => setShowPw(v => !v)} style={st2.eye}><AppIcon name={showPw ? "visibility_off" : "visibility"} size={20} color={C.muted} /></Pressable>}
      />
      <Pressable disabled={busy} onPress={save} style={[st2.cta, busy && st2.ctaOff]}>
        {busy && <ActivityIndicator size="small" color={C.onPrimary} />}
        <Text style={st2.ctaText}>{busy ? "Saving…" : "Save password"}</Text>
      </Pressable>
    </SheetModal>
  );
}

function EditProfileSheet({ visible, user, onClose, onSave }) {
  const [name, setName] = useState("");
  useEffect(() => { if (visible) setName(user?.name || ""); }, [visible, user]);
  const trimmed = name.trim();
  const canSave = trimmed.length > 0 && trimmed !== user?.name;
  const save = () => { if (canSave) { onSave({ name: trimmed }); onClose(); } };
  return (
    <SheetModal visible={visible} onClose={onClose}>
      <Text style={st2.sheetTitle}>Edit profile</Text>
      <Text style={st2.sheetSub}>This is how your name appears in Zharph.</Text>
      <SettingsField icon="person" value={name} onChangeText={setName} placeholder="Full name" autoCapitalize="words" returnKeyType="done" onSubmitEditing={save} />
      <SettingsField icon="mail" value={user?.email || ""} editable={false} />
      <Pressable disabled={!canSave} onPress={save} style={[st2.cta, !canSave && st2.ctaOff]}><Text style={st2.ctaText}>Save changes</Text></Pressable>
    </SheetModal>
  );
}

// =====================================================================================
//  SETTINGS PAGE (list UX) — profile · library · one row per settings group · help
//  Each group opens as its own page; search looks through every setting; the "more" menu has quick actions.
//  State that must survive tab switches (user, prefs) lives in <App/>; the sheets keep their own form state.
// =====================================================================================
const SET_DEFAULTS = {
  theme: "dark", reduceMotion: false, preload: true, h24: true, seconds: false, showDate: true, calendar: "g", language: "en", haptics: true, cache: 248,
  notifications: true, wifiOnly: true, hq: true
};
// t: theme cards · seg: segmented choice · tog: switch · cache: size + Clear · nav: plain row (a = action name)
const SET_GROUPS = [
  { id: "look", n: "Appearance", icon: "palette", sub: "Theme, Grid, Motion", items: [
    { t: "theme", k: "theme", n: "Theme", kw: "theme dark light system night day" },
    { t: "seg", k: "grid", icon: "grid_view", n: "Wallpaper grid", o: [["2", "2 columns"], ["3", "3 columns"]] },
    { t: "tog", k: "reduceMotion", icon: "speed", n: "Reduce motion", h: "Fewer animations and parallax" }] },
  { id: "clock", n: "Clock & Date", icon: "schedule", sub: "Time format, Seconds, Calendar", items: [
    { t: "tog", k: "h24", icon: "schedule", n: "24-hour time" },
    { t: "tog", k: "seconds", icon: "schedule", n: "Show seconds", h: "Add a third group" },
    { t: "tog", k: "showDate", icon: "calendar_today", n: "Show date", h: "Show the date with the clock" },
    { t: "seg", k: "calendar", icon: "calendar_today", n: "Calendar", o: [["g", "Gregorian"], ["j", "Jalali"]] }] },
  { id: "data", n: "Data & Storage", icon: "storage", sub: "Wi-Fi only, Quality, Cache", items: [
    { t: "tog", k: "wifiOnly", icon: "wifi", n: "Download on Wi-Fi only", h: "Save your mobile data" },
    { t: "tog", k: "hq", icon: "auto_awesome", n: "High quality previews", h: "Sharper images, uses more data" },
    { t: "tog", k: "preload", icon: "download", n: "Preload next wallpapers", h: "Smoother scrolling" },
    { t: "cache", k: "cache", n: "Cache" }] },
  { id: "notif", n: "Notifications", icon: "notifications", sub: "Alerts, Haptics", items: [
    { t: "tog", k: "notifications", icon: "notifications", n: "New wallpaper alerts", h: "Get notified when new wallpapers drop" },
    { t: "tog", k: "haptics", icon: "vibration", n: "Haptic feedback" }] },
  { id: "lang", n: "Language", icon: "language", items: [
    { t: "seg", k: "language", icon: "language", n: "App language", o: [["en", "English"], ["fa", "\u0641\u0627\u0631\u0633\u06CC"]] }] },
  { id: "account", n: "Account", icon: "person", sub: "Email, Password, Sign out", needsUser: true, items: [
    { t: "nav", icon: "mail", n: "Email", v: "@email" },
    { t: "nav", icon: "lock", n: "Change password", a: "password", chevron: true },
    { t: "nav", icon: "logout", n: "Sign out", a: "signout" },
    { t: "nav", icon: "delete_forever", n: "Delete account", h: "Permanently remove your account and data", a: "delete", danger: true }] }
];
const THEME_CARDS = [["dark", "Dark"], ["light", "Light"], ["system", "System"]];
const THEME_NEXT = { dark: "light", light: "system", system: "dark" };
const THEME_MENU = { dark: "Switch to light", light: "Switch to system", system: "Switch to dark" };

const st3 = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44, marginBottom: 6, zIndex: 1 },
  ib: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 14 },
  search: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10, height: 46, borderRadius: R.md, backgroundColor: C.surface, borderWidth: 1, borderColor: C.hair, paddingHorizontal: 14 },
  searchInput: { flex: 1, minWidth: 0, height: 46, padding: 0, color: C.text, fontFamily: F.body, fontSize: 14 },
  menu: { position: "absolute", right: 0, top: 48, width: 230, backgroundColor: C.surface2, borderRadius: R.md, borderWidth: 1, borderColor: C.hair, overflow: "hidden", elevation: 8, shadowColor: "#000", shadowOpacity: 0.35, shadowRadius: 14, shadowOffset: { width: 0, height: 8 } },
  scrimAll: { ...StyleSheet.absoluteFillObject, zIndex: 0 },
  ph: { alignItems: "center", marginTop: 6 },
  av: { width: 96, height: 96, borderRadius: 28, backgroundColor: C.surface3, alignItems: "center", justifyContent: "center" },
  avT: { fontFamily: F.displayXL, color: C.text, fontSize: 36 },
  cam: { position: "absolute", right: -6, bottom: -6, width: 36, height: 36, borderRadius: 18, backgroundColor: C.primary, borderWidth: 3, borderColor: C.bg, alignItems: "center", justifyContent: "center" },
  name: { fontFamily: F.display, color: C.text, fontSize: 23, letterSpacing: -0.4, marginTop: 16 },
  email: { fontFamily: F.body, color: C.muted, fontSize: 13, marginTop: 2 },
  card: { backgroundColor: C.surface, borderRadius: R.md, borderWidth: 1, borderColor: C.hair, overflow: "hidden" },
  ct: { fontFamily: F.bold, color: C.primary, fontSize: 13, paddingHorizontal: 14, paddingTop: 14, paddingBottom: 2 },
  hr: { height: 1, backgroundColor: C.hair },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  rowBig: { paddingVertical: 13 },
  tile: { width: 36, height: 36, borderRadius: R.sm, backgroundColor: C.surface3, alignItems: "center", justifyContent: "center" },
  tileBig: { width: 42, height: 42, borderRadius: R.sm + 2 },
  tileOn: { backgroundColor: C.primarySoft },
  rowT: { fontFamily: F.bold, color: C.text, fontSize: 14.5 },
  rowS: { fontFamily: F.body, color: C.muted, fontSize: 12.5, marginTop: 1 },
  rowV: { fontFamily: F.body, color: C.muted, fontSize: 13, maxWidth: 150 },
  badge: { minWidth: 24, height: 24, borderRadius: 12, paddingHorizontal: 7, backgroundColor: C.primary, alignItems: "center", justifyContent: "center" },
  badgeT: { fontFamily: F.bold, color: C.onPrimary, fontSize: 12 },
  col: { paddingHorizontal: 14, paddingVertical: 12 },
  segHead: { flexDirection: "row", alignItems: "center", gap: 12, paddingBottom: 10 },
  themes: { flexDirection: "row", gap: 10 },
  th: { flex: 1, borderRadius: R.md, borderWidth: 1.5, borderColor: C.outline, padding: 8, alignItems: "center" },
  thOn: { borderColor: C.primary, backgroundColor: C.primarySoft },
  thT: { fontFamily: F.bold, color: C.muted, fontSize: 13 },
  mini: { alignSelf: "stretch", height: 64, borderRadius: 9, marginBottom: 7, overflow: "hidden", borderWidth: 1, borderColor: "rgba(128,128,128,0.25)" },
  miniBar: { position: "absolute", left: 8, right: 8, top: 10, height: 8, borderRadius: 3, backgroundColor: C.primary },
  miniBlock: { position: "absolute", left: 8, width: "55%", bottom: 10, height: 24, borderRadius: 5, backgroundColor: "rgba(128,128,128,0.35)" },
  pill: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 12, backgroundColor: C.surface2 },
  pillT: { fontFamily: F.bold, color: C.text, fontSize: 13 },
  back: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 14, marginBottom: 6 },
  backBtn: { width: 38, height: 38, borderRadius: R.sm + 2, backgroundColor: C.surface2, alignItems: "center", justifyContent: "center" },
  hubTitle: { fontFamily: F.display, color: C.text, fontSize: 22, letterSpacing: -0.4 },
  empty: { fontFamily: F.body, color: C.muted, fontSize: 13, textAlign: "center", marginTop: 30 }
});

function SRow({ icon, title, sub, value, on, danger, big, onPress, right, chevron }) {
  return (
    <Pressable disabled={!onPress} onPress={onPress} accessibilityRole={onPress ? "button" : undefined} style={({ pressed }) => [st3.row, big && st3.rowBig, pressed && { backgroundColor: C.surface2 }]}>
      <View style={[st3.tile, big && st3.tileBig, on && st3.tileOn]}><AppIcon name={icon} size={big ? 22 : 20} color={danger ? C.danger : on ? C.primary : C.muted} active={!!on} /></View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={[st3.rowT, danger && { color: C.danger }]}>{title}</Text>
        {!!sub && <Text numberOfLines={2} style={st3.rowS}>{sub}</Text>}
      </View>
      {!!value && <Text numberOfLines={1} style={st3.rowV}>{value}</Text>}
      {right}
      {chevron && <AppIcon name="chevron_right" size={20} color={C.muted} />}
    </Pressable>
  );
}
function ThemeMini({ kind }) {
  return (
    <View style={[st3.mini, { backgroundColor: kind === "light" ? "#FAF6F3" : "#100E0E" }]}>
      {kind === "system" && <View style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: "50%", backgroundColor: "#FAF6F3" }} />}
      <View style={st3.miniBar} />
      <View style={st3.miniBlock} />
    </View>
  );
}

const SettingsPage = memo(function SettingsPage({ user, onSignIn, onSignOut, onUpdateProfile, prefs, setPref, resetPrefs, gridColumns, setGridColumns, uploads, saved, onOpenSaved }) {
  const [auth, setAuth] = useState(null); // null | "signin" | "signup"
  const [authMode, setAuthMode] = useState("signin");
  const [editOpen, setEditOpen] = useState(false);
  const [hub, setHub] = useState(null);
  const [sOpen, setSOpen] = useState(false);
  const [q, setQ] = useState("");
  const [menu, setMenu] = useState(false);
  const openAuth = (mode) => { setAuthMode(mode); setAuth(true); };

  const handleAuth = async ({ mode, name, email, password }) => {
    await signInOrUp({ mode, name, email, password });   // throws a friendly Error -> shown inside the sheet
    setAuth(null);                                       // <App/> listens to the Supabase session and sets the user
  };
  const confirmSignOut = () => Alert.alert("Sign out?", "You'll need to sign in again to sync your wallpapers.", [
    { text: "Cancel", style: "cancel" },
    { text: "Sign out", style: "destructive", onPress: onSignOut }
  ]);
  const confirmDelete = () => Alert.alert("Delete account?", "This permanently deletes your account and synced data. This can't be undone.", [
    { text: "Cancel", style: "cancel" },
    { text: "Delete", style: "destructive", onPress: async () => { try { await deleteAccount(); } catch (e) { Alert.alert("Couldn't delete account", e?.message || "Please try again."); } } }
  ]);
  const changePassword = () => Alert.alert("Change password", `We'll email a reset link to ${user?.email}.`, [
    { text: "Cancel", style: "cancel" },
    { text: "Send link", onPress: async () => { try { await resetPassword(user?.email); Alert.alert("Link sent", "Check your inbox to finish changing your password."); } catch (e) { Alert.alert("Couldn't send link", e?.message || "Please try again."); } } }
  ]);
  const confirmReset = () => Alert.alert("Reset all settings?", "Everything on this page goes back to its default.", [
    { text: "Cancel", style: "cancel" },
    { text: "Reset", style: "destructive", onPress: resetPrefs }
  ]);
  const actions = { password: changePassword, signout: confirmSignOut, delete: confirmDelete };

  const groups = SET_GROUPS.filter(g => !g.needsUser || user);
  const hubG = hub ? groups.find(g => g.id === hub) : null;
  useEffect(() => { if (hub && !hubG) setHub(null); }, [hub, hubG]);
  useEffect(() => {
    if (!hub && !sOpen && !menu) return undefined;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (menu) setMenu(false); else if (sOpen) { setSOpen(false); setQ(""); } else setHub(null);
      return true;
    });
    return () => sub.remove();
  }, [hub, sOpen, menu]);

  const getV = (k) => (k === "grid" ? String(gridColumns) : prefs[k]);
  const setV = (k, v) => { if (k === "grid") setGridColumns(Number(v)); else setPref(k, v); };
  const isEd = (k) => (k === "grid" ? gridColumns !== 2 : prefs[k] !== SET_DEFAULTS[k]);
  const edCount = (g) => g.items.filter(x => x.k && isEd(x.k)).length;
  const langLabel = prefs.language === "fa" ? "\u0641\u0627\u0631\u0633\u06CC" : "English";
  const plural = uploads === 1 ? "upload" : "uploads";

  const renderItem = (x, i) => {
    const key = (x.k || x.n || x.t) + i;
    if (x.t === "theme") {
      return (
        <View key={key} style={st3.col}>
          <View style={st3.themes}>
            {THEME_CARDS.map(([v, l]) => (
              <Pressable key={v} accessibilityRole="button" accessibilityState={{ selected: prefs.theme === v }} onPress={() => setPref("theme", v)} style={[st3.th, prefs.theme === v && st3.thOn]}>
                <ThemeMini kind={v} />
                <Text style={[st3.thT, prefs.theme === v && { color: C.text }]}>{l}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      );
    }
    if (x.t === "seg") {
      return (
        <View key={key} style={st3.col}>
          <View style={st3.segHead}>
            <View style={[st3.tile, isEd(x.k) && st3.tileOn]}><AppIcon name={x.icon} size={20} color={isEd(x.k) ? C.primary : C.muted} active={isEd(x.k)} /></View>
            <Text style={st3.rowT}>{x.n}</Text>
          </View>
          <Seg height={40} options={x.o} value={String(getV(x.k))} onChange={v => setV(x.k, v)} />
        </View>
      );
    }
    if (x.t === "tog") {
      return <SRow key={key} icon={x.icon} title={x.n} sub={x.h} on={isEd(x.k)} onPress={() => setV(x.k, !getV(x.k))} right={<Toggle value={!!getV(x.k)} onChange={v => setV(x.k, v)} label={x.n} />} />;
    }
    if (x.t === "cache") {
      return (
        <SRow key={key} icon="storage" title="Cache" sub={`${prefs.cache} MB used`} on={isEd("cache")}
          right={<Pressable accessibilityRole="button" disabled={!prefs.cache} onPress={() => setPref("cache", 0 /* TODO: also clear the real image cache */)} style={[st3.pill, !prefs.cache && { opacity: 0.4 }]}><Text style={st3.pillT}>Clear</Text></Pressable>} />
      );
    }
    return <SRow key={key} icon={x.icon} title={x.n} sub={x.h} value={x.v === "@email" ? user?.email : x.v} danger={x.danger} onPress={x.a ? actions[x.a] : undefined} chevron={x.chevron} />;
  };
  const list = (items) => items.map((x, i) => <React.Fragment key={(x.k || x.n || x.t) + i}>{i > 0 && <View style={st3.hr} />}{renderItem(x, i)}</React.Fragment>);

  const ql = q.trim().toLowerCase();
  const matches = [];
  if (sOpen && ql) groups.forEach(g => g.items.forEach(x => { if (((x.n || "") + " " + (x.kw || "") + " " + (x.h || "") + " " + g.n).toLowerCase().includes(ql)) matches.push(x); }));

  const topBar = sOpen ? (
    <View style={st3.bar}>
      <Pressable accessibilityLabel="Close search" onPress={() => { setSOpen(false); setQ(""); }} style={st3.ib}><AppIcon name="arrow_back" size={22} color={C.text} /></Pressable>
      <View style={st3.search}>
        <AppIcon name="search" size={18} color={C.muted} />
        <TextInput autoFocus value={q} onChangeText={setQ} placeholder="Search settings" placeholderTextColor="#8A7F79" selectionColor={C.primary} autoCorrect={false} style={st3.searchInput} />
      </View>
    </View>
  ) : (
    <View style={[st3.bar, { justifyContent: "flex-end", zIndex: menu ? 10 : 1 }]}>
      <Pressable accessibilityLabel="Search settings" onPress={() => { setMenu(false); setSOpen(true); }} style={st3.ib}><AppIcon name="search" size={22} color={C.text} /></Pressable>
      <Pressable accessibilityLabel="More" onPress={() => setMenu(m => !m)} style={st3.ib}><AppIcon name="more_vert" size={22} color={C.text} /></Pressable>
      {menu && (
        <View style={st3.menu}>
          <SRow icon={prefs.theme === "light" ? "dark_mode" : "light_mode"} title={THEME_MENU[prefs.theme]} onPress={() => { setPref("theme", THEME_NEXT[prefs.theme]); setMenu(false); }} />
          <View style={st3.hr} />
          <SRow icon="restart_alt" title="Reset all settings" onPress={() => { setMenu(false); confirmReset(); }} />
          {!!user && <><View style={st3.hr} /><SRow icon="logout" title="Sign out" danger onPress={() => { setMenu(false); confirmSignOut(); }} /></>}
        </View>
      )}
    </View>
  );

  let body;
  if (hubG) {
    body = (
      <>
        <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => setHub(null)} style={st3.back}>
          <View style={st3.backBtn}><AppIcon name="arrow_back" size={20} color={C.text} /></View>
          <Text style={st3.hubTitle}>{hubG.n}</Text>
        </Pressable>
        <View style={[st3.card, { marginTop: 8 }]}>{list(hubG.items)}</View>
      </>
    );
  } else if (sOpen) {
    body = (
      <>
        {topBar}
        {ql ? (matches.length
          ? <View style={[st3.card, { marginTop: 14 }]}>{list(matches)}</View>
          : <Text style={st3.empty}>No settings found</Text>) : null}
      </>
    );
  } else {
    body = (
      <>
        {topBar}
        {user ? (
          <View style={st3.ph}>
            <Pressable accessibilityRole="button" accessibilityLabel="Edit profile" onPress={() => setEditOpen(true)} style={st3.av}>
              <Text style={st3.avT}>{initialsOf(user.name)}</Text>
              <View style={st3.cam}><AppIcon name="photo_camera" size={17} color={C.onPrimary} /></View>
            </Pressable>
            <Text numberOfLines={1} style={st3.name}>{user.name}</Text>
            <Text numberOfLines={1} style={st3.email}>{user.email} · {uploads} {plural}</Text>
          </View>
        ) : (
          <View style={st2.guestCard}>
            <View style={st2.guestIcon}><AppIcon name="person" size={34} color={C.text} /></View>
            <Text style={s.title}>Welcome to Zharph</Text>
            <Text style={s.placeholderText}>Sign in to sync your saved wallpapers and settings across all your devices.</Text>
            <View style={{ alignSelf: "stretch" }}>
              <Press onPress={() => openAuth("signin")} style={[s.primaryButton, { alignItems: "center", paddingVertical: 14 }]}><Text style={s.primaryText}>Sign in</Text></Press>
            </View>
            <Pressable onPress={() => openAuth("signup")} style={st2.linkRow}><Text style={st2.linkText}>Create an account</Text></Pressable>
          </View>
        )}

        <View style={[st3.card, { marginTop: 20 }]}>
          <Text style={st3.ct}>Library</Text>
          <SRow big on icon="wallpaper" title="Uploads & saved" sub={`${uploads} ${plural} · ${saved} saved`} onPress={onOpenSaved} chevron
            right={saved > 0 ? <View style={st3.badge}><Text style={st3.badgeT}>{saved}</Text></View> : null} />
        </View>

        <View style={[st3.card, { marginTop: 12 }]}>
          {groups.map((g, i) => (
            <React.Fragment key={g.id}>
              {i > 0 && <View style={st3.hr} />}
              <SRow big icon={g.icon} title={g.n} sub={g.sub || langLabel} on={edCount(g) > 0} chevron onPress={() => setHub(g.id)} />
            </React.Fragment>
          ))}
        </View>

        <View style={[st3.card, { marginTop: 12 }]}>
          <Text style={st3.ct}>Help</Text>
          {[["support_agent", "Contact support", LINKS.support], ["star", "Rate Zharph", LINKS.rate], ["policy", "Privacy policy", LINKS.privacy], ["description", "Terms of service", LINKS.terms]].map(([icon, n, url]) => (
            <SRow key={n} big icon={icon} title={n} onPress={() => openLink(url)} chevron />
          ))}
        </View>
        <Text style={[st3.email, { textAlign: "center", marginTop: 18 }]}>Zharph v{APP_VERSION}</Text>
      </>
    );
  }

  return (
    <View style={{ paddingBottom: 100, paddingHorizontal: 4 }}>
      {menu && !hubG && !sOpen && <Pressable accessibilityLabel="Close menu" style={st3.scrimAll} onPress={() => setMenu(false)} />}
      {body}
      <AuthSheet visible={!!auth} mode={authMode} setMode={setAuthMode} onClose={() => setAuth(null)} onSubmit={handleAuth} />
      <EditProfileSheet visible={editOpen} user={user} onClose={() => setEditOpen(false)} onSave={onUpdateProfile} />
    </View>
  );
});

// =====================================================================================
//  WallpaperCard (merged from components/WallpaperCard.js)
//  Uses the in-file theme (C / F / R) and AppIcon, so it needs no extra imports. Exported so it can be used elsewhere.
// =====================================================================================
export function WallpaperCard({ item, onPress, isAdd = false }) {
  if (isAdd) {
    return (
      <Pressable onPress={onPress} style={({ pressed }) => [wc.addCard, pressed && wc.pressed]}>
        <View style={wc.addIcon}><AppIcon name="add" size={28} color={C.onPrimary} /></View>
        <Text style={wc.addTitle}>Your photo</Text>
        <Text style={wc.addSub}>Create wallpaper</Text>
      </Pressable>
    );
  }
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [wc.card, pressed && wc.pressed]}>
      <Image source={{ uri: item.image }} style={wc.image} resizeMode="cover" />
      <View style={wc.imageShade} />
      <View style={wc.cardBadge}><AppIcon name="layers" size={14} color="#FFFFFF" /></View>
      <View style={wc.caption}>
        <Text numberOfLines={1} style={wc.title}>{item.title}</Text>
        <Text style={wc.category}>{item.category}</Text>
      </View>
    </Pressable>
  );
}
const wc = StyleSheet.create({
  card: { width: "30.8%", height: 184, borderRadius: 18, overflow: "hidden", backgroundColor: C.surface2 },
  image: { width: "100%", height: "100%" },
  imageShade: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(8,8,12,0.12)" },
  cardBadge: { position: "absolute", top: 8, right: 8, width: 27, height: 27, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(16,16,20,0.52)" },
  caption: { position: "absolute", left: 9, right: 6, bottom: 10 },
  title: { fontFamily: F.bold, color: "#FFFFFF", fontSize: 12 },
  category: { fontFamily: F.body, color: "#E1DDE8", fontSize: 10, marginTop: 3 },
  addCard: { width: "30.8%", height: 184, borderRadius: 18, borderWidth: 1.5, borderColor: C.outline, borderStyle: "dashed", backgroundColor: C.surface, alignItems: "center", justifyContent: "center", paddingHorizontal: 5 },
  addIcon: { width: 48, height: 48, borderRadius: 24, backgroundColor: C.primary, alignItems: "center", justifyContent: "center", marginBottom: 12 },
  addTitle: { fontFamily: F.bold, color: C.text, fontSize: 12 },
  addSub: { fontFamily: F.body, color: C.muted, fontSize: 10, marginTop: 5, textAlign: "center" },
  pressed: { opacity: 0.78, transform: [{ scale: 0.985 }] }
});

export default function App() {
  const [fontsLoaded] = useFonts(UI_FONT_ASSETS);
  useEffect(() => {
    if (!fontsLoaded) return undefined;
    const h = InteractionManager.runAfterInteractions(() => { loadClockFonts(); ufInit(); });
    return () => h.cancel();
  }, [fontsLoaded]);

  useEffect(() => {
    NavigationBar.setStyle("light");
    NavigationBar.setButtonStyleAsync("light").catch(() => {});
    NavigationBar.setBackgroundColorAsync(C.bg).catch(() => {}); // same warm black as the bottom bar tint (rgba(16,14,14,…))
  }, []);
  const [tab, setTab] = useState("Home");
  const rootRef = useRef(null);
  const previewTargetRef = useRef(null);
  const [sharedTransition, setSharedTransition] = useState(null);
  const lastEditorTransition = useRef(null);
  const transitionX = useRef(new Animated.Value(0)).current;
  const transitionY = useRef(new Animated.Value(0)).current;
  const transitionW = useRef(new Animated.Value(0)).current;
  const transitionH = useRef(new Animated.Value(0)).current;
  const transitionRadius = useRef(new Animated.Value(R.md)).current;
  const transitionBorderWidth = useRef(new Animated.Value(0)).current;
  const editorBackOpacity = useRef(new Animated.Value(0)).current;
  const editorBackY = useRef(new Animated.Value(-12)).current;
  const editorTitleOpacity = useRef(new Animated.Value(0)).current;
  const editorTitleY = useRef(new Animated.Value(-12)).current;
  const editorApplyOpacity = useRef(new Animated.Value(0)).current;
  const editorApplyY = useRef(new Animated.Value(-12)).current;
  const transitionBgOpacity = useRef(new Animated.Value(0)).current;
  const transitionBgScale = useRef(new Animated.Value(1.04)).current;
  const openEditor = (wallpaper, cardRef) => {
    resetEditor();
    if (wallpaper.remote && wallpaper.remote.meta && wallpaper.remote.meta.clock) {
      const m = wallpaper.remote.meta;
      editor.set(st => ({ ...st, clockId: "remote", clockColor: parseClockStyle(m.clock).color || "#FFFFFF" }));
    }
    histReset(); zoomReset(); setZoomOn(false);
    subRef.current = null; subAnim.setValue(0); setSubPage(null); setShownTool(null); setVisited({});
    sheetProgress.setValue(0);
    sheetOpenRef.current = false;
    if (!cardRef?.current || !rootRef.current) {
      setSelectedWallpaper(wallpaper);
      setActiveEditorTool(null);
      setTab("Editor");
      clockOpacity.setValue(0);
      clockTranslateY.setValue(14);
      clockScale.setValue(0.94);
      requestAnimationFrame(() => {
        Animated.parallel([
          buildEditorToolsMotion(false),
          animateEditorClock(false)
        ]).start();
      });
      return;
    }
    cardRef.current.measureInWindow((cardX, cardY, cardW, cardH) => {
      rootRef.current?.measureInWindow((rootX, rootY) => {
        const start = { x: cardX - rootX, y: cardY - rootY, width: cardW, height: cardH };
        setSelectedWallpaper(wallpaper);
        setActiveEditorTool(null);
        lastEditorTransition.current = { uri: wallpaper.uri, start, target: null };
        setSharedTransition({ uri: wallpaper.uri, start, closing: false });
        transitionX.setValue(start.x);
        transitionY.setValue(start.y);
        transitionW.setValue(start.width);
        transitionH.setValue(start.height);
        transitionRadius.setValue(R.md);
        transitionBorderWidth.setValue(0);
        editorBackOpacity.setValue(0);
        editorBackY.setValue(-12);
        editorTitleOpacity.setValue(0);
        editorTitleY.setValue(-12);
        editorApplyOpacity.setValue(0);
        editorApplyY.setValue(-12);
        transitionBgOpacity.setValue(0);
        transitionBgScale.setValue(1.04);
        clockOpacity.setValue(0);
        clockTranslateY.setValue(14);
        clockScale.setValue(0.94);
        setTab("Editor");
        setTimeout(() => {
          if (lastEditorTransition.current?.uri === wallpaper.uri) {
            animateEditorClock(false).start();
          }
        }, 170);
      });
    });
  };
  const openEditorRef = useRef(null); openEditorRef.current = openEditor;
  const onOpenCard = useCallback((wp, ref) => openEditorRef.current(wp, ref), []);
  const homeScrollRef = useRef(null);
  const [selectedWallpaper, setSelectedWallpaper] = useState({ title: items[0][0], uri: items[0][1] });
  const [activeEditorTool, setActiveEditorTool] = useState(null);
  const editorToolPressScale = useRef(Array.from({ length: 5 }, () => new Animated.Value(1))).current;
  const editorToolPressOpacity = useRef(Array.from({ length: 5 }, () => new Animated.Value(1))).current;
  const editorToolMotion = useRef(Array.from({ length: 5 }, () => ({
    opacity: new Animated.Value(0),
    translateY: new Animated.Value(22)
  }))).current;
  const animateEditorToolPressIn = (index) => {
    const scale = editorToolPressScale[index];
    const opacity = editorToolPressOpacity[index];
    scale.stopAnimation();
    opacity.stopAnimation();
    Animated.parallel([
      Animated.timing(scale, {
        toValue: 0.95,
        duration: 90,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true
      }),
      Animated.timing(opacity, {
        toValue: 0.82,
        duration: 90,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true
      })
    ]).start();
  };
  const animateEditorToolPressOut = (index) => {
    const scale = editorToolPressScale[index];
    const opacity = editorToolPressOpacity[index];
    scale.stopAnimation();
    opacity.stopAnimation();
    Animated.parallel([
      Animated.spring(scale, { toValue: 1, ...SPRING }),
      Animated.timing(opacity, {
        toValue: 1,
        duration: 110,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true
      })
    ]).start();
  };
  const editorToolsHeaderMotion = useRef(Array.from({ length: 2 }, () => ({
    opacity: new Animated.Value(0),
    translateY: new Animated.Value(22)
  }))).current;
  const editorToolsExitRunning = useRef(false);
  const clockOpacity = useRef(new Animated.Value(0)).current;
  const clockTranslateY = useRef(new Animated.Value(14)).current;
  const clockScale = useRef(new Animated.Value(0.94)).current;
  const animateEditorClock = useCallback((closing = false) => {
    clockOpacity.stopAnimation();
    clockTranslateY.stopAnimation();
    clockScale.stopAnimation();
    return Animated.parallel([
      Animated.timing(clockOpacity, {
        toValue: closing ? 0 : 1,
        duration: closing ? 75 : 260,
        delay: closing ? 0 : 170,
        easing: closing ? Easing.in(Easing.cubic) : Easing.out(Easing.cubic),
        useNativeDriver: true
      }),
      Animated.timing(clockTranslateY, {
        toValue: closing ? -18 : 0,
        duration: closing ? 105 : 250,
        delay: closing ? 0 : 170,
        easing: closing ? Easing.in(Easing.cubic) : Easing.out(Easing.cubic),
        useNativeDriver: true
      }),
      Animated.timing(clockScale, {
        toValue: closing ? 0.88 : 1,
        duration: closing ? 105 : 250,
        delay: closing ? 0 : 170,
        easing: closing ? Easing.in(Easing.cubic) : Easing.out(Easing.cubic),
        useNativeDriver: true
      })
    ]);
  }, [clockOpacity, clockTranslateY, clockScale]);
  const buildEditorToolsMotion = useCallback((closing = false) => {
    const allMotion = editorToolMotion.concat(editorToolsHeaderMotion);
    allMotion.forEach((motion) => {
      motion.opacity.stopAnimation();
      motion.translateY.stopAnimation();
      if (!closing) {
        motion.opacity.setValue(0);
        motion.translateY.setValue(22);
      }
    });
    const makeMotion = (motion) => Animated.parallel([
      Animated.timing(motion.opacity, {
        toValue: closing ? 0 : 1,
        duration: closing ? 180 : 210,
        easing: closing ? Easing.in(Easing.cubic) : Easing.out(Easing.cubic),
        useNativeDriver: true
      }),
      Animated.timing(motion.translateY, {
        toValue: closing ? 22 : 0,
        duration: closing ? 180 : 240,
        easing: closing ? Easing.in(Easing.cubic) : Easing.out(Easing.cubic),
        useNativeDriver: true
      })
    ]);
    const cards = Animated.stagger(closing ? 35 : 27, editorToolMotion.map(makeMotion));
    const headings = Animated.stagger(closing ? 35 : 55, editorToolsHeaderMotion.map(makeMotion));
    return closing
      ? Animated.parallel([cards, headings])
      : Animated.parallel([cards, Animated.sequence([Animated.delay(150), headings])]);
  }, [editorToolMotion, editorToolsHeaderMotion]);
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();

  // ---- Bottom sheet (editor tools) ----
  // One progress value (0 = closed, 1 = open) drives the sheet, the tool cards and the icons,
  // so everything stays perfectly in sync. Everything is transform/opacity only, so it runs entirely on the native thread (60fps, no JS per frame).
  const SHEET_H = Math.round(windowHeight / 3); // one third of the screen
  const TOOL_H = 68;          // card height when closed
  const TOOL_H_MIN = 32;      // card height inside the sheet
  const TOOLS_BOTTOM = 12;    // distance of the cards from the bottom when closed
  const HANDLE_ZONE = 28;     // space above the cards inside the sheet (holds the grab handle)
  const sheetProgress = useRef(new Animated.Value(0)).current;
  const [editorLayout, setEditorLayout] = useState({ pageH: 0, stageY: 0, stageH: 0 });
  const sheetOpenRef = useRef(false);
  const sheetHRef = useRef(SHEET_H);
  sheetHRef.current = SHEET_H;
  // ---- sheet pages: tab content cross-fade + full-sheet sub pages ("Your design", custom color) ----
  const [shownTool, setShownTool] = useState(null);
  const [visited, setVisited] = useState({}); // tabs are mounted lazily, the first time they are opened
  const histRev = useHistRev();
  const toolMask = useEditor(toolMaskOf); // which tools hold changes -> dot on their card
  const [zoomOn, setZoomOn] = useState(false);
  const zoomPanStart = useRef(0);
  const zoomOnRef = useRef(false); zoomOnRef.current = zoomOn;
  useEffect(() => { const id = sheetProgress.addListener(({ value }) => { zoomNow.p = value; }); return () => sheetProgress.removeListener(id); }, [sheetProgress]);
  const zoomPan = useRef(PanResponder.create({   // while zoomed, dragging on the empty space around the clock moves the zoomed picture up / down
    onStartShouldSetPanResponder: () => zoomOnRef.current,
    onMoveShouldSetPanResponder: () => zoomOnRef.current,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => { zoomView.ty.stopAnimation(); zoomPanStart.current = zoomNow.ty; },
    onPanResponderMove: (_, g) => {
      const v = clamp(zoomPanStart.current + g.dy / fitNow(), -zoomNow.maxY, zoomNow.maxY);
      zoomNow.ty = v; zoomView.ty.setValue(v);
    }
  })).current;
  const toggleZoom = () => { const next = !zoomOn; setZoomOn(next); zoomTo(next); };
  const subMark = useRef(null);
  const [subPage, setSubPage] = useState(null); // null | "design" | "color"
  const subRef = useRef(null);
  const subBackup = useRef(null);
  const subAnim = useRef(new Animated.Value(0)).current;
  const tabAnim = useRef(TOOL_NAMES.map(() => new Animated.Value(0))).current;
  const tabOpacity = useMemo(() => TOOL_NAMES.map((_, i) => Animated.multiply(tabAnim[i], subAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }))), [tabAnim, subAnim]);
  const cardsHideOpacity = useMemo(() => subAnim.interpolate({ inputRange: [0, 0.5], outputRange: [1, 0], extrapolate: "clamp" }), [subAnim]);
  useEffect(() => {
    TOOL_NAMES.forEach((name, i) => {
      const on = shownTool === name;
      tabAnim[i].stopAnimation();
      Animated.timing(tabAnim[i], { toValue: on ? 1 : 0, duration: on ? 240 : 140, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    });
  }, [shownTool, tabAnim]);
  const openSub = useCallback((type) => {
    subRef.current = type;
    subBackup.current = editor.get().clockColor;
    subMark.current = histMark();
    setSubPage(type);
    subAnim.stopAnimation();
    Animated.spring(subAnim, { toValue: 1, ...SPRING_SHEET }).start();
  }, [subAnim]);
  const closeSub = useCallback((revert) => {
    const type = subRef.current;
    if (!type) return;
    if (type === "color" && revert) { editor.set({ clockColor: subBackup.current }); if (subMark.current) histRollback(subMark.current); } // Back = discard the color changes
    subRef.current = null;
    subAnim.stopAnimation();
    Animated.spring(subAnim, { toValue: 0, ...SPRING_SHEET }).start(({ finished }) => { if (finished) setSubPage(null); });
  }, [subAnim]);
  const openDesign = useCallback(() => openSub("design"), [openSub]);
  const openColor = useCallback(() => openSub("color"), [openSub]);
  const openSheet = useCallback(() => {
    sheetOpenRef.current = true;
    sheetProgress.stopAnimation();
    Animated.spring(sheetProgress, { toValue: 1, ...SPRING_SHEET }).start();
  }, [sheetProgress]);
  const closeSheet = useCallback(() => {
    if (subRef.current) closeSub(true);
    sheetOpenRef.current = false;
    setZoomOn(false); zoomTo(false);   // the zoom button only exists while the sheet is open
    setActiveEditorTool(null); // the selected card's color fades out (see the effect below) while the sheet closes
    sheetProgress.stopAnimation();
    Animated.spring(sheetProgress, { toValue: 0, ...SPRING_SHEET }).start();
  }, [sheetProgress, closeSub]);
  const sheetPan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => sheetProgress.stopAnimation(),
    onPanResponderMove: (_, g) => sheetProgress.setValue(Math.max(0, Math.min(1, 1 - g.dy / sheetHRef.current))),
    onPanResponderRelease: (_, g) => {
      const tap = Math.abs(g.dy) < 5 && Math.abs(g.dx) < 5;
      if (tap || g.dy > sheetHRef.current * 0.25 || g.vy > 0.7) closeSheet();
      else openSheet();
    },
    onPanResponderTerminate: () => openSheet()
  })).current;
  const sheetY = sheetProgress.interpolate({ inputRange: [0, 1], outputRange: [SHEET_H, 0], extrapolate: "clamp" });
  // The sheet's top edge rises at SHEET_H * progress. The cards first rise a bit behind it, then ride just under its top edge.
  const toolsTop0 = TOOLS_BOTTOM + TOOL_H;
  const toolsP0 = Math.min(0.6, toolsTop0 / SHEET_H);
  const toolsTopAt = (p) => {
    const end = SHEET_H - HANDLE_ZONE;
    return p <= toolsP0 ? toolsTop0 : toolsTop0 + (end - toolsTop0) * (p - toolsP0) / (1 - toolsP0);
  };
  // sample + box-filter the path so the cards never change speed abruptly
  const TOOLS_STEPS = 30;
  const toolsInput = [], toolsOutput = [];
  for (let i = 0; i <= TOOLS_STEPS; i++) {
    const p = i / TOOLS_STEPS;
    let sum = 0;
    for (let k = -3; k <= 3; k++) sum += toolsTopAt(p + k / TOOLS_STEPS);
    toolsInput.push(p);
    toolsOutput.push(-(sum / 7 - toolsTop0));
  }
  const toolsTranslateY = sheetProgress.interpolate({ inputRange: toolsInput, outputRange: toolsOutput, extrapolate: "clamp" });
  // card shrinking (transform-only): bottom cap moves up, middle part squashes
  const CARD_CAP = Math.floor(TOOL_H_MIN / 2);
  const CARD_SHRINK = TOOL_H - TOOL_H_MIN;
  const CARD_MID_H = TOOL_H - 2 * CARD_CAP + 2;
  const cardCapY = sheetProgress.interpolate({ inputRange: [0, 1], outputRange: [0, -CARD_SHRINK], extrapolate: "clamp" });
  const cardMidScale = sheetProgress.interpolate({ inputRange: [0, 1], outputRange: [1, 1 - CARD_SHRINK / CARD_MID_H], extrapolate: "clamp" });
  const cardMidY = sheetProgress.interpolate({ inputRange: [0, 1], outputRange: [0, -CARD_SHRINK / 2], extrapolate: "clamp" });
  const LABEL_H = 14;
  const LABEL_LIFT = 1.5;     // small optical lift so the label looks centered in the short card
  const toolIconOpacity = sheetProgress.interpolate({ inputRange: [0, 0.6], outputRange: [1, 0], extrapolate: "clamp" });
  const toolsHeaderOpacity = sheetProgress.interpolate({ inputRange: [0, 0.5], outputRange: [1, 0], extrapolate: "clamp" });
  // per-card "selected" fade (color of the selected card fades in/out instead of switching instantly)
  const toolActiveAnim = useRef(TOOL_NAMES.map(() => new Animated.Value(0))).current;
  useEffect(() => {
    TOOL_NAMES.forEach((name, i) => {
      const on = activeEditorTool === name;
      toolActiveAnim[i].stopAnimation();
      Animated.timing(toolActiveAnim[i], { toValue: on ? 1 : 0, duration: on ? 160 : 200, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    });
  }, [activeEditorTool, toolActiveAnim]);
  // ---- top category bar: lives in an overlay OUTSIDE the blur target (like the bottom nav) so it can really blur the cards scrolling under it ----
  const scrollY = useRef(new Animated.Value(0)).current;     // fed natively by the page ScrollView
  const [topBarRestY, setTopBarRestY] = useState(58);        // where the bar sits inside the scroll content before it sticks (measured from its spacer)
  const [stageTop, setStageTop] = useState(0);               // top of the page area (= status bar inset), measured from the root view
  const topBarOpacity = useRef(new Animated.Value(1)).current;
  const [filterScrolledLeft, setFilterScrolledLeft] = useState(false); // chips scrolled away from the start -> left fade appears
  const filterFadeOpacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(filterFadeOpacity, { toValue: filterScrolledLeft ? 1 : 0, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [filterScrolledLeft, filterFadeOpacity]);
  const [filterAtEnd, setFilterAtEnd] = useState(false); // chips scrolled all the way right -> right fade disappears
  const filterEndFadeOpacity = useRef(new Animated.Value(1)).current;
  const filterMetrics = useRef({ x: 0, w: 0, cw: 0 });
  const updateFilterEdges = useCallback(() => {
    const { x, w, cw } = filterMetrics.current;
    const left = x > 1, end = w > 0 && cw > 0 && x + w >= cw - 1;
    setFilterScrolledLeft(cur => cur === left ? cur : left);
    setFilterAtEnd(cur => cur === end ? cur : end);
  }, []);
  useEffect(() => {
    Animated.timing(filterEndFadeOpacity, { toValue: filterAtEnd ? 0 : 1, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [filterAtEnd, filterEndFadeOpacity]);
  const [navTab, setNavTab] = useState("Home");
  const [barWidth, setBarWidth] = useState(0);
  const blurTargetRef = useRef(null);
  const navTranslateY = useRef(new Animated.Value(0)).current;
  const lastScrollY = useRef(0);
  const navHidden = useRef(false);
  const animateNav = useCallback((hide) => {
    navTranslateY.stopAnimation();
    if (hide) {
      Animated.parallel([
        Animated.timing(navTranslateY, { toValue: NAV_H + 80, duration: 220, easing: EASE_OUT, useNativeDriver: true })
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(navTranslateY, { toValue: 0, duration: 220, easing: EASE_OUT, useNativeDriver: true })
      ]).start();
    }
  }, [navTranslateY]);
  // Same hide/show motion as list scrolling, driven by opening/closing the editor.
  const NAV_SHOW_DELAY_AFTER_EDITOR = 320; // wait for editor tools exit to finish
  const prevTabRef = useRef(tab);
  useEffect(() => {
    const prev = prevTabRef.current;
    prevTabRef.current = tab;
    if (tab === "Editor") {
      navHidden.current = true;
      animateNav(true);
      return;
    }
    if (prev === "Editor") {
      navHidden.current = false;
      const id = setTimeout(() => animateNav(false), NAV_SHOW_DELAY_AFTER_EDITOR);
      return () => clearTimeout(id);
    }
  }, [tab, animateNav]);
  const layoutHeaderOpacity = useRef(new Animated.Value(1)).current;
  const layoutStickyOpacity = useRef(new Animated.Value(0)).current;
  const layoutStickyY = useRef(new Animated.Value(-48)).current;
  const layoutInStickyBar = useRef(false);
  const [stickyLayoutActive, setStickyLayoutActive] = useState(false);
  // Every tab remembers its own scroll position. While a tab is being swapped / restored, the scroll events
  // that come from the programmatic jump are NOT real user scrolls, so they must not hide the bottom nav.
  const scrollPositions = useRef({});
  const restoringScroll = useRef(false);
  const restoreTimer = useRef(null);
  const beginScrollRestore = useCallback((name) => {
    restoringScroll.current = true;
    lastScrollY.current = scrollPositions.current[name] || 0; // baseline = where we are about to land, so delta is 0
    clearTimeout(restoreTimer.current);
    restoreTimer.current = setTimeout(() => { restoringScroll.current = false; }, 350);
  }, []);
  useEffect(() => {
    if (tab === "Editor") return;
    beginScrollRestore(tab);
    const y = scrollPositions.current[tab] || 0;
    const jump = () => homeScrollRef.current?.scrollTo({ y, animated: false });
    const raf = requestAnimationFrame(jump);
    const retry = setTimeout(jump, 60); // in case the content was not laid out yet
    return () => { cancelAnimationFrame(raf); clearTimeout(retry); };
  }, [tab, beginScrollRestore]);
  useEffect(() => () => clearTimeout(restoreTimer.current), []);
  const handlePageScroll = (event) => {
    const y = Math.max(0, event.nativeEvent.contentOffset.y);
    if (!restoringScroll.current && tab !== "Editor") scrollPositions.current[tab] = y;
    lastScrollY.current = y;

    const shouldShowStickyLayout = y > 64;
    if (shouldShowStickyLayout !== layoutInStickyBar.current) {
      layoutInStickyBar.current = shouldShowStickyLayout;
      setStickyLayoutActive(shouldShowStickyLayout);
      layoutHeaderOpacity.stopAnimation();
      layoutStickyOpacity.stopAnimation();
      layoutStickyY.stopAnimation();
      Animated.timing(layoutHeaderOpacity, {
        toValue: shouldShowStickyLayout ? 0 : 1,
        duration: 180,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true
      }).start();
      if (shouldShowStickyLayout) {
        layoutStickyY.setValue(-48);
        Animated.parallel([
          Animated.timing(layoutStickyOpacity, {
            toValue: 1,
            duration: 260,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true
          }),
          Animated.spring(layoutStickyY, { toValue: 0, ...SPRING })
        ]).start();
      } else {
        Animated.parallel([
          Animated.timing(layoutStickyOpacity, {
            toValue: 0,
            duration: 150,
            easing: Easing.in(Easing.cubic),
            useNativeDriver: true
          }),
          Animated.timing(layoutStickyY, {
            toValue: -48,
            duration: 180,
            easing: Easing.in(Easing.cubic),
            useNativeDriver: true
          })
        ]).start();
      }
    }
    // bottom nav no longer hides/shows on scroll (it still hides while the editor is open, see the tab effect above)
  };
  const slotWidth = barWidth > 0 ? barWidth / tabs.length : 0;
  const indicatorLeft = Math.max(0, (slotWidth - NAV_PILL_W) / 2); // active pill centered over its tab
  const liquidX = useRef(new Animated.Value(0)).current;
  // 0 = inactive, 1 = active; drives the crossfade of icon + label color (opacity only, native driver)
  const tabFade = useRef(tabs.reduce((acc, [name]) => {
    acc[name] = new Animated.Value(name === "Home" ? 1 : 0);
    return acc;
  }, {})).current;
  const addIconRotation = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const activeIndex = tabs.findIndex(([name]) => name === navTab);
    if (activeIndex < 0 || slotWidth <= 0) return;
    Animated.spring(liquidX, { toValue: activeIndex * slotWidth, ...SPRING }).start();
  }, [navTab, slotWidth, liquidX]);

  useEffect(() => {
    tabs.forEach(([name]) => {
      tabFade[name].stopAnimation();
      Animated.timing(tabFade[name], { toValue: navTab === name ? 1 : 0, duration: 150, easing: EASE_OUT, useNativeDriver: true }).start();
    });
  }, [navTab, tabFade]);
  const [addPopupVisible, setAddPopupVisible] = useState(false);
  useEffect(() => {
    if (!sharedTransition || !rootRef.current) return;
    const easing = Easing.bezier(0.22, 1, 0.36, 1);
    const headerExit = Animated.stagger(35, [
      Animated.parallel([
        Animated.timing(editorBackOpacity, { toValue: 0, duration: 180, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
        Animated.timing(editorBackY, { toValue: -12, duration: 180, easing: Easing.in(Easing.cubic), useNativeDriver: true })
      ]),
      Animated.parallel([
        Animated.timing(editorTitleOpacity, { toValue: 0, duration: 180, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
        Animated.timing(editorTitleY, { toValue: -12, duration: 180, easing: Easing.in(Easing.cubic), useNativeDriver: true })
      ]),
      Animated.parallel([
        Animated.timing(editorApplyOpacity, { toValue: 0, duration: 180, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
        Animated.timing(editorApplyY, { toValue: -12, duration: 180, easing: Easing.in(Easing.cubic), useNativeDriver: true })
      ])
    ]);
    if (sharedTransition.closing) {
      const start = sharedTransition.start;
      Animated.parallel([
        Animated.timing(transitionX, { toValue: start.x, duration: 420, easing, useNativeDriver: false }),
        Animated.timing(transitionY, { toValue: start.y, duration: 420, easing, useNativeDriver: false }),
        Animated.timing(transitionW, { toValue: start.width, duration: 420, easing, useNativeDriver: false }),
        Animated.timing(transitionH, { toValue: start.height, duration: 420, easing, useNativeDriver: false }),
        Animated.timing(transitionRadius, { toValue: R.md, duration: 420, easing, useNativeDriver: false }),
        Animated.timing(transitionBorderWidth, { toValue: 0, duration: 420, easing, useNativeDriver: false }),
        headerExit,
        buildEditorToolsMotion(true),
        Animated.parallel([
          Animated.timing(transitionBgOpacity, { toValue: 0, duration: 300, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
          Animated.timing(transitionBgScale, { toValue: 1.04, duration: 300, easing, useNativeDriver: true })
        ])
      ]).start(({ finished }) => { editorToolsExitRunning.current = false; if (finished) setSharedTransition(null); });
      return;
    }
    if (tab !== "Editor" || !previewTargetRef.current) return;
    requestAnimationFrame(() => {
      previewTargetRef.current?.measureInWindow((targetX, targetY, targetW, targetH) => {
        rootRef.current?.measureInWindow((rootX, rootY) => {
          const target = { x: targetX - rootX, y: targetY - rootY, width: targetW, height: targetH };
          if (lastEditorTransition.current) lastEditorTransition.current.target = target;
          const headerEnter = Animated.stagger(55, [
            Animated.parallel([
              Animated.timing(editorBackOpacity, { toValue: 1, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
              Animated.timing(editorBackY, { toValue: 0, duration: 220, easing, useNativeDriver: true })
            ]),
            Animated.parallel([
              Animated.timing(editorTitleOpacity, { toValue: 1, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
              Animated.timing(editorTitleY, { toValue: 0, duration: 220, easing, useNativeDriver: true })
            ]),
            Animated.parallel([
              Animated.timing(editorApplyOpacity, { toValue: 1, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
              Animated.timing(editorApplyY, { toValue: 0, duration: 220, easing, useNativeDriver: true })
            ])
          ]);
          Animated.parallel([
            Animated.timing(transitionX, { toValue: target.x, duration: 420, easing, useNativeDriver: false }),
            Animated.timing(transitionY, { toValue: target.y, duration: 420, easing, useNativeDriver: false }),
            Animated.timing(transitionW, { toValue: target.width, duration: 420, easing, useNativeDriver: false }),
            Animated.timing(transitionH, { toValue: target.height, duration: 420, easing, useNativeDriver: false }),
            Animated.timing(transitionRadius, { toValue: R.md, duration: 420, easing, useNativeDriver: false }),
            Animated.timing(transitionBorderWidth, { toValue: 1, duration: 420, easing, useNativeDriver: false }),
            Animated.sequence([
              Animated.delay(150),
              Animated.parallel([
                headerEnter,
                buildEditorToolsMotion(false)
              ])
            ]),
            Animated.timing(transitionBgOpacity, { toValue: 1, duration: 300, easing: Easing.linear, useNativeDriver: true }),
            Animated.timing(transitionBgScale, { toValue: 1, duration: 300, easing, useNativeDriver: true })
          ]).start(({ finished }) => { if (finished) setSharedTransition(null); });
        });
      });
    });
  }, [tab, sharedTransition, transitionX, transitionY, transitionW, transitionH, transitionBgOpacity, transitionBgScale, transitionRadius, transitionBorderWidth, editorBackOpacity, editorBackY, editorTitleOpacity, editorTitleY, editorApplyOpacity, editorApplyY, buildEditorToolsMotion]);

  const [previousNavTab, setPreviousNavTab] = useState("Home");
  const [popupMounted, setPopupMounted] = useState(false);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const popupProgress = useRef(new Animated.Value(0)).current;
  const popupOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    addIconRotation.stopAnimation();
    Animated.timing(addIconRotation, {
      toValue: addPopupVisible ? 1 : 0,
      duration: 180,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true
    }).start();
  }, [addPopupVisible, addIconRotation]);

  useEffect(() => {
    // Opacity is independent from the elastic spring so its rebound cannot
    // briefly reveal a tiny, faded capsule at the end of closing.
    popupOpacity.stopAnimation();
    Animated.timing(popupOpacity, {
      toValue: addPopupVisible ? 1 : 0,
      duration: addPopupVisible ? 110 : 170,
      useNativeDriver: true
    }).start();

    popupProgress.stopAnimation();
    Animated.spring(popupProgress, {
      toValue: addPopupVisible ? 1 : 0,
      ...SPRING
    }).start(({ finished }) => {
      if (finished && !addPopupVisible) setPopupMounted(false);
    });
  }, [addPopupVisible, popupProgress, popupOpacity]);
  const [filter, setFilter] = useState("All");
  const [gridColumns, setGridColumns] = useState(2);
  const [userImages, setUserImages] = useState([]);
  const remoteWallpapers = useRemoteWallpapers();
  const [applying, setApplying] = useState(false);
  const [user, setUser] = useState(null); // { name, email } | null
  const [prefs, setPrefs] = useState({ ...SET_DEFAULTS });
  const setPref = useCallback((key, value) => setPrefs(p => ({ ...p, [key]: value })), []);
  useEffect(() => { hapticCfg.on = prefs.haptics !== false; }, [prefs.haptics]);
  const resetPrefs = useCallback(() => { setPrefs({ ...SET_DEFAULTS }); setGridColumns(2); }, []);
  const [savedMap, setSavedMap] = useState({});
  const userRef = useRef(null); userRef.current = user;
  const [upIds, setUpIds] = useState({});          // local/signed uri -> stable id of an uploaded image
  const imagesRef = useRef([]); imagesRef.current = userImages;
  const upIdsRef = useRef({}); upIdsRef.current = upIds;
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const savedRef = useRef({}); savedRef.current = savedMap;
  const synced = useRef(false);   // true once this user's cloud data has been loaded (prevents overwriting it with defaults)
  const toggleSave = useCallback((id) => {
    const next = !savedRef.current[id];
    setSavedMap(m => ({ ...m, [id]: next }));
    const u = userRef.current;
    if (u) syncSaved(u.id, id, next).catch(() => {});
  }, []);
  const signOut = useCallback(() => { supabase.auth.signOut().catch(() => {}); }, []);
  const updateProfile = useCallback((patch) => {
    setUser(u => (u ? { ...u, ...patch } : u));
    const u = userRef.current;
    if (u && patch.name) updateName(u.id, patch.name).catch(() => {});
  }, []);
  // Supabase session -> user, then pull their saved wallpapers + settings
  useEffect(() => {
    let dead = false;
    const apply = async (session) => {
      const u = session && session.user;
      if (!u) { synced.current = false; setUser(null); return; }
      setUser({ id: u.id, email: u.email, name: (u.user_metadata && u.user_metadata.name) || (u.email || "").split("@")[0] });
      try {
        const mine = Object.keys(savedRef.current).filter(k => savedRef.current[k] && k.indexOf("://") === -1 && k.charAt(0) !== "/");   // saves made before signing in (local file paths stay local)
        await pushSaved(u.id, mine);
        const d = await loadUserData(u.id);
        if (dead) return;
        if (d.name) setUser(x => (x ? { ...x, name: d.name } : x));
        if (d.prefs && Object.keys(d.prefs).length) setPrefs(p => ({ ...p, ...d.prefs }));
        if (d.gridColumns) setGridColumns(d.gridColumns);
        setSavedMap(m => ({ ...m, ...d.saved }));
        synced.current = true;
      } catch (e) { /* offline: keep working locally */ }
      try {   // wallpapers the user added: send local ones up, then show the account's images
        const failed = [];
        for (const uri of imagesRef.current.filter(x => !upIdsRef.current[x])) {
          try { await uploadImage(u.id, uri); } catch (e) { failed.push(uri); }
        }
        const cloud = await loadUploads(u.id);
        if (dead) return;
        const ids = {}; cloud.forEach(c => { ids[c.url] = "upload-" + c.id; });
        setUserImages([...failed, ...cloud.map(c => c.url)]);
        setUpIds(ids);
      } catch (e) { /* offline: keep working locally */ }
    };
    supabase.auth.getSession().then(({ data }) => { if (!dead) apply(data.session); });
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN") setTimeout(() => apply(session), 0);
      else if (event === "SIGNED_OUT") { synced.current = false; setUser(null); setSavedMap({}); setUserImages(prev => prev.filter(x => !upIdsRef.current[x])); setUpIds({}); }
    });
    return () => { dead = true; sub.subscription.unsubscribe(); };
  }, []);
  // "reset password" email link -> back into the app -> choose a new password
  useEffect(() => {
    const handle = async (url) => {
      if (!url || url.indexOf("reset-password") === -1) return;
      try { if (await sessionFromUrl(url)) setRecoveryOpen(true); }
      catch (e) { Alert.alert("Link expired", "This reset link is invalid or has expired. Please request a new one."); }
    };
    Linking.getInitialURL().then(handle).catch(() => {});
    const sub = Linking.addEventListener("url", ({ url }) => handle(url));
    return () => sub.remove();
  }, []);
  // settings -> cloud (debounced)
  const userId = user ? user.id : null;
  useEffect(() => {
    if (!userId || !synced.current) return undefined;
    const t = setTimeout(() => { saveSettings(userId, prefs, gridColumns).catch(() => {}); }, 800);
    return () => clearTimeout(t);
  }, [prefs, gridColumns, userId]);
  const handleEditorBack = () => {
    if (subRef.current) { closeSub(true); return; }
    if (sheetOpenRef.current) { closeSheet(); return; }
    if (editorToolsExitRunning.current) return;
    const last = lastEditorTransition.current;
    if (!last?.target) {
      animateEditorClock(true).start();
      setTab("Home");
      return;
    }
    editorToolsExitRunning.current = true;
    animateEditorClock(true).start();
    transitionX.setValue(last.target.x);
    transitionY.setValue(last.target.y);
    transitionW.setValue(last.target.width);
    transitionH.setValue(last.target.height);
    transitionRadius.setValue(R.md);
    transitionBorderWidth.setValue(1);
    editorBackOpacity.setValue(1);
    editorBackY.setValue(0);
    editorTitleOpacity.setValue(1);
    editorTitleY.setValue(0);
    editorApplyOpacity.setValue(1);
    editorApplyY.setValue(0);
    transitionBgOpacity.setValue(1);
    transitionBgScale.setValue(1);
    setSharedTransition({ uri: last.uri, start: last.start, closing: true });
    setTab("Home");
  };

  const [exitHintVisible, setExitHintVisible] = useState(false);
  const [exitHintMounted, setExitHintMounted] = useState(false);
  const exitBackTimeout = useRef(null);
  const exitHintProgress = useRef(new Animated.Value(0)).current;
  const exitHintOpacity = useRef(new Animated.Value(0)).current;
  const handleEditorBackRef = useRef(handleEditorBack);
  handleEditorBackRef.current = handleEditorBack;

  useEffect(() => {
    if (exitHintVisible) {
      setExitHintMounted(true);
      exitHintOpacity.stopAnimation();
      exitHintProgress.stopAnimation();
      exitHintOpacity.setValue(0);
      exitHintProgress.setValue(0);

      Animated.timing(exitHintOpacity, {
        toValue: 1,
        duration: 110,
        useNativeDriver: true
      }).start();

      Animated.spring(exitHintProgress, {
        toValue: 1,
        ...SPRING
      }).start();
      return;
    }

    exitHintOpacity.stopAnimation();
    Animated.timing(exitHintOpacity, {
      toValue: 0,
      duration: 170,
      useNativeDriver: true
    }).start();

    exitHintProgress.stopAnimation();
    Animated.spring(exitHintProgress, {
      toValue: 0,
      ...SPRING
    }).start(({ finished }) => {
      if (finished) setExitHintMounted(false);
    });
  }, [exitHintVisible, exitHintProgress, exitHintOpacity]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (tab === "Editor") {
        handleEditorBackRef.current();
        return true;
      }

      if (tab !== "Home" || navTab !== "Home") {
        setAddPopupVisible(false);
        setPopupMounted(false);
        if (tab !== "Home") beginScrollRestore("Home");
        setTab("Home");
        setNavTab("Home");
        setExitHintVisible(false);
        if (exitBackTimeout.current) {
          clearTimeout(exitBackTimeout.current);
          exitBackTimeout.current = null;
        }
        return true;
      }

      if (exitBackTimeout.current) {
        clearTimeout(exitBackTimeout.current);
        exitBackTimeout.current = null;
        setExitHintVisible(false);
        return false;
      }

      setExitHintVisible(true);
      exitBackTimeout.current = setTimeout(() => {
        exitBackTimeout.current = null;
        setExitHintVisible(false);
      }, 2000);
      return true;
    });
    return () => {
      subscription.remove();
      if (exitBackTimeout.current) {
        clearTimeout(exitBackTimeout.current);
        exitBackTimeout.current = null;
      }
    };
  }, [tab, navTab, beginScrollRestore]);

  const renderPage = (pageTab, pointerEvents = "auto") => {
    if (pageTab === "Editor") {
      const previewWidth = Math.max(160, Math.min(windowWidth - 44, 315, (windowHeight - 255) * 9 / 19.5));
      const previewHeight = previewWidth * 19.5 / 9;
      previewDims.w = previewWidth; previewDims.h = previewHeight; zoomNow.avail = windowWidth - 40;
      // Fit the preview into the space left above the sheet (scaled around its center, then moved to the middle of that space)
      const { pageH, stageY, stageH } = editorLayout;
      const fitTop = stageY + 8, fitBottom = pageH - SHEET_H - 14;
      const previewFit = pageH > 0 ? Math.max(0.4, Math.min(1, (fitBottom - fitTop) / previewHeight)) : 0.7;
      const previewShift = pageH > 0 ? (fitTop + fitBottom) / 2 - (stageY + stageH / 2) : 0;
      zoomNow.fit = previewFit;
      const previewScale = sheetProgress.interpolate({ inputRange: [0, 1], outputRange: [1, previewFit], extrapolate: "clamp" });
      const previewTranslateY = sheetProgress.interpolate({ inputRange: [0, 1], outputRange: [0, previewShift], extrapolate: "clamp" });
      const editorTools = [["Depth", "layers"], ["Adjust", "tune"], ["Clock", "schedule"], ["Parallax", "3d_rotation"], ["Effects", "auto_awesome"]];
      return (
        <View onLayout={e => { const h = e.nativeEvent.layout.height; setEditorLayout(l => l.pageH === h ? l : { ...l, pageH: h }); }} style={[s.editorPage, { backgroundColor: sharedTransition ? "transparent" : C.bg }]}>
          <View style={[s.editorHeader, sharedTransition && { opacity: 0 }]}>
            <Pressable accessibilityRole="button" accessibilityLabel="Back" hitSlop={12} onPress={handleEditorBack} style={[s.editorBack, ed.backBtn]}><AppIcon name="arrow_back" size={25} color={C.text} /></Pressable>
            <View style={[s.editorTitleWrap, ed.titleWrap]}>
              <Text style={s.editorTitleText}>Edit wallpaper</Text>
              <Text style={s.editorSubName} numberOfLines={1}>{selectedWallpaper.title}</Text>
            </View>
            <Press style={s.applyButton} onPress={async () => { if (applying) return; setApplying(true); const ok = await applyToPhone(selectedWallpaper.uri); setApplying(false); if (ok) Alert.alert("Wallpaper applied", "If Android asks, confirm Zharph as the live wallpaper."); }} dim={applying}><Text style={s.applyText}>{applying ? "Applying…" : "Apply"}</Text></Press>
            <DepthRunner />
          </View>
          <View onLayout={e => { const { y, height } = e.nativeEvent.layout; setEditorLayout(l => (l.stageY === y && l.stageH === height) ? l : { ...l, stageY: y, stageH: height }); }} {...zoomPan.panHandlers} style={s.previewStage}>
            <Animated.View ref={previewTargetRef} collapsable={false} style={[s.phonePreview, { width: previewWidth, height: previewHeight, backgroundColor: sharedTransition ? "transparent" : C.surface2, borderColor: sharedTransition ? "transparent" : C.outline, transform: [{ translateY: previewTranslateY }, { scale: previewScale }, { translateX: zoomView.tx }, { translateY: zoomView.ty }, { scale: zoomView.s }] }]}>
              <PreviewWallpaper uri={selectedWallpaper.uri} hidden={!!sharedTransition} />
              <EditorGlassFrame frameRef={previewTargetRef} w={previewWidth} h={previewHeight} uri={selectedWallpaper.uri}>
                <ClockLayer remote={selectedWallpaper.remote} W={previewWidth} H={previewHeight} k={previewWidth / 315} anim={{ opacity: clockOpacity, translateY: clockTranslateY, scale: clockScale }} />
              </EditorGlassFrame>
              <PreviewForeground w={selectedWallpaper.remote} uri={selectedWallpaper.uri} hidden={!!sharedTransition} />
            </Animated.View>
          </View>
          <Animated.View pointerEvents="none" style={{ opacity: toolsHeaderOpacity }}>
            <View style={s.editorToolsHeader}>
              <Animated.View style={{ opacity: editorToolsHeaderMotion[0].opacity, transform: [{ translateY: editorToolsHeaderMotion[0].translateY }] }}>
                <Text style={s.editorSectionTitle}>Tools</Text>
              </Animated.View>
            </View>
          </Animated.View>
          {/* keeps the layout space the tool cards occupy while closed (the cards themselves are absolutely positioned) */}
          <View style={{ height: TOOL_H }} />
          <View pointerEvents="box-none" style={s.sheetClip}>
            <Animated.View style={[s.sheet, { height: SHEET_H, bottom: 0, transform: [{ translateY: sheetY }] }]}>
              <View {...sheetPan.panHandlers} style={s.sheetHandleZone}>
                <View style={s.sheetHandle} />
              </View>
              {/* tab content (lazy-mounted, cross-fades natively) */}
              <View pointerEvents="box-none" style={{ position: "absolute", left: 0, right: 0, top: HANDLE_ZONE + TOOL_H_MIN + 12, bottom: 0 }}>
                {TOOL_NAMES.map((name, i) => (
                  <Animated.View key={name} pointerEvents={shownTool === name && !subPage ? "auto" : "none"} style={[StyleSheet.absoluteFill, { opacity: tabOpacity[i], transform: [{ translateY: tabAnim[i].interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }] }]}>
                    {visited[name] && (
                      name === "Depth" ? <DepthTab uri={selectedWallpaper.uri} /> :
                      name === "Adjust" ? <AdjustTab pw={previewWidth} ph={previewHeight} /> :
                      name === "Clock" ? <ClockTab uri={selectedWallpaper.uri} remote={selectedWallpaper.remote} onOpenDesign={openDesign} onOpenColor={openColor} /> :
                      name === "Parallax" ? (PARALLAX_COMING_SOON ? <ComingSoonTab title="Parallax" /> : <ParallaxTab />) :
                      <EffectsTab uri={selectedWallpaper.uri} />
                    )}
                  </Animated.View>
                ))}
              </View>
              {/* full-sheet sub page: everything except the handle is replaced */}
              {subPage && (
                <Animated.View style={{ position: "absolute", left: 0, right: 0, top: HANDLE_ZONE, bottom: 0, opacity: subAnim, transform: [{ translateY: subAnim.interpolate({ inputRange: [0, 1], outputRange: [18, 0] }) }] }}>
                  {subPage === "design" ? <DesignPage onBack={() => closeSub(false)} /> : <ColorPage key={histRev} onBack={() => closeSub(true)} onSave={() => closeSub(false)} />}
                </Animated.View>
              )}
            </Animated.View>
          </View>
          <Animated.View pointerEvents={subPage ? "none" : "box-none"} style={[s.editorTools, s.editorToolsFloating, { opacity: cardsHideOpacity, transform: [{ translateY: toolsTranslateY }] }]}>
            {editorTools.map(([name, icon], index) => {
              const active = activeEditorTool === name;
              const iconSize = name === "Depth" ? 28 : 26;
              const iconTop = (TOOL_H - (iconSize + 5 + LABEL_H)) / 2;
              const labelTop = iconTop + iconSize + 5;
              const labelFinalTop = (TOOL_H_MIN - LABEL_H) / 2 - LABEL_LIFT;
              const labelY = sheetProgress.interpolate({ inputRange: [0, 1], outputRange: [0, labelFinalTop - labelTop], extrapolate: "clamp" });
              const a = toolActiveAnim[index];
              const aInv = a.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
              const fill = StyleSheet.absoluteFillObject;
              const shapeProps = { capHeight: CARD_CAP, radius: Math.min(R.md, CARD_CAP), radiusOpen: R.sm, openOpacity: sheetProgress, topY: CARD_CAP - 1, midHeight: CARD_MID_H, midScale: cardMidScale, midY: cardMidY, bottomCapTop: TOOL_H - CARD_CAP, capY: cardCapY };
              const content = (iconColor, labelColor) => (
                <>
                  <Animated.View style={{ position: "absolute", left: 0, right: 0, top: iconTop, alignItems: "center", opacity: toolIconOpacity }}>
                    <View><AppIcon name={icon} size={iconSize} color={iconColor} active={iconColor === C.primary} />{(toolMask & TOOL_BITS[name]) ? <View style={ed.toolDot} /> : null}</View>
                  </Animated.View>
                  <Animated.View style={{ position: "absolute", left: 0, right: 0, top: labelTop, height: LABEL_H, alignItems: "center", justifyContent: "center", transform: [{ translateY: labelY }] }}>
                    <Text style={{ color: labelColor, fontSize: 11, fontFamily: F.bold, lineHeight: LABEL_H, includeFontPadding: false, textAlignVertical: "center" }}>{name}</Text>
                  </Animated.View>
                </>
              );
              return (
                <Animated.View key={name} pointerEvents="box-none" style={{ flex: 1, minWidth: 0, opacity: editorToolMotion[index].opacity, transform: [{ translateY: editorToolMotion[index].translateY }] }}>
                  <Animated.View pointerEvents="box-none" style={{ opacity: editorToolPressOpacity[index], transform: [{ scale: editorToolPressScale[index] }] }}>
                    <Pressable
                      accessibilityRole="button"
                      onPress={(e) => {
                        // while the sheet is open the card is shorter than its touch area: ignore taps below it
                        if (sheetOpenRef.current && (e?.nativeEvent?.locationY ?? 0) > TOOL_H_MIN) return;
                        if (sheetOpenRef.current && active) { closeSheet(); return; }
                        setActiveEditorTool(name);
                        setShownTool(name);
                        setVisited(v => v[name] ? v : { ...v, [name]: true });
                        if (!sheetOpenRef.current) openSheet();
                      }}
                      onPressIn={() => animateEditorToolPressIn(index)}
                      onPressOut={() => animateEditorToolPressOut(index)}
                      style={{ width: "100%", height: activeEditorTool ? TOOL_H_MIN : TOOL_H }}
                    >
                      <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: 0, height: TOOL_H }}>
                      <ToolCardShape bg={C.surface} border={C.outline} {...shapeProps} />
                      <Animated.View pointerEvents="none" style={[fill, { opacity: a }]}>
                        <ToolCardShape bg="#3F2721" border="#6A3A2D" {...shapeProps} />
                      </Animated.View>
                      <Animated.View pointerEvents="none" style={[fill, { opacity: aInv }]}>{content(C.text, C.muted)}</Animated.View>
                      <Animated.View pointerEvents="none" style={[fill, { opacity: a }]}>{content(C.primary, C.primary)}</Animated.View>
                      </View>
                    </Pressable>
                  </Animated.View>
                </Animated.View>
              );
            })}
          </Animated.View>
          <Animated.View pointerEvents="box-none" style={[s.editorFloatBar, { bottom: TOOLS_BOTTOM + TOOL_H + 8, transform: [{ translateY: sheetProgress.interpolate({ inputRange: [0, 1], outputRange: [0, -(SHEET_H + 10 - (TOOLS_BOTTOM + TOOL_H + 8))], extrapolate: "clamp" }) }] }]}>
            <Animated.View pointerEvents={activeEditorTool ? "auto" : "none"} style={{ opacity: sheetProgress.interpolate({ inputRange: [0.5, 1], outputRange: [0, 1], extrapolate: "clamp" }) }}>
              <Pressable accessibilityRole="button" accessibilityLabel={zoomOn ? "Zoom out" : "Zoom to clock"} accessibilityState={{ selected: zoomOn }} onPress={toggleZoom} style={[ed.pill, ed.pillSolo, zoomOn && ed.pillOn]}>
                <AppIcon name={zoomOn ? "collapse_diag" : "expand_diag"} size={22} color={zoomOn ? C.primary : C.text} active={zoomOn} />
              </Pressable>
            </Animated.View>
            <HistoryButtons />
          </Animated.View>
        </View>
      );
    }
    const isGrid = pageTab === "Home" || pageTab === "Wallpapers" || pageTab === "Add";
    return (
    <Animated.ScrollView ref={homeScrollRef} pointerEvents={pointerEvents} nestedScrollEnabled showsVerticalScrollIndicator={false} scrollEventThrottle={16} onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: true, listener: handlePageScroll })} contentContainerStyle={[s.scroll, { paddingBottom: NAV_H + 16 }]} style={{ width: stageSize.width || "100%", height: stageSize.height || "100%" }}>
      <View style={s.header}>
        <Text style={s.brand}>Zharph<Text style={{color:C.primary}}>.</Text></Text>
        {isGrid && <Animated.View style={{ opacity: layoutHeaderOpacity }}>
          <Pressable accessibilityRole="button" accessibilityLabel={gridColumns === 2 ? "Switch to three-column grid" : "Switch to two-column grid"} onPress={() => setGridColumns(columns => columns === 2 ? 3 : 2)} style={s.layoutButton}>
            <AppIcon name={gridColumns === 2 ? "grid_view" : "view_module"} size={26} color={C.text} />
          </Pressable>
        </Animated.View>}
      </View>
      {isGrid && <View pointerEvents="none" onLayout={e => setTopBarRestY(Math.max(1, e.nativeEvent.layout.y))} style={s.topBarSpacer} />}
      {isGrid ? (() => {
        // Same cards, same handlers as before; every card has the same 9:16 ratio and equal width, dealt into columns left-to-right.
        const defs = [
          ...userImages.map((uri, index) => ({ key: `user-${index}-${uri}`, wp: { title: "My wallpaper", uri }, thumb: uri, overlayId: upIds[uri] || uri, title: "My wallpaper", parallax: false })),
          ...remoteWallpapers.map(w => ({ key: `remote-${w.id}`, wp: { title: w.title, uri: w.uri, remote: w }, thumb: w.thumb, overlayId: `remote-${w.id}`, title: w.title, parallax: w.type === "parallax" })),
          ...items.map(([title, uri]) => ({ key: title, wp: { title, uri }, thumb: thumbUrl(uri), overlayId: title, title, parallax: PARALLAX_SAMPLE.has(title) }))
        ];
        const cols = Array.from({ length: gridColumns }, () => ({ h: 0, list: [] }));
        defs.forEach((d, i) => {
          cols[i % gridColumns].list.push({ d, ratio: CARD_RATIO });
        });
        return (
          <View style={s.masonry}>
            {cols.map((col, ci) => (
              <View key={ci} style={s.masonryCol}>
                {col.list.map(({ d }) => (
                  <GridCard key={d.key} d={d} onOpen={onOpenCard} onSave={toggleSave} saved={!!savedMap[d.overlayId]} compact={gridColumns === 3} />
                ))}
              </View>
            ))}
          </View>
        );
      })() : pageTab === "Settings" ? <SettingsPage user={user} onSignIn={setUser} onSignOut={signOut} onUpdateProfile={updateProfile} prefs={prefs} setPref={setPref} resetPrefs={resetPrefs} gridColumns={gridColumns} setGridColumns={setGridColumns} uploads={userImages.length} saved={Object.values(savedMap).filter(Boolean).length} onOpenSaved={() => { beginScrollRestore("Saved"); setTab("Saved"); setNavTab("Saved"); }} />
      : <View style={s.placeholder}><View style={[s.bigIcon, { borderWidth: 1, borderColor: C.hair }]}><AppIcon name="bookmark" size={34} color={C.muted}/></View><Text style={s.title}>Saved</Text><Text style={s.placeholderText}>Your saved wallpapers will appear here.</Text></View>}
    </Animated.ScrollView>
    );
  };
  const closeAddPopup = () => {
    setAddPopupVisible(false);
    setNavTab(previousNavTab);
  };
  const addPhoto = async () => {
    closeAddPopup();
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsEditing: false, quality: 1 });
    if (!result.canceled && result.assets?.[0]?.uri) {
      const uri = result.assets[0].uri;
      setUserImages(prev => [uri, ...prev]);
      const u = userRef.current;
      if (u) uploadImage(u.id, uri).then(r => setUpIds(m => ({ ...m, [uri]: "upload-" + r.id }))).catch(() => {});
    }
  };
  const topBarShown = (tab === "Home" || tab === "Wallpapers" || tab === "Add") && !sharedTransition;
  useEffect(() => {
    Animated.timing(topBarOpacity, { toValue: topBarShown ? 1 : 0, duration: topBarShown ? 180 : 120, easing: EASE_OUT, useNativeDriver: true }).start();
  }, [topBarShown, topBarOpacity]);
  if (!fontsLoaded) return null;

  return (
    <View style={s.safe}>
    <BlurWrap ref={blurTargetRef} style={{ flex: 1 }}>
    <SafeAreaView style={s.safe} edges={["top", "left", "right", "bottom"]}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      <View ref={rootRef} collapsable={false} style={s.root} onLayout={e => setStageTop(e.nativeEvent.layout.y)}>
        <View style={{ flex: 1, backgroundColor: C.bg }}>
          <View style={{flex:1, overflow:"hidden", backgroundColor:C.bg}}>
            {renderPage(sharedTransition ? "Home" : tab)}
          </View>
        </View>
        {sharedTransition && <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <Animated.View style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, backgroundColor: C.bg, opacity: transitionBgOpacity, transform: [{ scale: transitionBgScale }] }} />
          <Animated.View style={{ position: "absolute", left: transitionX, top: transitionY, width: transitionW, height: transitionH, borderRadius: transitionRadius, borderWidth: transitionBorderWidth, borderColor: C.outline, overflow: "hidden", backgroundColor: C.surface2 }}>
            <Image source={{ uri: sharedTransition.uri }} style={{ width: "100%", height: "100%" }} resizeMode="cover" />
          </Animated.View>
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>{renderPage("Editor")}</View>
          <View style={{ position: "absolute", left: 20, right: 20, top: 8, height: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Animated.View style={{ width: 42, height: 42, alignItems: "flex-start", justifyContent: "center", opacity: editorBackOpacity, transform: [{ translateY: editorBackY }] }}><AppIcon name="arrow_back" size={25} color={C.text} /></Animated.View>
            <Animated.View style={{ flex: 1, marginLeft: 4, justifyContent: "center", transform: [{ translateY: Animated.add(editorTitleY, -2) }], opacity: editorTitleOpacity }}><Text style={s.editorTitleText}>Edit wallpaper</Text><Text style={s.editorSubName} numberOfLines={1}>{selectedWallpaper.title}</Text></Animated.View>
            <Animated.View style={{ paddingHorizontal: 17, paddingVertical: 10, borderRadius: R.sm, backgroundColor: C.primary, opacity: editorApplyOpacity, transform: [{ translateY: editorApplyY }] }}><Text style={{ color: C.onPrimary, fontSize: 13, fontFamily: F.bold, transform: [{ translateY: -2 }] }}>Apply</Text></Animated.View>
          </View>
        </View>}
        {exitHintMounted && tab === "Home" && navTab === "Home" && !addPopupVisible && <Animated.View pointerEvents="none" style={[s.exitHint, { opacity: exitHintOpacity, transform: [{ translateY: exitHintProgress.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }, { scaleX: exitHintProgress.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) }, { scaleY: exitHintProgress.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) }] }]}><Text style={s.exitHintText}>Press back again to exit</Text></Animated.View>}
        {popupMounted && tab !== "Editor" && <>
          <Animated.View pointerEvents={addPopupVisible ? "auto" : "none"} style={[s.popupDismiss, {
            opacity: popupOpacity
          }]}>
            <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0,0,0,0.42)" }]} />
            <Pressable style={StyleSheet.absoluteFill} onPress={closeAddPopup} />
          </Animated.View>
          <Animated.View pointerEvents={addPopupVisible ? "auto" : "none"} style={[s.addPopup, {
            opacity: popupOpacity,
            transform: [
              { translateY: popupProgress.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) },
              { scaleX: popupProgress.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) },
              { scaleY: popupProgress.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) }
            ]
          }]}>
            <Pressable onPress={addPhoto} style={s.addPopupAction}><Text style={s.addPopupText}>Open Gallery</Text></Pressable>
          </Animated.View>
        </>}
      </View>
    </SafeAreaView>
    </BlurWrap>
    <Animated.View pointerEvents={topBarShown && !addPopupVisible ? "auto" : "none"} style={[s.topBar, { top: stageTop, opacity: topBarOpacity, transform: [{ translateY: scrollY.interpolate({ inputRange: [0, topBarRestY], outputRange: [topBarRestY, 0], extrapolateLeft: "extend", extrapolateRight: "clamp" }) }] }]}>
      {BLUR_OK
        ? <BlurViewC pointerEvents="none" intensity={50} tint="dark" experimentalBlurMethod="dimezisBlurView" blurTarget={BlurTargetC && Platform.OS === "android" ? blurTargetRef : undefined} style={StyleSheet.absoluteFill} />
        : null}
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: NAV_TINT }]} />
      <Animated.View pointerEvents="none" style={[s.topBarHairline, { opacity: scrollY.interpolate({ inputRange: [topBarRestY - 10, topBarRestY], outputRange: [0, 1], extrapolate: "clamp" }) }]} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.topBarChips} contentContainerStyle={s.filters} scrollEventThrottle={16}
        onLayout={e => { filterMetrics.current.w = e.nativeEvent.layout.width; updateFilterEdges(); }}
        onContentSizeChange={w => { filterMetrics.current.cw = w; updateFilterEdges(); }}
        onScroll={e => { filterMetrics.current.x = e.nativeEvent.contentOffset.x; updateFilterEdges(); }}>
        {["All","Depth","Parallax","Minimal","Test"].map(x => <Pressable key={x} onPress={() => setFilter(x)} style={[s.filter, filter === x && s.filterOn]}><Text style={[s.filterText, filter === x && { color: C.primary, fontFamily: F.bold }]}>{x}</Text></Pressable>)}
      </ScrollView>
      <Animated.View pointerEvents="none" style={[s.topBarFadeLeft, { opacity: filterFadeOpacity }]}>
        <View style={{ width: 6, height: "100%" }}><Svg width="100%" height="100%" viewBox="0 0 6 60" preserveAspectRatio="none"><Defs><LinearGradient id="topFadeL2" x1="0" y1="0" x2="1" y2="0"><Stop offset="0" stopColor="#100E0E" stopOpacity="0" /><Stop offset="1" stopColor="#100E0E" stopOpacity="0.9" /></LinearGradient></Defs><Rect x="0" y="0" width="6" height="60" fill="url(#topFadeL2)" /></Svg></View>
        <View style={{ width: 24, height: "100%" }}><Svg width="100%" height="100%" viewBox="0 0 24 60" preserveAspectRatio="none"><Defs><LinearGradient id="topFadeL" x1="0" y1="0" x2="1" y2="0"><Stop offset="0" stopColor="#100E0E" stopOpacity="0.9" /><Stop offset="1" stopColor="#100E0E" stopOpacity="0" /></LinearGradient></Defs><Rect x="0" y="0" width="24" height="60" fill="url(#topFadeL)" /></Svg></View>
      </Animated.View>
      <Animated.View pointerEvents="none" style={[s.topBarFadeRight, { opacity: filterEndFadeOpacity }]}>
        <View style={{ width: 24, height: "100%" }}><Svg width="100%" height="100%" viewBox="0 0 24 60" preserveAspectRatio="none"><Defs><LinearGradient id="topFadeR" x1="0" y1="0" x2="1" y2="0"><Stop offset="0" stopColor="#100E0E" stopOpacity="0" /><Stop offset="1" stopColor="#100E0E" stopOpacity="0.9" /></LinearGradient></Defs><Rect x="0" y="0" width="24" height="60" fill="url(#topFadeR)" /></Svg></View>
        <View style={{ width: 6, height: "100%" }}><Svg width="100%" height="100%" viewBox="0 0 6 60" preserveAspectRatio="none"><Defs><LinearGradient id="topFadeR2" x1="0" y1="0" x2="1" y2="0"><Stop offset="0" stopColor="#100E0E" stopOpacity="0.9" /><Stop offset="1" stopColor="#100E0E" stopOpacity="0" /></LinearGradient></Defs><Rect x="0" y="0" width="6" height="60" fill="url(#topFadeR2)" /></Svg></View>
      </Animated.View>
      <View pointerEvents="none" style={s.topBarIcon}><AppIcon name="tune" size={26} color={C.text} /></View>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0,0,0,0.42)", opacity: popupOpacity }]} />
    </Animated.View>
    <Animated.View pointerEvents={tab === "Editor" ? "none" : "auto"} style={[s.bar, { transform: [{ translateY: navTranslateY }] }]} onLayout={event => setBarWidth(event.nativeEvent.layout.width)}>
      {BLUR_OK
        ? <BlurViewC pointerEvents="none" intensity={50} tint="dark" experimentalBlurMethod="dimezisBlurView" blurTarget={BlurTargetC && Platform.OS === "android" ? blurTargetRef : undefined} style={StyleSheet.absoluteFill} />
        : null}
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: NAV_TINT }]} />
      <View pointerEvents="none" style={s.barHairline} />
      <SafeAreaView edges={["bottom"]}>
        <View style={s.tabsRow}>
          <Animated.View pointerEvents="none" style={[s.tabPill, { left: indicatorLeft, opacity: slotWidth > 0 ? 1 : 0, transform: [{ translateX: liquidX }] }]} />
          {tabs.map(([name, iconName, label]) => {
            return <Pressable key={name} onPress={() => {
          if (name === "Add") {
            if (addPopupVisible) {
              closeAddPopup();
            } else {
              setPreviousNavTab(navTab);
              setNavTab("Add");
              setPopupMounted(true);
              setAddPopupVisible(true);
            }
          } else {
            setAddPopupVisible(false);
            if (name !== tab) beginScrollRestore(name);
            setTab(name);
            setNavTab(name);
          }
            }} style={s.tab}>
              <View style={s.tabIcon}>
                <Animated.View style={[StyleSheet.absoluteFill, s.tabIconLayer, { opacity: tabFade[name].interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }]}><AppIcon name={iconName} size={24} color={C.muted} /></Animated.View>
                <Animated.View style={[StyleSheet.absoluteFill, s.tabIconLayer, { opacity: tabFade[name] }]}><AppIcon name={iconName} size={24} color={C.primary} active /></Animated.View>
              </View>
              <View style={s.tabLabelBox}>
                <Animated.Text numberOfLines={1} style={[s.tabLabel, { color: C.muted, opacity: tabFade[name].interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }]}>{label}</Animated.Text>
                <Animated.Text numberOfLines={1} style={[s.tabLabel, s.tabLabelOn, { color: C.primary, opacity: tabFade[name] }]}>{label}</Animated.Text>
              </View>
            </Pressable>;
          })}
        </View>
      </SafeAreaView>
    </Animated.View>
    <NewPasswordSheet visible={recoveryOpen} onClose={() => setRecoveryOpen(false)} />
    </View>
  );
}
const s=StyleSheet.create({
 wall:{width:"100%"},masonry:{flexDirection:"row",gap:8,alignItems:"flex-start"},masonryCol:{flex:1,gap:8},
 editorTitleWrap: {flex:1,marginLeft:4,justifyContent:"center",transform:[{translateY:-2}]},editorTitleText: { fontFamily: F.display,color:C.text,fontSize:19,},editorSubName: { fontFamily: F.body,color:C.muted,fontSize:12,marginTop:1},
 editorFloatBar: {position:"absolute",left:20,right:20,height:40,flexDirection:"row",alignItems:"center",justifyContent:"space-between",gap:8,zIndex:4},
 safe: {flex:1,backgroundColor:C.bg},root: {flex:1,backgroundColor:C.bg},scroll: {paddingHorizontal:layout.pageX,paddingTop:8,paddingBottom:16},
 header: {flexDirection:"row",alignItems:"center",justifyContent:"space-between",marginBottom:20},brand: { fontFamily: F.displayXL,color:C.text,fontSize:30,letterSpacing:-1.2,transform:[{translateY:-5}]},layoutButton: {width:42,height:42,alignItems:"center",justifyContent:"center",backgroundColor:"transparent",borderWidth:0,borderColor:"transparent",transform:[{translateX:11},{translateY:-1}]},
 title: { fontFamily: F.display,color:C.text,fontSize:21,letterSpacing:-.4},
 topBarSpacer: {height:TOPBAR_H,marginTop:-24},
 topBar: {position:"absolute",left:0,right:0,height:TOPBAR_H,zIndex:4,overflow:"hidden"},topBarHairline: {position:"absolute",left:0,right:0,bottom:0,height:1,backgroundColor:"rgba(255,255,255,0.10)"},
 topBarChips: {position:"absolute",left:layout.pageX,top:0,bottom:0,right:TOPBAR_ICON_R+26+8},topBarFadeLeft: {position:"absolute",left:layout.pageX-6,top:0,bottom:0,width:30,flexDirection:"row"},topBarFadeRight: {position:"absolute",right:TOPBAR_ICON_R+26+8-6,top:0,bottom:0,width:30,flexDirection:"row"},topBarIcon: {position:"absolute",right:TOPBAR_ICON_R,top:(TOPBAR_H-26)/2,width:26,height:26},
 filters: {gap:8,alignItems:"center",paddingLeft:0,paddingRight:8},filter: {borderRadius:R.sm,paddingHorizontal:17,paddingVertical:9,backgroundColor:"rgba(242,235,231,0.06)",borderWidth:1,borderColor:C.hair},filterOn: {backgroundColor:C.primarySoft,borderColor:"rgba(255,122,89,0.35)"},filterText: { fontFamily: F.semi,color:C.muted,fontSize:12,},
 photo: {width:"100%",aspectRatio:9/16,borderRadius:R.md,backgroundColor:C.surface2},
editorPage: {flex:1,backgroundColor:"transparent",paddingHorizontal:20,paddingTop:8,paddingBottom:12},editorHeader: {height:48,flexDirection:"row",alignItems:"center",justifyContent:"space-between",marginBottom:4},editorBack: {width:42,height:48,alignItems:"flex-start",justifyContent:"center"},applyButton: {paddingHorizontal:17,paddingVertical:10,borderRadius:R.sm,backgroundColor:C.primary},applyText: { fontFamily: F.bold,color:C.onPrimary,fontSize:13,transform:[{translateY:-2}]},previewStage: {overflow:"hidden",flex:1,minHeight:0,alignItems:"center",justifyContent:"center",paddingVertical:8},phonePreview: {borderRadius:R.md,overflow:"hidden",backgroundColor:C.surface2,borderWidth:1,borderColor:C.outline,elevation:0,shadowOpacity:0,shadowRadius:0,shadowOffset:{width:0,height:0}},editorToolsHeader: {flexDirection:"row",alignItems:"center",justifyContent:"space-between",marginTop:8,marginBottom:12},editorSectionTitle: { fontFamily: F.display,color:C.text,fontSize:17,},editorTools: {flexDirection:"row",justifyContent:"space-between",gap:6},editorToolsFloating: {position:"absolute",left:20,right:20,bottom:12,height:68,zIndex:2},sheetClip: {...StyleSheet.absoluteFillObject,overflow:"hidden",zIndex:1},sheet: {position:"absolute",left:0,right:0,backgroundColor:C.surface2,borderTopLeftRadius:R.lg,borderTopRightRadius:R.lg,borderTopWidth:1,borderLeftWidth:1,borderRightWidth:1,borderColor:C.hair},sheetHandleZone: {height:28,alignItems:"center",paddingTop:10},sheetHandle: {width:36,height:4,borderRadius:2,backgroundColor:C.muted,opacity:0.5},popupDismiss: {...StyleSheet.absoluteFillObject,zIndex:3,overflow:"hidden"},addPopup: {position:"absolute",alignSelf:"center",bottom:NAV_H+12,zIndex:5,alignItems:"center",justifyContent:"center",backgroundColor:C.surface3,borderWidth:1,borderColor:C.hair,borderRadius:R.md,paddingHorizontal:20,paddingVertical:14,elevation:8,shadowColor:"#000",shadowOpacity:0.25,shadowRadius:12,shadowOffset:{width:0,height:5}},addPopupAction: {justifyContent:"center",alignItems:"center"},addPopupText: { fontFamily: F.display,color:C.text,fontSize:14,},exitHint: {position:"absolute",alignSelf:"center",bottom:NAV_H+14,zIndex:6,backgroundColor:C.surface2,borderRadius:R.sm,paddingHorizontal:18,paddingVertical:12,borderWidth:1,borderColor:C.hair,elevation:6},exitHintText: { fontFamily: F.bold,color:C.text,fontSize:13,},bar: {position:"absolute",left:0,right:0,bottom:0,zIndex:4,overflow:"hidden"},barHairline: {position:"absolute",left:0,right:0,top:0,height:1,backgroundColor:"rgba(255,255,255,0.10)"},tabsRow: {flexDirection:"row",height:NAV_H},tab: {flex:1,alignItems:"center",justifyContent:"center",paddingTop:4},tabPill: {position:"absolute",top:NAV_PILL_TOP,width:NAV_PILL_W,height:NAV_PILL_H,borderRadius:8,backgroundColor:C.primarySoft},tabIcon: {width:NAV_PILL_W,height:NAV_PILL_H},tabIconLayer: {alignItems:"center",justifyContent:"center"},tabLabelBox: {marginTop:5,alignItems:"center",justifyContent:"center"},tabLabel: {fontFamily:F.semi,fontSize:12,lineHeight:14,includeFontPadding:false},tabLabelOn: {position:"absolute",left:0,right:0,textAlign:"center"},
 placeholder: {minHeight:420,alignItems:"center",justifyContent:"center",paddingHorizontal:24},bigIcon: {width:76,height:76,borderRadius:R.md,backgroundColor:C.surface2,alignItems:"center",justifyContent:"center",marginBottom:20},placeholderText: { fontFamily: F.body,color:C.muted,fontSize:14,textAlign:"center",lineHeight:21,marginTop:10},primaryButton: {marginTop:24,backgroundColor:C.primary,paddingHorizontal:22,paddingVertical:12,borderRadius:R.sm},primaryText: {fontFamily:F.bold,color:C.onPrimary},
 cardOverlay: {position:"absolute",left:0,right:0,bottom:0,height:56,borderBottomLeftRadius:R.md,borderBottomRightRadius:R.md,overflow:"hidden",justifyContent:"flex-end"},cardStats: {flexDirection:"row",alignItems:"center",gap:10,paddingHorizontal:12,paddingBottom:10},cardTitle: { fontFamily: F.bold,flex:1,color:"#FFFFFF",fontSize:13,textShadowColor:"rgba(0,0,0,0.45)",textShadowRadius:3,textShadowOffset:{width:0,height:1}},parallaxBadge: {position:"absolute",top:8,right:8,width:30,height:30,borderRadius:R.xs,alignItems:"center",justifyContent:"center"}
});
