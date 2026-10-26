# Coruscant

Coruscant connects an Earth-observation question to saved discovery evidence, a mission brief and a shared request. The approved build retains its original seven slices, Slice8 real discovery and the [question-to-plan9→10 order](devpost/checklist.md). **The app supports persistent customer/staff requests, Clarifications and revisions, private/published quotes, authorized decisions, one initial staff schedule, exact-version material/finding review and publication, separate organization access, protected SatSuite comparison, strict-date manual delivery and author-owned point observations.** Slice9's sourced target/multi-sensor Planning work was accepted and committed as `0f1b43e`, then passed its exact committed clean-checkout gate. Slice10 adds automatic bounded technical options and explicit tentative-plan saving, committed as `067cf50`. The learner accepted the repaired combined final exploration; final review and the evidence-based wrap-up/offline app map are complete. The unchanged implementation passes276/276 project checks,228/228 complete Chromium/WebKit cases and exact committed clean-checkout V17; detailed full/corrective evidence is in the checklist. Public repository publication, video upload and Devpost submission remain separate, unfinished shipping work; no provider booking is implemented or implied.

Ordinary StarSearch now uses the adopted CelesTrak SAR + Earth Resources source scope. The separate Demonstration catalog retains the freshly authored fictional records/tracks, and supplied comparison artwork remains original synthetic demonstration material. It does not connect to a satellite operator, make payments, task spacecraft or collect observations. Technical relevance is not a finding of coverage, feasibility or availability. Source recipes are not automatically supplied or published results; initialization creates no successful requests, reviews, acceptances, entitlements, deliveries or user notes.

## Run locally

Use macOS and the pinned **Node24.22.1 / npm11.19.1**. From this project's root, with nvm already available:

```sh
source "$HOME/.nvm/nvm.sh"
nvm install 24.22.1
nvm use 24.22.1
node --version
node -p "process.execPath"
npm --version
```

If that nvm installation supplies another npm version, select the agreed version with `npm install --global npm@11.19.1`, then verify it again. The project runtime check refuses a different pin. A matching official Node installer is an alternative to nvm; do not change Codex's bundled runtime.

The lockfile was generated for this new project. Reuse it with this exact first-run order:

```sh
npm ci
npm run verify:runtime
npm run build:server
npm run assets:fetch
npm run db:migrate
npm run demo:init
npm run build:client
npm start
```

Open **http://127.0.0.1:3000/**. Keep that same address for navigation and API traffic. The one Fastify process serves the compiled interface and API; there is no separate Vite preview or development origin. The server refuses public-interface binding. If port3000 is occupied, stop the conflicting process or deliberately use one alternate loopback port with `CORUSCANT_PORT=3001 npm start` and open its matching address.

Dependencies, approved fonts/texture and test browsers require initial network acquisition. The core local workflow and cached catalog remain usable offline; real prediction requires sufficiently fresh permitted cached elements, and an explicit source refresh requires network access. It needs no API key, real account, email service or `.env` credentials. Asset acquisition records source notices and actual hashes in the local public attribution manifest; failed acquisition must be retried rather than replaced with a remote runtime URL.

`build:server` emits the Node entrypoints and copies the ordered allowlisted SQL migrations into `dist/node/server/db/migrations`. TypeScript does not copy SQL implicitly. The migration/init commands therefore run after that build. The client build cleans only `dist/client`; it preserves compiled server files. Startup refuses an uninitialized or incompatible schema and a missing normal-mode client bundle.

After setup, `npm start` reopens the existing database. After source updates, stop the running process, run `npm run build`, `npm run db:migrate` and `npm run demo:init`, then `npm start`. Ordered migrations and initialization preserve saved work and D0. For source-only edits without schema changes, `npm run dev` builds and starts the same single-origin server. Never delete the database to make an update pass.

## Existing-workspace update and runtime smoke

Stop the process that actually owns port3000 before rebuilding; an old server can serve newer static files without loading their new routes. If an agent-managed session owns it, coordinate that session or verify its listener PID and project cwd before a graceful stop. Do not launch a second listener, use a broad kill command, reset D0 or delete `.local`. Keep existing browser tabs open to retain unsent same-tab work.

With the pinned Node/npm selected, run from this project:

```sh
npm run build
npm run db:migrate
npm run demo:init
npm start
```

In a second terminal:

```sh
npm run smoke:workspace
```

The read-only smoke requires a working catalog, three valid authored tracks at the same persisted D0, and a registered Missions route that correctly refuses an unauthenticated read. It also probes the current assessment/start/status/cancel/handoff and proposed-plan review routes through non-mutating access denials. It sends no access cookie and creates no session/request/review. A geometry503 means initialization/evidence is unavailable; a route404/static-page fallback suggests an older process or incorrect build. Stop and inspect rather than deleting data. On an explicitly chosen alternate origin use `npm run smoke:workspace -- http://127.0.0.1:3001`.

