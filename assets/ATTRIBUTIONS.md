# Coruscant asset provenance

These assets support the local demonstration. Runtime private supplied material is never served from `public/`. Asset acquisition and rendering are separate checks.

## Original Coruscant material

- The six fictional catalog records and fixed demonstration personas are newly authored in `demo/`; they are not real-provider documentation or real accounts. Real NORAD/COSPAR identifiers remain null.
- `demo/source-material/estuary-scenes.ts` freshly defines two 1600 × 1000 fictional estuary SVG illustrations. They share framing and show different dark-water extents. They are not measured radar observations, georeferenced imagery, flood detection or acquisitions by fictional spacecraft.
- The recorded initialization epoch determines the separate illustrative dates. Actual collection remains null. Generating source art records no staff review, publication, entitlement, delivery or customer note.
- The scenes are original project material authorized for local testing and demonstration. No third-party imagery is embedded. A public repository distribution license has not been inferred from that authorization.

## IBM Plex fonts

The approved individual Google Fonts distribution files are IBM Plex Sans variable (`IBMPlexSans[wdth,wght].ttf`) and IBM Plex Mono Regular/Medium. The font notices identify IBM Corp. and reserved name Plex. Preserve the complete accompanying **SIL Open Font License 1.1** beside the unchanged binaries; do not relabel them under the application license. Sans must expose weight 450 through its real variable weight axis.

