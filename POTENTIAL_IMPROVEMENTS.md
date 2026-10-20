# Map Race — Potential Improvements

A prioritized backlog with implementation notes. Each item names the file/function
to touch so it can be picked up without re-exploring the codebase.

Legend: **P0** = quick, high impact · **P1** = worthwhile next · **P2** = larger bet.

---

## Quick wins (P0)

- [ ] **Camera collision.** When a building sits between the car and the chase
      camera, pull the camera in. `updateCamera()` already computes the camera
      point; clamp it with a 2D segment-vs-footprint test against the current
      chunk's `footprints` (or a shared per-chunk AABB list). Keep a minimum
      distance (~2 m).
- [ ] **Speed-based FOV + vertical damping.** In `loop()`/`updateCamera()`,
      lerp `camera.fov` from ~60 to ~72 with speed and call
      `camera.updateProjectionMatrix()`. Smooth `camY` with the same
      exponential helper used for `camHeading` to stop terrain jitter.
- [ ] **Loading progress.** `state.wanted`/`state.chunks` already expose
      counts. Add a `built / total` line to `#d3-loading` and update it in the
      `!state.ready` branch of `loop()`.
- [ ] **URL permalink.** On entering free roam, write
      `#drive?lon=..&lat=..`; on load, parse it and prefill
      `game.freeRoam`. Add a "Share" button that copies the URL.
- [ ] **Respect reduced motion.** In `initDrive3D()`, if
      `matchMedia("(prefers-reduced-motion: reduce)").matches`, set
      `CAM_LAG = 0` and skip camera shake/suspension effects.
- [ ] **Retry with backoff** for tiles, DEM, OSRM and Photon. Wrap the three
      fetch sites (`fetchTileBuffer`, `loadDem`, route/search calls) in a
      small `fetchWithRetry(url, { tries: 3, baseDelay: 500 })` helper and
      surface a toast on final failure.

## Rendering & visuals (P1)

- [ ] **Sky, fog and time of day.** `scene.background` is a flat colour. Use a
      vertical gradient (canvas texture on a large sphere or
      `scene.background`) and `scene.fog = new THREE.Fog(color, 900, 2200)`.
      Tie `HemisphereLight`/`DirectionalLight` colours to a `timeOfDay` value.
- [ ] **Terrain shading.** `baseMaterial` is `MeshBasicMaterial`, so hills are
      flat. Switch the base quad to `MeshLambertMaterial` with vertex colours
      computed from slope/aspect (cheap hillshade), or precompute a
      slope-based colour ramp in `addBaseQuad()`.
- [ ] **Shadows.** Enable `renderer.shadowMap`, give the directional light a
      shadow camera that follows the car, and set `castShadow` on the car and
      buildings (buildings are merged meshes, so this stays cheap).
- [ ] **Animated water.** Keep the flat sheet but add a cheap normal/ripple
      shader via `onBeforeCompile` on the water material, or animate a UV
      offset on a tiled texture.
- [ ] **Trees for `landcover` wood/scrub.** Spawn low-poly instanced
      cross-quads or cones inside those polygons, hashed per polygon so they
      stream in deterministically. Use `THREE.InstancedMesh` per chunk.
- [ ] **Road markings.** For `transportation` classes `motorway`/`trunk`/
      `primary`, emit a dashed centre ribbon slightly above `ROAD_Y`; reuse
      `pushRibbon()` with a small dashed pattern.
- [ ] **Building detail.** Add roof colour variation and simple window bands
      (vertex colours or a procedural texture) in `addBuildingsFromTile()`.
- [ ] **Tone mapping / AA.** Set `renderer.toneMapping = ACESFilmicToneMapping`
      and cap `renderer.setPixelRatio(Math.min(devicePixelRatio, 2))`.

## Vehicle & driving feel (P1)

- [ ] **Body roll and pitch.** Tilt `carGroup` around Z by lateral acceleration
      and around X by throttle/brake, blended back to level. Compute from
      `car.speed` and the heading delta in `update()`.
- [ ] **Brake/reverse lights.** Keep references to the tail-light meshes in
      `buildCarMesh()` (tag with `userData.light`) and toggle their material
      colour when braking/reversing.
- [ ] **Skid marks and dust.** When `abs(state.steer) > 0.7` and speed is high,
      drop short dark quads on the ground behind the rear wheels (ring buffer,
      fade out). Off-road, emit dust sprites from the wheel positions.
- [ ] **Audio.** Procedural engine (oscillator + filter driven by speed) and
      tyre/water noise with WebAudio; gate behind a user gesture and a mute
      setting.
- [ ] **Suspension bob.** Offset the car body group by a small sine based on
      speed and terrain roughness (sample `terrainY` at the wheels).
- [ ] **Slope alignment.** Pitch the car to the terrain normal (sample
      `terrainY` fore/aft and left/right of the car).
- [ ] **Handbrake/drift.** Add a brake+steer modifier that lowers lateral grip
      and increases yaw rate.

## Streaming & performance (P1)

- [ ] **Tile decode in a Web Worker.** Move `new VectorTile(new Pbf(buffer))`
      plus polygon triangulation into a worker (ESM worker can import
      `@mapbox/vector-tile`/`pbf`); post back transferable typed arrays. This
      removes the `pumpBuild` hitches.
- [ ] **Velocity-aware streaming.** In `updateChunks()`, offset `chunkCenter`
      along the heading by `speed * lookAhead` so tiles arrive before you need
      them; raise `CHUNK_RADIUS` at high speed.
- [ ] **Cancel stale loads.** Use `AbortController` for `fetchTileBuffer` and
      drop responses whose chunk was already unloaded. DEM `Image` loads can't
      be aborted, so clear handlers and ignore late results.
