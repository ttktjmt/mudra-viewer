# 0002. Muscle Manifold view: feature extraction, dimensionality reduction, and rendering approach

- Status: Accepted (2026-07-06)

## Context

We are adding a third view, "Manifold" (`src/views/manifold.ts`), alongside
the existing Time and Frequency (`src/views/spectrum.ts`) views. It
visualizes the 3-channel sEMG signal as a low-dimensional "muscle manifold":
extract per-channel frequency-band features from the FFT the Frequency view
already enables (`Stream.spectrumInto`), reduce dimensionality (PCA now,
other methods such as LDA as candidates later), and render the resulting
point cloud / manifold in 2D or 3D. Several build-vs-buy and scope decisions
were made before implementation; this records the "why" so it isn't lost.

## Decision

1. **Dimensionality reduction: PCA only for now, structured for
   extensibility.** Only PCA is implemented. Because LDA and other
   supervised methods are wanted later, the linear-algebra layer (matrix
   ops, eigendecomposition) is chosen so a future LDA implementation can
   reuse it without replacing the PCA path.

2. **Add `ml-pca` + `ml-matrix` as runtime dependencies** — the first
   non-`mudraka` dependency in the project. Surveyed alternatives (mathjs,
   numeric.js, simple-statistics, danfojs, `@tensorflow/tfjs`, pca-js,
   pw-lda, bcijs) — none combined active maintenance, small size, real
   ESM/TS types, and license compatibility (Apache-2.0) as well as
   `ml-matrix`/`ml-pca` (MIT, actively maintained, tiny tree-shaken
   footprint, `fit`/`predict`-style PCA API). No maintained browser-friendly
   Fisher-LDA package exists on npm — the only two real implementations
   (`pw-lda`, `bcijs`) are ~6-7 years abandoned and Node-oriented. LDA will
   be hand-written later directly on `ml-matrix`'s
   `EigenvalueDecomposition`/`CholeskyDecomposition` primitives, which
   `ml-matrix` already ships.

3. **Feature extraction: variable-width filter bank over a variable-length,
   all-channel-shared list of center frequencies.**
   - The center-frequency list is not fixed at any particular count; both
     the count and the values are placeholders (marked `ponytail:`) until
     decided by reviewing real recorded-EMG spectra together.
   - One shared list applies to all 3 channels, keeping the feature matrix
     a simple `channels × points` shape.
   - Smoothing around each center frequency uses a mel-filterbank-style
     variable-width triangular window, where each point's window half-width
     is set by the distance to its neighbors — denser low-frequency points
     get narrower windows (finer resolution), sparser high-frequency points
     get wider windows (more smoothing), with no extra width parameter
     needed.

4. **Sampling / buffering / PCA refresh cadence — all runtime-configurable
   constants.**
   - Feature vectors are sampled every 0.1 s (configurable) into a 300-point
     ring buffer.
   - PCA is refit every 10 samples (configurable), using the entire current
     ring-buffer contents, not incrementally.
   - Rationale: refitting every frame makes the axes visibly spin/flip
     (unstable); a periodic batch refit keeps axes meaningfully stable
     while still tracking drift.

5. **Animation: fixed-duration eased interpolation, not fixed-speed.** When
   PCA axes are refit, every point (and the manifold hull) animates from its
   old projected position to its new one over the same fixed duration (e.g.
   500 ms, eased) — not at a fixed pixel-speed, which would leave far-moved
   points trailing behind and arriving at different times.

6. **Point recency: opacity fade only, no class-color coding (yet).** Older
   points in the ring buffer fade in opacity; there is no color-by-class /
   gesture encoding in this iteration (see "Deliberately not done").

7. **2D/3D: an exclusive toggle ("plane" / "cube"), not simultaneous
   display.** PCA computes only as many components as the active mode
   needs (2 for plane, 3 for cube), not always 3 with slicing. Switching
   modes triggers a refit at the new component count.

8. **Manifold surface: convex hull (2D Graham scan / 3D incremental hull),
   not density-based contours.** KDE / alpha-shape / marching-cubes were
   rejected as disproportionate implementation cost for this scope; convex
   hull is small to implement, has few vertices (so hull-vertex
   interpolation for the deformation animation stays simple), and is
   sufficient for showing the manifold's rough extent.

9. **3D rendering: hand-rolled Canvas2D (rotation matrix + orthographic
   projection + mouse-drag rotation), not three.js/WebGL.** Both Time and
   Frequency views are plain Canvas2D with no charting/3D library;
   introducing WebGL for one view breaks that consistency, and since the 3D
   convex hull already has to be hand-written, the extra
   projection/rotation math is a small addition — three.js's scene graph,
   lighting, and materials would be almost entirely unused for a scatter
   plus hull.

10. **Feature sampling / PCA only run while the Manifold tab is active**,
    unlike Time's `advanceRing` which always runs. The ring buffer starts
    empty each time the tab is opened. Chosen because PCA refits are
    comparatively expensive and the manifold is meant to show "what's
    happening while you're watching it", not a persistent history across
    tab switches.

11. **Info affordance: scoped to the Manifold view, not global.** The "ⓘ
    What is Muscle Manifold?" affordance and its native `<dialog>`
    (`showModal()`, `overflow-y: auto` for scrolling) only render inside the
    Manifold view's bottom-left corner, shown only while that tab is
    active — consistent with existing view-scoped UI (e.g. the spectrum
    lock icon/tooltip) and irrelevant to the other two tabs.

12. **Explanation diagram: pre-rendered static SVG, no mermaid runtime
    dependency.** The process diagram (sampling → filter-bank extraction →
    ring buffer → PCA refit → animated projection → hull/point-cloud
    render) is authored as a mermaid `.mmd` source, rendered to SVG by hand
    once (e.g. via mermaid.live) and checked into the repo as a static
    image displayed with `<img>`. `@mermaid-js/mermaid-cli` was rejected as
    a devDependency — it requires headless Chromium (puppeteer), too heavy
    for a diagram that's rendered once and rarely changes. The `.mmd`
    source is kept in the repo with a short note on how to re-render it if
    it ever needs to change.

## Deliberately not done (add when a wall is actually hit)

- **LDA / other supervised dimensionality reduction** — no maintained
  browser LDA library exists; will be hand-written on `ml-matrix`
  primitives once there's a concrete labeled-class use case (e.g. comparing
  fixture gestures).
- **Final center-frequency list** — current values are a placeholder; to be
  replaced after reviewing real recorded-EMG spectra.
- **Class/gesture color-coding of points** — deferred until LDA (or another
  labeled use case) makes "which class is this point" meaningful to show.
- **Density-based manifold surface (KDE / alpha-shape)** — convex hull is
  used instead; revisit only if the hull's convexity assumption visibly
  misrepresents the data.
- **`mermaid` runtime dependency / `mermaid-cli` build step** — a
  hand-exported static SVG is used instead.

## References

- `ml-matrix` / `ml-pca` (mljs org, MIT) — https://github.com/mljs/matrix,
  https://github.com/mljs/pca
- `docs/adr/0001-macos-forget-device-limitation.md` for ADR format
  precedent.
