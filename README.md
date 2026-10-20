# Ryder Mail Van

Browser 3D playground for an electric mail delivery van: free driving, an animated walkthrough, the "Morning route" short film showcasing the SCADpro × Oshkosh driver-display alerts and chimes, and an open-world interstate.

- Site files live at the repo root (static, no build step): `index.html`, `app.bundle.js`, `styles.css`, `assets/`.
- Source modules are in `source/` (bundle with esbuild: `npx esbuild app.js --bundle --format=esm --minify --outfile=app.bundle.js`).
