# Zharph UI

An isolated Expo SDK 55 UI prototype for the Zharph wallpaper app. This repository intentionally contains presentation code and mock interactions only. It does not contain the production depth-processing pipeline or Android native wallpaper module.

## Screens

- Home: wallpaper discovery grid, filters, and gallery picker
- Depth: photo selection and wallpaper style choice
- Editor: draggable clock preview and mock layer-order controls
- Saved: sample saved wallpapers
- Settings: appearance and experience controls

## Run

Install dependencies with `npm install`, then start Expo with `npx expo start`.

The UI is kept separate so it can later be selectively integrated into the production Zharph project without overwriting native modules or depth-processing logic.