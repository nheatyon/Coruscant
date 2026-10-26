---
status: draft
reviewed_on: 2026-10-26
review_kind: technical-publication-preparation
baseline: 067cf5050c68cfa53d4d0470f9908c93f5fb675a
---

# Public repository preparation review

This is a technical audit draft, not publication approval, a license grant, a learner submission, or evidence that a repository has been created or pushed. Slice10's accepted checkpoint, final build review and five correction items are closed: the reviewed implementation is committed as `067cf5050c68cfa53d4d0470f9908c93f5fb675a`, and its exact committed clean-checkout V17 passes. The complete project/browser evidence remains in [the execution checklist](checklist.md). App-map and recap checks are being completed separately; video, public-repository authorization and submission are not inferred.

## Files and history inspected

The review covered Slice10's 63 committed paths, the 260 currently tracked paths and all ten commits reachable from local Git refs: 778 reachable objects, including 550 distinct file blobs. Of those blobs, 546 were text and four were the approved static Earth JPEG and three IBM Plex font binaries. The updated publication review, new `app-map.html` and new `recording-checks.md` were also checked outside committed history. No history or index was modified; the index was empty at inspection. Application/test source is unchanged from the verified Slice10 commit; post-commit checklist and review-document updates remain separate.

No learner profile, runtime database/WAL, session store, local credential file, signing key, private assessment manifest, protected supplied material, raw orbital response, place cache, browser trace/screenshot or unrelated agent/curriculum directory appeared in reachable tracked history or the intended inventory. The learner's reported QA record identifier/reference was absent. Scanned source contacts used fictional `.example`/`.test` domains. Signature checks found no private-key blocks, common provider-token formats or credential-like JWTs. This is a bounded source/history inspection, not a guarantee about every possible secret format. The normal database and private material were not opened.

The ignore rules retain learner-profile, `.env` variants, `.local`, dependencies, compiled output and browser artifacts outside commits. Unrelated untracked agent/skill folders remain outside the intended inventory. They must not be added by a broad staging command.

## Attribution and dependency boundary

The intended changes add no runtime dependency or new external source integration; `package.json` and its lockfile are unchanged. Existing direct package metadata records MIT, ISC and Apache-2.0 licenses. The Python3.12/sgp4==2.27 environment remains separately documented verification tooling, not an application service.

[THIRD_PARTY.md](../THIRD_PARTY.md) distinguishes library licenses, factual summaries, CelesTrak usage limits, phrase-only Nominatim use and numerical verification. [Asset provenance](../assets/ATTRIBUTIONS.md) records the original synthetic scene recipes, exact acquired font/Earth files and hashes. Complete IBM Plex OFL notices remain beside the font binaries; the NASA credit/use notice remains beside the unchanged Earth texture. The satellite.js distributor license is retained separately. None of these assets is silently relicensed as application code. Raw provider caches and private verification ledgers are excluded.

The original application, documents and synthetic demonstration artwork do not yet have a declared public distribution license. The owner must choose whether to publish with a particular license or retain reserved rights, and which original materials that choice covers. Existing third-party notices and their separate terms remain applicable. This review does not choose a license or assert legal clearance.

## Git publication choices

No Git remote is configured. All ten commits use the same auto-detected local-machine author/committer identity rather than a GitHub noreply identity. A public push of this history would expose that metadata. Historical planning Markdown/HTML also contain absolute local home/source-reference paths. They do not expose the learner profile or source credentials, but would disclose local filesystem context and some links would not resolve in another checkout. Review whether to retain that material and what identity to use for future commits; changing existing history is a separate explicit decision. No identity, remote, repository visibility or history was changed by this audit.

## Setup portability

[README.md](../README.md) targets the agreed macOS loopback application with exact Node24.22.1/npm11.19.1 pins, locked installation, ordered build/migrate/init/client steps, one same-origin server and a fresh real-source unavailable state until deliberate refresh. It does not require the author's home directory, copied private runtime data, an API key or a real account. The nvm commands assume nvm is already installed; an official matching Node installation is also described. Verification examples using `/private/tmp` are macOS-specific, consistent with that target, rather than a cross-platform support claim.

Initial package/asset/browser acquisition and optional source/place requests require the disclosed network access. Cached local operation and protected workflow persistence have separate documented limits. Setup commands were inspected here, not rerun. The accepted learner retry and passing exact committed-checkout verification are recorded separately; this audit neither reruns them nor substitutes for the remaining publication and submission decisions.


Closeout synchronization: the actual evidence-based recap and checked/shown offline map are now recorded complete in the canonical checklist. The map is linked locally; the automation browser blocks file-protocol opening, while isolated offline/render verification passes. Recording preparation now reflects completed build gates and still claims no footage/upload/submission. The only post-067cf50 changes are these technical review/map/progress documents.