- [ ] **Chunk culling.** Give each chunk group a bounding sphere and skip
      traversing/updating chunks whose projected bounds are off-screen; keep
      the streaming logic independent of visibility.
- [ ] **Cache tuning.** `tileBufferCache` and `demTiles` (LRU 64) are magic
      numbers. Expose sizes, measure memory, and preload the 3×3 DEM ring on
      entry.
- [ ] **Progressive world.** Instead of a full-screen gate, reveal the world
      once the centre chunk is built and let the rest stream (keep the overlay
      only for the first frame or two).

## Terrain & data correctness (P1)

- [ ] **Robust water level.** Sample several interior points (centroid + ring
      offsets) and take the median, clamped to nearby terrain, so a shoreline
      centroid or a nodata DEM pixel can't float/sink a lake.
- [ ] **Bridge decks and tunnels.** Use `brunnel === "bridge"` and
      `layer >= 1` to lift the road ribbon by a deck height, and keep skipping
      tunnels (`layer < 0`). Render bridge side rails so decks read as raised.
- [ ] **DEM nodata handling.** Terrarium tiles occasionally decode to extreme
      values; detect `-32768`/absurd heights and fall back to the nearest valid
      neighbour before draping.
- [ ] **Style parity pass.** Diff our `groundAreaRank()` and colours against the
      Liberty style's fill layers (`landuse`, `landcover`, `park`, `water`,
      `landcover_sand`) and add missing classes such as `landuse=forest`,
      `natural=wood`, `leisure=playground`.
- [ ] **Route on bridges.** When a route crosses a lifted bridge, sample the
      road layer's lift for the route ribbon instead of `ROUTE_Y`.

## UX / product (P2)

- [ ] **Pause & settings screen.** Camera lag, FOV, graphics quality, controls,
      units, and motion sensitivity in one panel (persist to `localStorage`).
- [ ] **Route stats.** Distance, duration, elevation profile and OSRM
      alternatives in the free-draw panel; reuse `state.cum`.
- [ ] **Recent places & favourites.** Cache Photon results and chosen starts in
      `localStorage`; show them when the search box is focused.
- [ ] **Gameplay layer.** Checkpoint gates, lap timer, best-time ghost
      (record `[t, lon, lat, heading]`), and a local leaderboard.
- [ ] **AI traffic.** Spawn simple cars that follow `transportation` lane
      graph edges; despawn outside `CHUNK_RADIUS`.
- [ ] **Multiplayer.** Start with a small WebSocket room broadcasting
      `{id, lon, lat, heading, speed}` at 10 Hz; interpolate remote cars and
      keep the local sim authoritative.
- [ ] **PWA / offline.** Add a manifest + service worker caching the app shell
      and the last N tiles; show an offline banner and retry when back online.

## Accessibility & mobile (P1)

- [ ] **Reduced-motion + sensitivity settings.** Expose camera lag and shake;
      disable both under `prefers-reduced-motion`.
- [ ] **Colour-blind-safe palette.** Provide an alternate route/water/off-road
      palette and don't rely on colour alone for warnings (add icons/text).
- [ ] **Screen-reader status.** `aria-live="polite"` for search results,
      loading state, off-road/water warnings, and route completion.
- [ ] **Touch ergonomics.** Bigger hit targets, safe-area padding, and a
      landscape HUD layout; add optional haptics
      (`navigator.vibrate`) on collisions/off-road.

## Engineering & reliability (P1)

- [ ] **Split `drive3d.js`.** It is ~2,000 lines. Extract `config.js`,
      `geo.js` (`lonToTileX`, `bearing`, `crossLine`), `tiles.js`,
      `terrain.js`, `ground.js`, `buildings.js`, `camera.js`, `controls.js`,
      `hud.js`. Keep the public `initDrive3D()` factory.
- [ ] **Automated smoke tests.** The CDP script used during development is a
      good base. Move it to `tools/smoke.mjs`, take screenshots at fixed
      coordinates (Boulder, Central Park, a Chicago River bridge, Lake
      Michigan) and assert "no JS exceptions, `ready`, water present".
- [ ] **Unit tests.** Pure helpers (`bearing`, `crossLine`, `lonToTileX`,
      `waterLevel` math with a fake DEM) are easy to test with `node:test`.
- [ ] **Lint / format / types.** Add ESLint + Prettier and `tsc --checkJs` with
      JSDoc. This codebase is dependency-free, so keep dev tooling separate.
- [ ] **CI/CD.** GitHub Actions: lint + tests on PRs, publish `main` to Pages,
      cache CDN/npm artifacts. Add SRI or bundle three/maplibre so a CDN
      outage can't break the game.
- [ ] **Error boundary + toasts.** Catch tile/DEM/routing failures per chunk
      and show a non-blocking toast instead of silently rendering an empty
      tile.
- [ ] **Frame budget guard.** Cap `pumpBuild` work by time (e.g. 6 ms/frame)
      rather than a fixed count so slow phones stay smooth.

## Notes / known trade-offs

- Ground layers are deliberately coplanar-ish and ordered by `renderOrder`
  with `depthWrite: false`; adding 3D ground features (curbs, raised decks)
  means deciding whether they join the painter stack or write depth.
- The wheel spin uses `speed / radius`; at high speed three's low-poly wheels
  can alias (wagon-wheel effect). A visual rate cap is a one-line fix if it
  bothers you.
- `buildCarMesh()` is shared by the garage preview and the world car; anything
  animated must be tagged via `userData` (like `userData.wheel`) so both
  paths keep working.
