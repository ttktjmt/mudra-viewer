# 0003. Spike Trains view: real-time motor-unit source decomposition from 3-channel sEMG

- Status: Accepted (2026-07-07)

## Context

We are adding a fourth view, "Spike Trains" (`src/views/spikes.ts`), alongside
Time, Frequency (`src/views/spectrum.ts`), and Manifold
(`src/views/manifold.ts`). It applies the *same* algorithm established for
high-density surface EMG (HD-sEMG) motor-unit (MU) decomposition — time-delay
extension, whitening, fastICA, peak detection, K-means, and silhouette (SIL)
selection — to the 3-channel Mudra Link sEMG signal (~834 Hz), and renders each
separated source's spike train in real time, one stacked band per source.

The central honesty constraint drove most decisions below. True MU
decomposition assumes an HD-sEMG grid (64+ channels); a 3-channel armband
structurally lacks the spatial redundancy needed to distinguish individual
motor units. Reported figures: sparse-channel setups identify on average only
1.5 ± 0.5 MU/trial, a single bipolar channel resolves only ~33.7% of
low-threshold MUs, and such data is "insufficient for investigating the
activity of specific motor units." Therefore what this view shows is not
physiologically strict motor units but *putative motor unit sources* — the
output of the identical HD-sEMG math run on a spatially under-resolved input.
The algorithm is the same; only the input's spatial resolution is worse. This
framing is stated in code (`spike:` / `ponytail:` comments) and in the UI
(caption), and is not to be removed: the gap between the name and the reality
is the single largest risk, and honest labeling is what closes it.

Several build-vs-buy and scope decisions were made before implementation (via a
grilling session); this records the "why" so it isn't lost.

## Decision

1. **Decomposition algorithm: fastICA, not CKC.** fastICA (with time-delay
   extension and whitening) is EMGdecomPy's main path and matches the
   referenced literature. Convolution Kernel Compensation (CKC) yields nearly
   identical results (well-documented high agreement) at much higher
   implementation cost with little JS precedent — rejected as disproportionate
   (YAGNI).

2. **No new runtime dependency.** Whitening (the PCA-equivalent
   eigendecomposition) reuses `ml-matrix` / `ml-pca`, already introduced in ADR
   0002. The fastICA fixed-point iteration, 1-D K-means (k=2), SIL, and peak
   detection are each a few dozen lines — no specialized library is added.

3. **Decompose once, then project (not per-frame re-decomposition).** The
   separation matrix `W` is learned once and then held fixed; each live frame
   only applies `W` to new samples (a matrix product) and detects peaks. This
   avoids fastICA's permutation/sign ambiguity — re-decomposing every window
   would reshuffle which source maps to which display row, making the raster
   meaningless (unlike the Manifold's PCA, where axis flips still preserve the
   point-cloud shape). It matches the openhdemg "decompose once → project"
   workflow and keeps live cost to a light matrix product.

4. **`W` is learned from the recorded fixtures, not from the first live
   window.** fastICA separates sources by variance/non-Gaussianity; a rest or
   low-contraction window would collapse the separation vectors onto noise.
   Since `W` is then held fixed (decision 3), a bad initial window would poison
   the whole session. Instead, all five fixtures
   (`grasp`, `open`, `pinch`, `pronation`, `supination`) are concatenated
   (≈15–20 s of varied contractions) and decomposed once. Every recording
   starts and ends at rest, so the near-Gaussian rest segments do not attract
   separation vectors (the active bursts dominate) and additionally provide a
   clean noise baseline. Each fixture is band-pass filtered individually before
   concatenation so boundary transients stay confined within each fixture.

5. **No input-stage rectification.** The pipeline is band-pass (20–150 Hz, no
   rectify) → extend → center → whiten → fastICA → project → **square the
   source** → peak → K-means → SIL. fastICA relies on the phase/polarity
   independence of MUAP waveforms; rectifying the input would destroy that and
   break separation. The rectifying nonlinearity belongs *after* source
   extraction (the square), for spike detection only. This matches EMGdecomPy's
   order exactly.

6. **Spike identification: square → peak → 1-D K-means(k=2) → SIL, thresholds
   frozen at learning time.** After `W` is extracted, each source is squared,
   peaks are detected, a 1-D K-means (k=2) splits peak heights into
   spike/noise clusters to fix a per-source firing threshold, and SIL rejects
   low-quality sources (only accepted sources become display rows). At live
   time K-means is not re-run — each frame applies the frozen threshold with a
   refractory period. This keeps detection cheap and the cluster boundary
   stable, consistent with decision 3.

7. **Feed samples off the free-running display clock (`advanceRing`), so the
   raster scrolls continuously like the Time view.** Live spike processing runs
   inside `advanceRing` (main.ts), gated by `view === "spikes" && W ready`,
   consuming the same queue-drained-at-RATE samples the waveform ring uses
   (zeros fed in when the queue is empty). This makes the time axis advance
   continuously whether or not data is arriving — matching Time's liveness —
   which was preferred over the alternative of feeding at the decode point
   (`feedBytes`). The trade-off: zero-fill during idle injects a one-shot
   transient into the IIR band-pass when data stops, which can cause a single
   spurious spike at that edge; accepted as minor for putative sources. The
   processor keeps its own continuous state (IIR band-pass state, a rolling
   R-sample delay vector, refractory counters, firing-rate history), reset on
   tab open.