Then open a new browser tab, inspect the held-D0 label, and use your actual permitted customer context to open Missions and the same saved request/result. Confirm guide dates and records were preserved. A successful public smoke alone does not prove a private user journey or replace final hands-on review. The smoke also checks the real-catalog API and its source/page contract, plus registered place lookup and Planning save/submission routes through denied, non-mutating probes. A client from a newer build must not be paired with an older listener. READY means source records are cached; UNAVAILABLE is a registered first-use/offline state requiring an explicit permitted refresh, not a reason to substitute fictional rows. It makes no provider call.

## Browse real catalog evidence

Ordinary StarSearch opens **Real catalog**. The adapter loads the full validated SAR and Earth Resources populations, deduplicated by full1–9-digit catalog identity. It does not cap the catalog at the two enriched Sentinel examples. On a fresh checkout no source data is seeded: use **Refresh public catalog** deliberately. Group retrieval sends only the fixed public group query and connection IP. Brief, area, contact and local access tokens remain local.

Refresh is shared, serialized and rate limited to at least two hours between attempts per group, including failures. A provider error stops the batch with no automatic retry. Last-good/partial sources retain their original dates and visible limits. Failed or stale data never becomes a fictional Real result. Records can remain inspectable while orbit prediction is unavailable. See [source/rights notices](THIRD_PARTY.md).

Try `SAR imagery, maximum ground resolution 10 m.` The ordinary unknown-evidence policy includes a candidate only as caveated when required facts are absent; **Documented criteria only** excludes missing required evidence. Strict matching may return none. Source-group membership is not a verified sensor. Sentinel-1C/D’s mode/product facts do not prove a generic≤10m supplied product: IW’s nominal5×20m dimensions and GRD-HR10×10m pixel spacing are different from applicable spatial resolution. No mode, owner-country, instrument health or operator availability is inferred. Remove the requested resolution to inspect what the remaining evidence actually supports.

The list matches the whole immutable snapshot and loads100-row pages. The globe separately limits plotted positions to200 and sampled tracks to50, prioritizing selected/shortlisted identities; missing/stale/unsupported and display-limited objects remain counted and inspectable. Its common represented UTC is captured from the server when entering Real and stays paused across searches. **Update predicted time to now** uses cached elements, not a source refresh. These are SGP4 predictions, never live telemetry, SAR imageability, whole-area coverage or booking. Fresh prediction requires epoch/retrieval age≤24h and the adopted epoch span; a re-download cannot make an old epoch new.

Selection, shortlist, camera Follow and the Earth area are separate. **Rotate** moves the camera; **Select area** freezes it for a deliberate center-to-edge drag. Release stages a circle; **Use this circle** applies it, and the brief's separate size confirmation remains required. Outside-Earth, grazing, zero/over-limit drawing and second-touch gestures do not silently alter the area. Drawing accepts1–500km; numeric coordinates/radius retain finer/larger valid values. A numeric correction stages a proposal before applying it. Source or WebGL failure retains the list, numeric brief and saved-request path.

