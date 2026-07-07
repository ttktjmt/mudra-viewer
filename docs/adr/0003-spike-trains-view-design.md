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

6b. **fastICA initialization + MU ordering mirror the established tools.**
   fastICA has no intrinsic ordering (whitening equalizes variance, so there is
   no eigenvalue-like ranking). Following MUedit (`sum(X,1).^2` argmax) and
   EMGdecomPy (`initial_w_matrix`), each source's separation vector is
   initialized from the highest-activity whitened sample (squared-norm max),
   with the used peak zeroed so the next source starts elsewhere — deflation
   keeps them distinct. This is more stable and reproducible than random init.
   Display order is then set post-hoc by **recruitment order = earliest first
   discharge time**, exactly as openhdemg's `sort_mus` and pyMUEdit's
   `sort_MUs` do (`key = first MUpulse`). MU 1 (earliest recruited) is pinned to
   the bottom row, reproducing the canonical HD-sEMG raster look. SIL is used
   only for quality/acceptance, never for ordering — matching all the tools.
   Caveat: our "first discharge" is taken over the concatenated fixtures (not a
   single force ramp), so it is a recruitment *proxy*, not a calibrated
   threshold.

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

## Addendum (2026-07-08): MU-numbering study + sparse-firing root-cause investigation

After the first implementation, the live raster looked wrong: rows fired far
too rarely (≈0.04–1.7 pps vs the physiological 3–11 pps), and the row that
fired most was not MU 1. We investigated by reading the actual source of the
established tools (cloned locally) and by instrumenting our own pipeline on the
recorded fixtures. Findings:

### How the established tools number motor units

Every tool separates numbering into two independent phases:

1. **Extraction order (during BSS)** — driven by the initialization, not by any
   physiological quantity. MUedit (`MUedit_exported.m`: `actind = sum(X,1).^2;
   [~,idx]=max(actind)`) and EMGdecomPy (`decomposition.py: initial_w_matrix` →
   `z_peak_heights.argmax()`) both initialize each new separation vector from
   the **highest-activity whitened sample** (squared-norm max), zero that peak,
   and repeat; deflation keeps sources distinct. fastICA/CKC have **no intrinsic
   ordering** (whitening equalizes variance, so there is no PCA-like
   eigenvalue ranking).
2. **Display/analysis order (post-hoc)** — the physiological sort. openhdemg
   `sort_mus` (`tools.py`) and pyMUEdit `sort_MUs` (`FileUploadFunc.py`) both
   sort by **first discharge time** (`key = first MUpulse`, ascending) =
   recruitment order. This is what produces the canonical "earliest-recruited at
   the bottom, densest" raster.
3. **SIL is used only for quality/acceptance and duplicate removal, never for
   ordering** — in all of them.

We aligned our code with (1) and (2): activity-index initialization replaced the
random init, and accepted sources are now sorted by first-discharge time
(decision 6b). SIL remains an acceptance gate only.

### The tools' refinement step we had omitted

Both tools run a **CoV-ISI refinement loop** after the fixed-point separation
(Negro et al. 2016, steps 4–6): detect spikes (`findpeaks` with a
~15–20 ms `MinPeakDistance` → K-means on peak heights → high-centroid cluster),
then update the filter `w = mean(z at spike times)`, re-detect, and iterate
**while the ISI coefficient of variation keeps decreasing** (MUedit
`minimizeCOVISI.m`, EMGdecomPy `refinement`). This converges the filter onto a
regular-firing unit. Our v1 did a single-shot detection with no refinement and
no min-distance in threshold learning — real deviations from the tools.

### Root cause of the sparse firing (three experiments)

1. **µV/int32 scaling — ruled out.** Decomposing the same data at amplitude ×1
   and ×1000 gives byte-identical results. Whitening normalizes every source to
   unit variance regardless of input amplitude, and the K-means threshold is
   data-driven, so any global scale cancels. The int32-vs-µV question is
   irrelevant to detection.
2. **The squared-source peak distribution is pathologically heavy-tailed** —
   max/median ≈ 45,000–78,000×. There is a handful of giant transients and
   otherwise noise; 2-means isolates only the single largest peak, giving
   ≈0.04 pps. This is not a bug in the clustering — there is simply no distinct
   spike cluster to find.
3. **Faithful refinement + stronger recordings do not rescue it.** We added the
   full CoV-ISI refinement with generous seeding and also re-ran on
   deliberately stronger contractions (`grasp2 … supination2`, RMS ~1.5–2×
   higher). The CoV-ISI never converges toward the physiological 0.1–0.3 range:
   it stays ~1.6–1.9 on the weak set and actually **worsens to ~3.2–4.2 on the
   strong set** (more activity → more noise-tail crossings, not more regular
   trains). Pure Poisson would be CoV = 1.0; our values are well above that.

### Conclusion

The binding constraint is the **3-channel spatial resolution**, not signal
strength, not amplitude calibration, and not the (real but secondary)
implementation gaps. A 3-channel armband's whitened sources are colored noise
with occasional transients; they do **not** contain separable, regular
motor-unit spike trains, so no amount of refinement or stronger contraction
recovers physiological discharges. This quantitatively confirms the
sparse-channel literature (≈1.5 ± 0.5 MU/trial; single bipolar resolves ~33.7%
of low-threshold MUs). Faithful HD-sEMG tools would **reject** all of these
sources on SIL/CoV grounds.

Implication for this view: what it shows are, at best, activity-driven
threshold crossings — not motor units. The honest paths forward are (a) keep it
explicitly experimental / relabel as noise-derived putative sources, (b) make
detection tool-faithful (refinement + min-distance), which correctly renders it
near-empty on 3-channel data, or (c) pivot to a **cumulative firing-rate proxy**
(rectified/smoothed neural-drive envelope), which is the most that 3 channels
can legitimately support. True MU decomposition requires HD-sEMG (64+ channels).

### Addendum references (tool source read for this study)

- openhdemg `sort_mus` (first-discharge sort) —
  https://github.com/GiacomoValliPhD/openhdemg `openhdemg/library/tools.py`
- pyMUEdit `sort_MUs` —
  https://github.com/modenaxe/pyMUEdit `src/app/muAnalysisFunctions/FileUploadFunc.py`
- MUedit `fixedpointalg.m`, `getspikes.m`, `minimizeCOVISI.m` —
  https://github.com/simonavrillon/MUedit
- EMGdecomPy `initial_w_matrix`, `refinement` —
  https://github.com/The-Motor-Unit/EMGdecomPy `src/emgdecompy/decomposition.py`
- Negro et al. 2016, CKC/fastICA refinement (steps 4–6) — the algorithm both
  tools implement.