8. **Lazy learning on first tab open, cached for the session.** `W` is learned
   the first time the Spikes tab is opened (not eagerly at app startup, which
   would burden users who never open it), using a throwaway `mudraka` Stream to
   decode the fixtures — separate from the live stream, so it does not
   interfere. `W` is cached; reopening the tab does not re-learn. Opening the
   tab resets only the signal/display state (like the Manifold's fresh
   point-cloud per open, ADR 0002 decision 10), keeping the cached `W`.

9. **Rendering: single canvas, one stacked band per accepted source.** Each
   band draws that source's spike raster (full-height vertical ticks at firing
   times) with its smoothed firing-rate trace (Hanning-window, pps-like)
   overlaid in a translucent tint of the band color. Bands are ordered with
   MU 1 at the bottom. The cumulative (total) firing rate is drawn as a
   light-grey line across the whole plot behind the bands, so total-rate vs.
   raster correlation is readable. Left→right scroll with a ~3 s window,
   matching the Time view. A single canvas with y-subdivision (as
   Manifold/Frequency each own one canvas) handles the variable row count more
   simply than dynamically built DOM lanes.

10. **All key parameters are runtime-tunable constants (`ponytail:`).**
    Hardware is never the ideal on paper; these are starting values to be tuned
    against real data:

    | Symbol | Meaning | Initial | Note |
    |--------|---------|---------|------|
    | band-pass | MUAP main band | 20–150 Hz | matches the single-channel deconvolution literature's ~90%-correlation band |
    | R | time-delay extension order | 16 | 48 effective dims; a lower bound compensating the 3-channel shortfall — raise if separation is poor |
    | M | max sources extracted | 8 | deflation cap = max display rows |
    | learn window | concatenated data length | all 5 fixtures (≈15–20 s) | varied contractions stabilize the sources |
    | refractory | min inter-spike interval | tune (e.g. 20 ms) | physiological MUs fire ~3–11 pps → lower-bound ISI guide |
    | Hanning window | firing-rate smoothing | tune (e.g. 400 ms) | matches the literature's smoothed discharge rate |
    | display window | scroll width | ≈3 s | same as the Time view |

## Implementation outline

1. **New `src/views/spikes.ts`** (the view body): `createSpikesView(canvas)`
   factory (same shape as spectrum/manifold), containing the signal processing
   (2nd-order Biquad IIR band-pass with retained state, delay extension,
   whitening via `ml-matrix`, fastICA fixed-point with deflation, square + peak
   detection, 1-D K-means(k=2), SIL); `learnW(fixtures)` (throwaway Stream
   decode → concatenate → decompose → cache `W` + frozen thresholds + accepted
   sources; run once on first tab open); `feed(samples)` (per-sample projection,
   spike detection, firing-rate update from `feedBytes`); `draw()` (single
   canvas: MU bands + total rate); `reset()` (clear signal/display state on tab
   open, keep `W`).
2. **One runnable self-check** in the same file (`ponytail:` — non-trivial
   logic gets one check): a synthetic spike train asserting that the K-means
   threshold correctly splits spike/noise.
3. **Wire `src/main.ts`**: add `"spikes"` to the `View` type and `VIEWS`; add
   the `tab-spikes` button to `setView` / `navigate` / click handlers;
   instantiate `createSpikesView`; add a gated `spikesView.feed(...)` in
   `feedBytes`; add `else if (view === "spikes") spikesView.draw(...)` to
   `draw()`; call `spikesView.reset()` in `setView("spikes")` and `await
   learnW` on first open (with a "learning…" state).
4. **Wire `index.html`**: add the `Spike Trains` tab button, a hidden `#spikes`
   panel (canvas + honesty caption), and minimal CSS reusing the `#manifold`
   pattern.
5. **State the caveat**: caption in the `#spikes` panel and a header comment in
   `spikes.ts` — 3-channel origin = putative sources, not true MU
   decomposition.

## Deliberately not done (add when a wall is actually hit)

- **Live `W` re-learning** — `W` is fixed from the fixtures at startup; add
  live re-learning only if live accuracy proves insufficient. The
  **permutation/sign realignment** and **activity gate** it would require are
  skipped with it.
- **Reusing firing rates in the Manifold view** — this iteration ships an
  independent view only; swapping firing-rate vectors in as the manifold's
  features is a separate future task.
- **CKC-family decomposition** — fastICA suffices (decision 1).
- **MyoSuite arm-control coupling** — a future task; recorded here only as the
  intended direction (the firing rates / sources could feed a muscle-synergy
  space → per-muscle excitation mapping).

## References

- Low-dimensional neural manifold of MU activity and common input: jNeurosci
  2024 — https://www.jneurosci.org/content/44/34/e0702242024
- Single/few-channel deconvolution (cumulative firing, ~90% correlation) —
  https://pubmed.ncbi.nlm.nih.gov/31350669/ ,
  https://www.mdpi.com/2079-9292/10/16/2022
- Sparse-channel decomposition limits (1.5 ± 0.5 MU/trial) —
  https://pmc.ncbi.nlm.nih.gov/articles/PMC12013791/
- fastICA vs CKC high agreement —
  https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5015010/
- EMGdecomPy (fastICA main-path reference) —
  https://github.com/The-Motor-Unit/EMGdecomPy
- openhdemg (decompose once → project workflow) —
  https://www.giacomovalli.com/openhdemg/quick-start/
- EMG as a low-pass-filtered image of the neural drive (volume conduction) —
  https://pubmed.ncbi.nlm.nih.gov/24760934/
- `docs/adr/0002-manifold-view-design.md` for the view-addition precedent and
  the `ml-matrix` / `ml-pca` dependency.