The original question stays local. A bounded local extractor exposes its exact **Place phrase**; typing never calls the provider. **Explore matches & find place** explicitly reads the catalog and sends only that visible phrase to the approved [Nominatim service](https://operations.osmfoundation.org/policies/nominatim/). **Search catalog only** avoids lookup. Inspect returned source/identity/coordinates; multiple returned locations require a choice. Apply a source circle without retyping coordinates, correct it if necessary, then separately confirm the area. A25km lookup radius is an editable planning assumption, not a mapped place boundary. A new question never silently moves an existing area: explicitly apply, keep or cancel, with the retained area marked unresolved from that description.

Place lookup is optional network use. No mission question, AOI, contact, session or credential goes upstream. Do not submit personal/confidential locations. One shared single-process limiter permits one active call and at least1.1seconds between attempts; errors never auto-retry and Retry-After survives restart. The private7day cache is separate from saved immutable provenance. Provider URL and identifying User-Agent can be configured with `CORUSCANT_PLACE_PROVIDER_URL` and `CORUSCANT_PLACE_USER_AGENT`; the default is `https://nominatim.openstreetmap.org/search` and `CoruscantLocalDemo/0.1 (user-initiated educational place lookup)`. No autocomplete, bulk/reverse geocoding or runtime map tiles are used. Unavailable/ambiguous/offline lookup preserves manual drawing/coordinates. The local educational operator is responsible for the policy and visible OpenStreetMap attribution.

SAR, Visible, SWIR and Thermal support request planning. Fresh cited native instrument evidence is initially enriched for the actually present Sentinel-2B/2C and Landsat8/9 identities; it does not cap or fill the remaining catalog. MSI Visible10m/SWIR20m and OLI Visible/SWIR30m never satisfy1m. TIRS native100m is separate from distributed30m pixels. Unknowns remain caveated with strict off and are excluded with **Documented criteria only**; known incompatibilities fail in both. Equivalent spectral centers/widths are not measured continuous passbands. Free-form spectral requirements are retained for review and never silently counted as documented catalog fit. The implemented Slice10 technical options add only the bounded physical/spectral checks described below; their mechanical evidence and actual learner checkpoint remain separate in the checklist.

Real and Demonstration keep separate selected/shortlisted evidence while preserving deliberate shared question/manual/area/date/contact work. Explicit request review/save links the exact real source/fact versions; customer and separate staff see the same saved evidence after return/reload/restart. A subsequent refresh does not rewrite it. A real candidate never converts the synthetic result, quote or recorded plan into operator agreement or a real collection. All publication, entitlement, strict comparison-date and explicit delivery gates remain.

### Verify newly acquired orbital bytes

The application needs no Python runtime. Numerical verification alone uses the approved CPython3.12 / `sgp4==2.27` in a fresh temporary virtual environment. The verified interpreter for this local build was Python3.12.14. Select your own compatible CPython3.12 executable: the example uses `python3.12` on PATH, or set `CORUSCANT_PYTHON_BIN` to its local executable path. This is verification setup, separate from application startup:

```sh
CORUSCANT_PYTHON_BIN="${CORUSCANT_PYTHON_BIN:-python3.12}"
"$CORUSCANT_PYTHON_BIN" --version
orbital_verify_root="$(mktemp -d /private/tmp/coruscant-orbit-oracle.XXXXXX)"
"$CORUSCANT_PYTHON_BIN" -m venv "$orbital_verify_root/venv"
"$orbital_verify_root/venv/bin/python" -m pip install --no-input sgp4==2.27
"$orbital_verify_root/venv/bin/python" --version
```

After an explicit successful source refresh and the normal build, export a private verification ledger from orbital metadata only and verify those exact bytes:

```sh
node scripts/export-orbital-verification-ledger.mjs "$PWD/.local/coruscant"
node scripts/verify-orbital-agreement.mjs "$PWD/.local/coruscant/orbital/verification-ledger.json" "$orbital_verify_root/venv/bin/python"
node scripts/diagnose-orbital-catalog.mjs "$PWD/.local/coruscant/orbital/verification-ledger.json"
node scripts/verify-orbital-persistence.mjs "$PWD/.local/coruscant/orbital/verification-ledger.json"
```

The exporter reads source metadata/hash receipts, never contacts/sessions/workflow records. The agreement harness reads the exact named source bytes, compares all valid identities against Python’s WGS72/improved implementation plus separately authored frame/observer math, and reports source hashes, regime bounds and numerical differences. The performance diagnostic copies only those newly acquired public response bytes into its own temporary app/data root and measures actual HTTP browse plus concurrent ordinary requests, then removes that temporary root. The persistence check copies only those public bytes into its own temporary app, submits one new real-evidence and one legacy-demo request through the actual customer API, then verifies separate staff reads and a graceful OS-process restart. It also checks read-only ledger export and corrupted-byte refusal within its own copy. These commands make no provider call or normal-workspace write and do not establish observational accuracy. Partial source coverage remains partial; no fixed future population or latency is promised. Raw caches and ledgers stay ignored/private.

## Try Slice9: a sourced area and saved Planning request

The existing loopback server may already be running; open a fresh tab at `http://127.0.0.1:3000/` rather than starting a second listener or replacing a tab with unsent work. Keep **Catalog → Real catalog**. On a phone, **Discover** opens the question controls and **Show discoveries** returns to results.

1. Enter an ordinary non-confidential question, for example **Visible imagery of Dublin.** Inspect the editable **Place phrase** and provider disclosure, then deliberately choose **Explore matches & find place**. Only that phrase leaves the app. Inspect the actual returned identity/coordinates; choose an appropriate candidate if several appear, correct the phrase if none is appropriate, or use the explicit manual fallback. Results are limited, not an exhaustive or guaranteed exact-place match.
2. Choose **Apply proposed location**, then **Review this mission**. The center/radius arrive in **Your request** without retyping. Inspect/correct the25km assumption and separately check **I chose this target and checked the area size.** Also try **Select area**: drag center-to-edge, inspect the preview, then cancel or **Use this circle**; Rotate and drawing are separate. **Edit coordinates and radius → Use these coordinates** is the keyboard/offline fallback. Neither a preview nor applying it confirms the size.
3. Keep **Single observation** to save without invented comparison dates. Inspect the **Baseline–recent comparison** option and its independent reference-date inputs, then return to Single if no actual comparison is intended. A genuinely new brief starts with blank dates; deliberately retained draft dates stay visible rather than being silently reset. In discovery, compare a10m and1m requirement with **Documented criteria only** off/on: native10m evidence cannot satisfy1m; unknown rows are not verified fits.
4. Choose **Review request**. If needed, follow **Open customer workspace**, choose **A Owner** or **A Requester**, and return to **Review request in this workspace** under **Demo Estuary Research**. Check **I confirm this planning brief and destination. This does not request staff review.**, then **Save planning request**. Contact and timing may remain genuinely unresolved for Planning; no staff entry is needed.
5. Note the receipt reference and **Open request in Demo Estuary Research**. Reload and return through Requests/Mission Control: the same record should say **Planning**, **Review not requested** and **No selected plan**. Saving has created no quote, actual schedule, booking or delivery. **Submit request for review…** remains a separate reviewed action with its required contact/comparison checks. This demonstrates saving without a selected plan; the implemented automatic-option path follows below.

This is a hands-on checkpoint, not final readiness. Report what you actually observed and any needed correction; Slice9 is committed after its accepted learner check; Slice10 still waits for its own actual checkpoint feedback.

## Try Slice10: automatic technical options and a saved tentative plan

The **Planning context and permissions** card identifies the currently verified role/workspace before form completion. Catalog search works in every context. A public visitor can calculate but needs explicit customer/workspace review to save; a selected Owner/Requester can calculate and save within that workspace. Viewer, Staff and customers without a selected writable workspace get applicable customer/workspace choices or **Continue as visitor**, which deliberately leaves the existing demonstration access. **Explore StarSearch as a visitor** performs that same real transition. The same-tab public brief stays; old context-owned calculations, choices and acknowledgements retire. Only the explicit server-validated public-to-customer handoff carries its exact completed choice. Private request drafts remain in their original customer/workspace/request context.


1. In **Real catalog**, describe the actual need and review its interpreted requirements. Choose a sourced location or a deliberate drawn/numeric circle, apply it, and separately confirm its size in **Your request**. Choose **Single observation** or the existing **Baseline–recent comparison**. Comparison reference dates remain independent calendar inputs; neither they nor illustrative image dates manufacture a planning window.
2. Enter an explicit future window of at most24hours and its actual timezone. Once inputs settle for300ms, the app starts the local assessment and opens **Proposed mission plan · Tentative scheduling**. Missing inputs appear inline; there is no staff or extra Generate step. A strict1m requirement may correctly return no compatible options. Leave requirements truthful rather than changing them to make a result pass.
3. Inspect catalog/matching/eligible-orbit/completed/unavailable/not-assessed counts, checked constraints, source epochs and named limitations. **Inspect object outcomes** and **Load more** cover the actual full population, independently of list/render caps. Cancel or a work limit leaves explicit incomplete coverage. No automatic best-option claim is made for partial work. Shortlisted matching identities are assessed first; this does not exclude the remaining matches.
4. A compatible optical option proposes only its checked closest instant under the documented nominal center-corridor and illumination checks. It does not establish an image footprint, whole-circle coverage, pointing or availability. SAR sensor geometry remains unresolved: **Provisional LOS window — instrument timing unresolved**. Known failed required constraints cannot be saved as a compatible plan; named unknowns require explicit acknowledgement. **View predicted position** deliberately opens the common assessment UTC and bounded arc; **Return to browsing snapshot** restores ordinary paused time. Neither action chooses an AOI, shortlists or starts Follow.
5. Inspect the exact proposed time/checks and unknown acknowledgements, then choose **Use this plan** and **Save proposed plan**. Editing the instant automatically refreshes its checks after the input settles; use stays unavailable while that check is pending or failed. A changed instant clears old acknowledgements and requires the newly checked unknowns. The final review rechecks the exact selected opportunity/window, time and destination again; another pass's interval cannot be borrowed. **View predicted position** remains a deliberate action and uses the newly checked instant. The optional processing-hours field starts blank and records only an explicitly explained personal assumption; delivery timing remains unestablished without a supported source or such an assumption. No provider promise is invented.
6. Anonymous first-save access carries only this completed public assessment through the deliberate customer/workspace handoff. Entry does not save or submit. Owner/Requester may explicitly save into their permitted workspace; Viewer cannot. The result is **Planning**, with one immutable reference and selected-plan version. **Submit request for review** is separate and applies the actual contact/comparison checks. Requests and Mission Control show the same record. Staff can inspect Planning, while it stays out of the submitted review queue.
7. On an unaccepted saved request, **Inspect technical planning options** calculates against current real source versions while keeping the original brief/evidence historical. Saving another option for unchanged requirements appends a plan version; changing requirements requires the existing explicit brief revision and invalidates the old plan. Acceptance freezes the exact selected-plan version or explicit None. New planning cannot change accepted work; use Clarifications. An authorized unchanged uncertain retry recovers its committed receipt before new-action expiry/readiness checks, even after later lifecycle changes.
8. Reload and return through the same request. To test a real restart, stop the actual listener, run the documented `npm start` with the same data root and reopen that reference. SQLite, the private manifest and signing key stay under `.local/coruscant`; never delete them. Historical saved evidence remains readable under current organization authority when source/attachment freshness expires. Expired live calculation references require a fresh assessment for a new save.

On an existing request, **Keep brief without this plan** discards only the unsaved replacement choice, including its retained selection. It leaves the durable selected-plan version and unrelated personal processing edits intact. A genuine uncertain save instead retains its original recovery action; it cannot be discarded as a new choice. Actual Thermal nighttime or near-horizon opportunities keep an unresolved collection-policy check even when the question does not say “night”; Thermal is not made daylight-only. Partial-interval coverage likewise remains a required unknown after editing the instant and through final review/save. Acknowledgement does not make an incomplete interval complete or establish provider taskability.

The implemented method uses10s samples and≤1s refinement of detected brackets, WGS72 improved SGP4/TEME, the stated UTC≈UT1 GMST approximation, a WGS84 zero-height observer and separate approximate solar direction. It can miss shorter events. Nominal ground-center distance uses a6371.0088km mean sphere; circle radius is shown separately and is never subtracted to claim full coverage. These are bounded engineering checks, not validated acquisition feasibility.

The job is one local process with a four-context waiting queue. Current limits are20,000evaluations/object,2million/job,60s execution,200opportunities/object,32MiB private artifact and100rows/256KiB per response. Every extra corridor/solar/refinement evaluation is charged. A restart interrupts unfinished jobs truthfully; completed exact manifests persist. No external model, compute account or runtime credential is added. Source refresh and optional phrase-only place lookup retain their separately disclosed network boundaries.

Fresh-public-data numerical verification uses `scripts/verify-plan-agreement.mjs` with an explicit private source ledger and the separately approved Python3.12/sgp4==2.27 environment. `scripts/diagnose-technical-plans.mjs` measures full-population outcomes and concurrent ordinary HTTP latency in a temporary isolated application. Neither script fetches sources, copies the saved workflow database or seeds approvals. Agreement with another implementation does not prove observational accuracy. Actual results, including failed runs and repairs, belong in the checklist.

## Retry the focused Slice10 corrections

Use a fresh tab on the already running local app so older unsent tabs remain available. These checks use unsaved choices; the previous full Owner save/reload/restart observation remains recorded separately.

1. In a public StarSearch brief, inspect the current role/workspace card before completing inputs. In Viewer or Staff, use the applicable customer/workspace route or **Continue as visitor**. Visitor entry must actually show Public visitor and retain the public purpose/target/timing/contact. Private request drafts remain in their original context.
2. Choose an unsaved public option as Owner/Requester, close the brief, change to Viewer and reopen. The raw brief remains, while the earlier options, choice, acknowledgements and assessment view retire. Return through a permitted context for a fresh calculation; the explicit PUBLIC→customer handoff remains a separate reviewed path.
3. If an existing Planning request still has a future original window, choose an unsaved replacement and use **Keep brief without this plan**. Reopening shows no Earlier local selection retained card; unrelated edits and the actual durable plan/version remain. If that historical window has already started, keep its saved brief/plan unchanged: inspect its original version instead, and use the isolated private-discard browser regression as the mechanical evidence. A public unsaved choice can still be discarded and reopened without saving a request. A genuine uncertain save retains its original recovery controls instead.
4. Repeat ordinary Thermal wording with the deliberately confirmed79°,15° circle, a valid future UTC window of at most24hours and compatible native resolution. Inspect any actual night opportunity: its required unresolved collection-policy check must appear without adding “night” to the question. Thermal is not daylight-only. The isolated automated partial→edited-instant→acknowledgement/save regression covers incomplete-interval evidence; no artificial partial job is needed for this hands-on retry.

Report what actually happened and anything confusing or broken. Slice10 remains unchecked/uncommitted pending that feedback; final readiness and the learning wrap-up remain separate.

## Try the first usable journey

All access is an explicit **local demonstration simulation** with fixed personas. Anyone using this local app can deliberately select a configured sample. This is not production sign-in. Server-side role, organization, session and context checks still apply to every private read and action; selecting customer access does not grant staff authority.

1. For this fictional walkthrough, explicitly choose **Catalog → Demonstration catalog** in StarSearch. Write your own question about comparing a river or estuary before and after an event. Choose **Explore matches**. **Read by local rules** shows supported fields, exact source phrases and stated/inferred/manual origins. Inspect uncertainty; deliberately edit and acknowledge reviewed filters when needed. This bounded English interpreter is not a general AI model. Choose SAR and, for example, maximum ground resolution10m. Inspect the newly authored evidence and optionally shortlist a candidate: the3m SAR record meets that threshold; the20m record does not. Unknown facts stay unknown.
2. Choose **Review this mission**. Deliberately enter the guide's circle: latitude **52.6**, longitude **−9.7**, radius **25km**. Choose **Use these coordinates**, inspect the size, and separately confirm the target. The initial0°,0°,25km values are unconfirmed defaults; deliberately applying0°,0° is valid too. A shortlist is evidence, not the chosen Earth location.
3. Choose **Baseline–recent comparison**, then enter the required **Baseline reference date** and **Recent reference date** yourself; both start blank. For an initialization origin on2026-10-21, the demonstration guide's dates are **2026-10-07** and **2026-10-14**, with **UTC** as the request timezone. `npm run demo:init` reports the persisted origin and both illustrative dates without resetting saved work; use those values if this project was first initialized on another day. These requested calendar dates do not assert acquisition. The separate request window/deadline may remain for discussion at submission, but a valid resolved window is required before quote publication.
4. Supply demonstration contact details using an `.example` address, review the brief, and follow **Customer access**. Choose **A Owner** or **A Requester**, explicitly choose **Demo Estuary Research**, then return to the final review showing that actual destination. Visiting access or selecting a workspace never submits the request. Check the Planning acknowledgement and choose **Save planning request**. This creates **Planning** with **No selected plan**, no staff-review queue entry and no quote or schedule. Open the same reference, choose **Submit request for review…**, check/complete contact and comparison dates, review the same brief/destination and explicitly submit. This separately changes the same record to **Submitted**; it creates no booking.
5. Keep the immutable **SRS-xxxxx-xxxxx** reference. Open the saved request, inspect its original purpose, comparison dates, confirmed area, evidence snapshots, contact and submission history. Reload, stop/start the app and return: the saved identity remains the same. A failed or uncertain submission retains the same logical action for an unchanged retry; an edited action needs a new review.
6. Use the separate **Staff access** entry. It selects the fixed **Staff Admin** in a separate audience; open **Mission requests** and inspect the same request/reference. Select Start review, resolve any missing planning window through Clarifications and a customer brief revision, then prepare the private draft. Saving is separate from publication; review the saved terms and explicitly confirm publication.
7. Return deliberately through customer access. **A Viewer** can read organization A's saved request but cannot submit. **B Owner** sees only **Demo Coastal Lab** and cannot read a known organization A identifier. **Multi-workspace viewer** exercises explicit A/B choice; **No-workspace sample** has no writable destination. Leave demonstration access, use Back and confirm private details remain covered until current access is checked.

The source artwork's illustrative dates are separately derived from the recorded initialization origin. Result preparation displays those supplied dates beside the accepted request dates; neither will be relabeled as a real acquisition. The separate manual delivery action refuses mismatched dates with the specified blocker. Preparing or saving a request implies no collection, review or result publication.

## Refine a need with the bounded local rules

Try `SAR imagery, maximum ground resolution 500 cm.` or `Synthetic aperture radar at .005 km resolution.` Both normalize to5m while preserving the source unit. A25km radius or500km altitude is context, not ground resolution. Unitless/partial requirements remain **Needs review**. Dates for Baseline/Recent remain blank until independently entered.

A water-expansion comparison can suggest EO/SAR/10m with an editable inferred explanation. Explicit requirements/exclusions override that suggestion; manual edits and deliberate chip clears govern actual matching and the next saved brief. Replacing prose removes old query-derived filters while keeping deliberate edits, contact, dates, area and shortlist. **Requirements and source phrases** makes their different origins inspectable. Unresolved contradictions require **Use reviewed filters** after adjustment; this cannot turn an unsupported journey into SAR.

Choose Communications, Space observation or Docker Doctor to inspect the truthful **Planned** boundary and explicit return. These do not book or run another service. On supported EO, inspect **Why shown**, missing evidence, source/version and **Documented criteria only**. Optional shortlist entries remain inspectable after criteria change; an unmatched item is labeled and never becomes proof of fit or availability. The saved request retains the reviewed interpretation and canonical evidence snapshot for both customer and staff.

## Use the synthetic globe without depending on it

**Globe view / List view** share the same criteria, evidence identities, selection and optional shortlist. Closing discovery details keeps selection. The public scene holds the recorded initialization instant **D0**, separately from the live header UTC. Its three authored tracks are **synthetic display geometry v1**, not telemetry, real orbital elements, actual coverage or provider availability. The locally served NASA Earth Observatory July2004 texture is historical context. The source/rights notice is linked in the scene; no runtime tiles, CDN or external service is needed.

Use **Pause rotation**, **Reset view** and explicit **Follow selected**; selecting alone does not fly the camera. Drag/arrows rotate the camera, wheel or+/− zoom, Home resets, and Space changes camera rotation. Represented geometry time stays fixed. **Show orbits for** changes drawing, not matching. Phone defaults to shortlist/selection only; **Orbit details** exposes actual identity, drawn-time provenance and unavailable geometry. Objects outside the declared D0±15-day span stay unavailable rather than wrapping or extrapolating.

In Rotate mode an Earth click is informational. Choose **Select area**, drag center-to-edge, inspect the proposed circle and choose **Use this circle**. Inspect the numbers and size in **Your request**, then explicitly confirm. Numeric **Use these coordinates** remains equivalent when the renderer is unavailable; neither path fills comparison dates or proves coverage. The saved brief retains the actual choice method and exact confirmed circle.

Mission detail is paused at the actual saved plan start and draws only that schedule’s tracked identities. An empty tracked list shows the confirmed target and an honest explanation; it borrows no public/shortlist tracks. Missing objects or out-of-span plans do not prevent reading the schedule, request or permitted result. Texture failure leaves plain Earth; **3D globe unavailable → List view · continue without WebGL** retains the working brief and shared-record paths. Updating an older local installation with the documented build/migrate/init/start sequence adds only missing geometry metadata; existing D0 and saved work are preserved.

## Continue through an accepted recorded plan

1. As Staff Admin, open the saved request and choose **Start review**. Questions/replies remain against that request; before acceptance an Owner/Requester may explicitly review and save a revised brief. The original submitted contact and prior revisions remain visible. Accepted work cannot be revised.
2. Set a fixed amount or range, explicit currency, demonstration scope and licence, and a future **Valid until (UTC)**. Save draft: the customer still sees no new offer. **Publish quote…** reviews exact saved terms and any offer being replaced; **Confirm publish** makes one current offer available.
3. A Requester/Viewer can read but cannot decide. Use **A Owner**, who has organization A's configured offer-selection authority, to review and accept. Acceptance records organizational intent, not payment or tasking. Confirmed success closes the decision panel and shows the saved outcome/Accepted state; an uncertain response retains the original recovery action. Alternatively, decline a separate offer with a reason; confirmed success closes that panel and returns the request to In review without closing the request.
4. Staff records the initial provider, explicit timezone and start/end within the accepted window, with optional demonstration tracked identities. Review the local/UTC span and confirm. Customer Requests and Mission Control show that same schedule. No tracked object is a valid state. A clock never delivers the result.

Unsent private terms, revisions and Clarifications stay in same-tab memory bound to their original actor, audience, workspace and request. Navigating away offers **Stay here / Keep draft and continue**. A changed brief requires fresh authoring rather than rebinding old terms; earlier unsent preparation stays read-only under its original revision. Context checks cover private content, and leaving/changing access clears old-context responses and confirmations. A failed or uncertain action retains its exact logical attempt for a safe unchanged retry.

## Track and return to the same mission

Requests has **Reference, service or place**, **All statuses** and an explicit **Apply filters**. Typing alone does not apply the search. **First page / Next page** retain applied URL filters and show at most20 actual records. Open the saved title or separate **Mission Control view**; **Back Requests / Back to request list** restores that same permitted filtered list. Invalid filters have an explicit Clear action. An empty successful result differs from a failed refresh, which keeps the last permitted snapshot labeled stale.

Mission Control's **Missions** landing uses the approved order: loaded-scope readouts → **Needs attention** with **Decisions & next steps / Upcoming windows** → **Current / Upcoming / Past**. Panels show four actual items before expansion. Counts describe all authorized loaded demonstration records, not invented all-history totals. Unavailable quote/window details are unknown. Open windows come first; an elapsed Scheduled plan moves to the awaiting-delivery presentation while its saved status stays Scheduled. A result is an independent exact link, subject to current publication/access/rights.

On an ordinary product entry a single permitted workspace opens that product; multiple memberships show the actual choice, and no membership shows a truthful empty-access state. Public prepared briefs still require the explicit named workspace review before submission. Switching products keeps the workspace; choosing another workspace goes to its product list. A requested item outside the selected context shows a neutral unavailable state with the proper permitted list.

## Prepare and inspect a supplied comparison

1. From the same accepted/scheduled staff request choose **Create result set**. Fill the result title/provider/source/uncertainty and documented licence/permitted use, then **Save result draft**. **Prepare demonstration pair** privately registers the two original synthetic1600×1000 scenes; it records no human approval.
2. Compare the accepted Baseline/Recent reference dates and request timezone with each image’s separate illustrative D0-based date and exact version. Inspect each actual scene. **Approve** records the staff actor/time/reason against the exact content; **Publish** is a separate reasoned confirmation. Descriptive correction of unpublished metadata creates a new version and clears relevant reviews. Recipe dates and origin are read-only; published metadata is immutable.
3. Write the **Finding**, **Uncertainty and limitations** and any actually used additional sources; select both exact Evidence versions and save the private draft. **Review finding…** requires the explicit checklist, including accurate disclosures. A date mismatch additionally requires acknowledgment and confirmation that authored limitations explain its actual values; acknowledgment changes no accepted agreement. **Publish finding…** separately requires current review and Published citations. **Withdraw** needs a reason and removes current customer text/citations while retaining history.
4. Enter **Access reason**, review the intended organization and rights, and **Confirm access change**. This initial grant is separate from publication and does not expose drafts. Material, Organization access and Delivery readiness summaries remain separate. The mission stays Scheduled until the separate manual delivery succeeds; no publication, grant or clock records delivery.
5. As the permitted A customer, open the exact result link from Mission Control or SatSuite’s Results library. Compare the distinct Baseline/Recent images while reading the Staff finding, exact citations, limitations and both date contexts. Pan/zoom/Fit and keyboard controls operate on the image; matching-dimension **Link navigation** synchronizes the view and does not georegister or measure imagery. Select **Point** to open **Your observations**. Place a point inside the main image, or use the keyboard X/Y controls, and enter your own nonblank note. **Start point at centre** is provisional; only Save records it. The comparison pane remains pan-only.

Original SVG geometry in `demo/source-material/estuary-scenes.ts` is freshly authored for this local demonstration; it incorporates no external images, remote references, scripts or georeferencing. Runtime copies are hash-verified private files. Thumbnail/preview responses enforce current audience, membership, organization association, rights, entitlement and publication, with private/no-store headers. The publicly reviewable synthetic source is not a security secret; these gates demonstrate application authorization, not protection against someone controlling the Mac. Missing exact bytes remain distinct from denied access and never substitute another image.

## Record delivery and return to your own observation

1. On the staff request, inspect the separate **Delivery readiness** summary. Enter a customer-visible **Delivery note**, choose **Review delivery**, and inspect the same accepted schedule, date table, required pair/finding, organization rights/access and current file checks. **Confirm record delivery** becomes available only when the complete required material is readable and the comparison labels align. It records one historical delivery and changes that saved request to Delivered; it grants or publishes nothing.
2. An unchanged uncertain retry recovers its original successful receipt before new readiness checks. Even if a finding is later withdrawn or a file is unavailable, historical Delivered remains a workflow fact; it never restores current finding or image access. **Keep draft and continue** can close an uncertain confirmation while retaining its original retry identity and note.
3. Open the exact result from the customer's Mission Control record. On the main image use **Point**, place your chosen point and enter **Observation note**, then **Save observation**. Letterboxing is not image content. Owner/Requester can edit/delete only their own notes; Viewer reads only. Tab changes retain unsent work. Image changes keep the old preparation bound to its original exact version, rather than moving it onto the other image.
4. Pan/zoom/Fit, resize, return through the same mission and reload. The saved note retains its exact image version, author and normalized point. Stop and restart the app without resetting its data: the request, agreement, plan, reviews, access, delivery and note retain their identities. A concurrent note edit requires review of the latest saved version; unsent point/text are retained rather than merged automatically.
5. For the separate strict-date case, before acceptance submit/revise a second request with Baseline one day earlier than the guide, leaving Recent unchanged. Prepare, review, publish and grant its original synthetic pair/finding with a truthful discrepancy explanation. A new delivery remains blocked with **Delivery blocked: supplied comparison dates differ from the accepted reference dates.** The request stays Scheduled and its unsent delivery note remains. Acknowledgment is not a waiver; never edit accepted dates or relabel/regenerate the artwork to pass.

## Try the final slice without resetting saved work

Leave existing browser tabs open to retain their unsent same-tab drafts. Stop only your running server in its terminal with Ctrl+C, select the documented Node24.22.1 environment, and run these commands from the canonical project folder:

```sh
npm run build
npm run db:migrate
npm run demo:init
npm start
```

Migration and initialization preserve saved requests, D0, quote/acceptance/schedule/material/access/delivery and observations. Open a **new tab** at http://127.0.0.1:3000/ to load the updated interface; an old tab can retain its unsent text while the server restarts. Do not delete `.local` or reset the database. Explore your own discovery wording/source phrases and edits, optional shortlist, deliberate globe/coordinate target, independently entered comparison dates, Requests filter/Back returns, Missions panels and exact result, accepted-work clarification, phone/keyboard behavior and awkward inputs. Your actual observations determine final fixes and readiness.

## Verify

```sh
npm run check
npx playwright install chromium webkit
npm run test:e2e
node scripts/verify-clean-checkout.mjs
```

The clean-checkout script reports its exact committed baseline, obtains only the locked dependencies in a temporary checkout, and runs the ordered setup plus a real HTTP journey/restart. It never copies working-tree changes or recording data; repeat it after the final verified commit to identify that exact release baseline.

`check` typechecks and runs the Node domain/API suite. Tests use absolute temporary data roots, not the recording database. The API suite includes actual SQLite rollback/busy behavior, direct organization/role refusals, session/context invalidation, lost-response replay and process-restart persistence. The separate-process case starts the emitted HTTP server, stops it and reopens it from another working directory using the same isolated root and opaque cookie. It verifies the durable request and receipt rather than rebuilding them from browser state.

Playwright builds and runs the current interface with a shared isolated test root on127.0.0.1:3100. Test-mode cookies use a configured-port namespace because host cookies themselves ignore ports; normal-mode access remains unchanged. Chromium/WebKit and manual keyboard/phone-sized inspection complement the learner's early hands-on checkpoint; automation does not supply the learner's observations or readiness. Test traces, screenshots and runtime material remain ignored. The [checklist](devpost/checklist.md) records actual completed evidence and later checkpoints.

## Persistence and project boundaries

The normal private runtime root is `.local/coruscant/`: `coruscant.sqlite` plus WAL/SHM, `demo-source/` generated original artwork and `material/` for private supplied versions. These paths derive from the compiled project's location, not the shell's working directory. Repeating migration/init preserves the recorded origin, definitions, IDs and saved requests; changed registered definitions refuse overwrite. Do not delete the database to hide a failed migration or unavailable asset.

The fixed demonstration sessions use opaque HttpOnly/SameSite cookies and server-held current authority. They survive a server restart until invalidated or the24-hour inactivity limit expires. Leaving, changing persona/audience or selecting a workspace rotates or invalidates the previous context. Protected records are never publicly served as files. Same-tab unsent work is memory-held; saved records persist, but closing the browser is not a durable unsent-draft feature.

`.local`, `node_modules`, `dist`, browser test artifacts, learner-profile and local credentials stay out of Git. Stage only reviewed source changes. Do not publish the local database, sessions, contact records or private source copies. Third-party asset notices remain with their permitted individual public assets.

Approved behavior and later boundaries remain in [scope](devpost/scope.md), [PRD](devpost/prd.md), [technical specification](devpost/spec.md) and the [build checklist](devpost/checklist.md). All seven slices remain subject to their actual verification and the final hands-on review in the checklist. Operational non-EO families, wider administration, notifications, deeper analysis and NEI planning remain explicitly on the retained roadmap. Hosting, pushing a public repository and Devpost submission are separate shipping work.
