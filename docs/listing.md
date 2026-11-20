# Public listing contract

Curator's listing follows the current [Paseo publishing guide](https://paseo.sh/docs/plugins/publishing.md), checked on 2026-11-20. `OVERVIEW.md` supplies the install decision: benefit and cadence first, requirements/setup, security/data, then storage and limits. The Git manifest and npm package share one outcome description. No version, review date, install count or source detail has been invented for the overview.

## Verified upstream sources

- [Runtime manifest validator](https://github.com/getpaseo/paseo/blob/27c126d352c4544c6a8f43251527d61228b8d12f/packages/server/src/server/plugins/manifest.ts): PNG icon path; `media` is an array of strings containing package-relative paths or HTTPS URLs. It does not accept objects with `src`, `caption` or dimensions.
- [Registry metadata resolver](https://github.com/getpaseo/plugins/blob/937f58f6d98b9bb8791e20e92758323cf78b6614/scripts/lib/metadata.ts): relative Git media becomes a URL at the reviewed artifact commit; registry listing overrides take precedence. Git uses the manifest description; npm uses the package description.
- [Registry media validation](https://github.com/getpaseo/plugins/blob/937f58f6d98b9bb8791e20e92758323cf78b6614/scripts/lib/media.ts): HTTPS images need PNG/JPG/JPEG/WebP/GIF extensions; video supports MP4/WebM. Online checks require HTTP 200 and an image/video content type. The first image is the listing thumbnail per the publishing guide.
- [Published listing construction](https://github.com/getpaseo/plugins/blob/937f58f6d98b9bb8791e20e92758323cf78b6614/scripts/lib/listing.ts): artifact version/source, repository and review timestamps come from the registry record. `updatedAt` is the approved review date. Devices is a layout reference, not evidence for Curator.
- [Native plugin detail renderer](https://github.com/getpaseo/paseo/blob/27c126d352c4544c6a8f43251527d61228b8d12f/packages/app/src/plugins/gallery/plugin-page.tsx): the header uses `listing.icon`, the carousel uses `listingImages(listing)`, and overview text comes from the registry detail. A local-directory manifest does not supply that listing.
- [Node 22 SQLite history](https://github.com/nodejs/node/blob/v22.x/doc/api/sqlite.md): `node:sqlite` was added in 22.5.0 and exposed without `--experimental-sqlite` in 22.13.0. The package engine and lock now reflect the unflagged minimum; CI exercises current Node 22 and 24, not every patch release.

The manifest uses local `assets/native-*.png` strings so Git and package installs ship the same media. `tests/listing.test.ts` checks package inclusion, image signature/dimensions and decompressed RGB data, matching descriptions/runtime requirements, and important overview/README disclosures. Existing icon PNG and SVG source remain shipped.

## Remaining acceptance gaps

- No existing applied activity row could be reached in live history. The **Self-improvement review — updated …** screenshot is missing; no synthetic evidence is supplied.
- A local-directory details page does not consume these overview/media/icon fields as a reviewed registry listing does. Native settings were captured, but the full registry header/carousel/overview/details rendering has not been verified for this revision.
- Registry review must approve a pinned artifact and may override listing text/media. This work does not update the registry submission or post a review reply.
- Review agents retain provider-native tools, including writes and commands. Structured-operation checks do not confine those tools. Acceptance of that posture remains a registry decision.

See [capture provenance](screenshots/README.md), [routing details](routing.md), and the [documentation index](README.md).

## Public screenshot URLs

Both PNGs are committed in asset revision `687ffeb0b8f2b854d82d5e82b83e28020cdcd978`. These HTTPS URLs pin that exact revision rather than a moving branch:

- [Native routing settings](https://raw.githubusercontent.com/vicpon/paseo-curator/687ffeb0b8f2b854d82d5e82b83e28020cdcd978/assets/native-routing-settings.png)
- [Native provider menu](https://raw.githubusercontent.com/vicpon/paseo-curator/687ffeb0b8f2b854d82d5e82b83e28020cdcd978/assets/native-routing-providers.png)

The manifest retains package-relative media paths; the registry resolves those at its approved artifact commit. These direct raw URLs are also suitable for a later registry review reply. No reply has been posted.
