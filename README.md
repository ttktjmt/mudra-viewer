# mudra-viewer

[![Deploy to GitHub Pages](https://github.com/ttktjmt/mudra-viewer/actions/workflows/deploy.yml/badge.svg)](https://github.com/ttktjmt/mudra-viewer/actions/workflows/deploy.yml)

Realtime EMG Signal Viewer for Mudra Link

A static web app that connects to a Mudra Link directly from the browser over
Web Bluetooth and shows its 3-channel sEMG waveforms in real time (~834 Hz).
Decoding is done by [`mudraka`](https://github.com/ttktjmt/mudraka) (WASM);
the BLE connection is handled in-app.

## Browser support

**Chrome / Edge only (desktop and Android).** Safari, Firefox, and iOS do not
support Web Bluetooth and will not work.

## Development

```sh
npm install
npm run dev      # http://localhost is a secure context -> real-device testing works
npm run build    # tsc + vite build -> dist/
```

Open in Chrome, click **Connect**, pick the device, and the SNC stream starts
automatically.

## Deploy

Pushing to `main` runs a GitHub Action that publishes `dist/` to GitHub Pages
(`base: /mudra-viewer/`). Set the repository's Settings → Pages → Source to
"GitHub Actions".

## To confirm on real hardware (unverified)

The code follows the Mudra Link BLE spec, but these need to be verified against
a real device:

- Whether the parent service UUID is `0xfff0` (`SERVICE` in `src/main.ts`)
- The exact advertised name (the `namePrefix` in `requestDevice`)

If the device does not appear in the chooser, temporarily switch to
`{ acceptAllDevices: true, optionalServices: [SERVICE] }` to isolate the cause.