- [Sans source](https://raw.githubusercontent.com/google/fonts/main/ofl/ibmplexsans/IBMPlexSans%5Bwdth%2Cwght%5D.ttf), [Sans OFL](https://raw.githubusercontent.com/google/fonts/main/ofl/ibmplexsans/OFL.txt).
- [Mono Regular](https://raw.githubusercontent.com/google/fonts/main/ofl/ibmplexmono/IBMPlexMono-Regular.ttf), [Mono Medium](https://raw.githubusercontent.com/google/fonts/main/ofl/ibmplexmono/IBMPlexMono-Medium.ttf), [Mono OFL](https://raw.githubusercontent.com/google/fonts/main/ofl/ibmplexmono/OFL.txt).

## NASA static Earth context

Credit: **NASA Earth Observatory — Blue Marble: Next Generation, July 2004; Reto Stöckli.** The approved 5400 × 2700 global JPEG is static historical globe context, not the customer's SAR pair, live imagery, telemetry or a coverage check.

- [Exact image](https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-base/july/world.200407.3x5400x2700.jpg).
- [Official map listing](https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-map/).
- [Official project credits](https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/).
- [NASA media-use guidance](https://www.nasa.gov/nasa-brand-center/images-and-media/).

The project credits and media-use guidance were read on **2026-10-21**. They support credited educational/informational use, including graphical simulations/texture maps, without implying endorsement. Third-party protected content and NASA identifiers have separate restrictions. No NASA logo, endorsement or invented MIT/CC license is used here. This records the identified permission basis, not a legal certification or a claim that every future commercial use is covered.

## Acquisition record

`scripts/fetch-assets.ts` downloads only the exact individual assets above. It validates font tables/axes/weights, OFL notices and JPEG dimensions/signature, records actual SHA-256 and source response metadata, and never silently overwrites a different existing file. The local manifest is `public/fonts/acquisition-manifest.json`. Source commits are not claimed where only distributor `main` URLs and binary versions/ETags are known. No conversion or subsetting is performed.

<!-- BEGIN ACQUIRED ASSETS -->

| Asset | Local file | Acquired UTC | Bytes | SHA-256 |
| --- | --- | --- | --- | --- |
| plex-sans-variable | public/fonts/IBMPlexSans-Variable.ttf | 2026-10-21T22:35:14.891Z | 537244 | `3b031aa4216174205bd8471f88a49b91f093169e9e87bd5262242bc5967fe2e3` |
| plex-mono-400 | public/fonts/IBMPlexMono-Regular.ttf | 2026-10-21T22:35:14.931Z | 135580 | `6a3412f058c7d8dfd9170c41e85ade48e5156ecb89356110ca57a0a27734af46` |
| plex-mono-500 | public/fonts/IBMPlexMono-Medium.ttf | 2026-10-21T22:35:15.114Z | 136704 | `a9b4c49bb299e05b5f6c481e7fb5e78943d2793249a0c8874ab574a2d1ea6755` |
| plex-sans-ofl | public/fonts/OFL-IBM-Plex-Sans.txt | 2026-10-21T22:35:15.301Z | 4456 | `7e6b2818edbd8f6a01ae80641cc8f16a51080d08fb4e532be3a0b6f74adb07da` |
| plex-mono-ofl | public/fonts/OFL-IBM-Plex-Mono.txt | 2026-10-21T22:35:15.439Z | 4456 | `7e6b2818edbd8f6a01ae80641cc8f16a51080d08fb4e532be3a0b6f74adb07da` |
| nasa-earth-july-2004 | public/earth/world.200407.3x5400x2700.jpg | 2026-10-21T22:35:15.718Z | 1617810 | `f55226d46d27e05511f2118dc6aa24f5dbf9b6b2cddc87cc6e0e7dd067c00b11` |

- **plex-sans-variable:** [original source](https://raw.githubusercontent.com/google/fonts/main/ofl/ibmplexsans/IBMPlexSans%5Bwdth%2Cwght%5D.ttf); IBM Corp.; IBM Plex Sans SIL OFL 1.1; reserved name Plex; preserve accompanying Sans notice. Original bytes unchanged. Distributor metadata: ETag W/"3f0ce498ec06da5d3eb6b78cfdf8530fe989bf765d1964baa2d7966c4e55dffb"; Last-Modified not supplied. Validation: `{"kind":"TrueType variable","family":"IBM Plex Sans","subfamily":"Regular","fullName":"IBM Plex Sans Regular","version":"Version 3.201","postScriptName":"IBMPlexSans-Regular","axes":[{"tag":"wght","min":100,"default":400,"max":700},{"tag":"wdth","min":75,"default":100,"max":100}],"supportedRequestedWeights":[400,450,500],"browserRenderingVerified":false}`. No unverified source commit is claimed.
- **plex-mono-400:** [original source](https://raw.githubusercontent.com/google/fonts/main/ofl/ibmplexmono/IBMPlexMono-Regular.ttf); IBM Corp.; IBM Plex Mono SIL OFL 1.1; reserved name Plex; preserve accompanying Mono notice. Original bytes unchanged. Distributor metadata: ETag W/"aa1a211cc7425455b816d906832e2d691a13cce50c18069521294182378e64ca"; Last-Modified not supplied. Validation: `{"kind":"TrueType static","family":"IBM Plex Mono","subfamily":"Regular","fullName":"IBM Plex Mono Regular","version":"Version 2.3","postScriptName":"IBMPlexMono-Regular","weight":400,"browserRenderingVerified":false}`. No unverified source commit is claimed.
- **plex-mono-500:** [original source](https://raw.githubusercontent.com/google/fonts/main/ofl/ibmplexmono/IBMPlexMono-Medium.ttf); IBM Corp.; IBM Plex Mono SIL OFL 1.1; reserved name Plex; preserve accompanying Mono notice. Original bytes unchanged. Distributor metadata: ETag W/"022cb1b33483ecb79c72ea32681d0d3cce0aff36f861ee24aaf4d6ce48ab9f4d"; Last-Modified not supplied. Validation: `{"kind":"TrueType static","family":"IBM Plex Mono Medium","subfamily":"Regular","fullName":"IBM Plex Mono Medium","version":"Version 2.3","postScriptName":"IBMPlexMono-Medium","weight":500,"browserRenderingVerified":false}`. No unverified source commit is claimed.
- **plex-sans-ofl:** [original source](https://raw.githubusercontent.com/google/fonts/main/ofl/ibmplexsans/OFL.txt); IBM Corp.; reserved font name Plex Complete original SIL Open Font License 1.1 notice. Original bytes unchanged. Distributor metadata: ETag W/"c2a95fe1a08fd58d6b8af0afeb47b675113af308693ba81ec9a133e2fbcc9a05"; Last-Modified not supplied. Validation: `{"kind":"SIL OFL 1.1 original notice","reservedName":"Plex","copyrightHolder":"IBM Corp."}`. No unverified source commit is claimed.
- **plex-mono-ofl:** [original source](https://raw.githubusercontent.com/google/fonts/main/ofl/ibmplexmono/OFL.txt); IBM Corp.; reserved font name Plex Complete original SIL Open Font License 1.1 notice. Original bytes unchanged. Distributor metadata: ETag W/"c2a95fe1a08fd58d6b8af0afeb47b675113af308693ba81ec9a133e2fbcc9a05"; Last-Modified not supplied. Validation: `{"kind":"SIL OFL 1.1 original notice","reservedName":"Plex","copyrightHolder":"IBM Corp."}`. No unverified source commit is claimed.
- **nasa-earth-july-2004:** [original source](https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-base/july/world.200407.3x5400x2700.jpg); NASA Earth Observatory — Blue Marble: Next Generation, July 2004; Reto Stöckli. NASA educational/informational media-use guidance with source credit; no endorsement or invented MIT/CC licence. Original bytes unchanged. Distributor metadata: ETag "18af92-64611601a7940"; Last-Modified Tue, 16 Dec 2025 13:05:01 GMT. Validation: `{"kind":"JPEG header/signature","precision":8,"height":2700,"width":5400,"fullDecodeVerified":true,"globeOrientationVerified":true,"depictedMonth":"2004-07","rendererEvidence":"Slice 6: actual headed in-app browser decoded the local texture and showed north-up Africa in the reset frame; Chromium/WebKit projection/picking checks exercise the same geographic conversion. No real-time imagery or coverage is inferred."}`. No unverified source commit is claimed.

Binary source validation alone is not a browser-rendering, JPEG full-decoding or globe-orientation pass. Any later renderer evidence is explicitly identified in the recorded validation; it makes no telemetry or coverage claim. Font notices remain beside the original files.

<!-- END ACQUIRED ASSETS -->
