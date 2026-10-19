# Auto-cut local packages

Development remains `npm run host` with an existing reviewed `dist`. Packaging
uses the same launcher/host and a separate entry that resolves resources inside
the application. It does not depend on the launch working directory or the
user's Node installation.

## Inputs and limits

- Build on macOS arm64 or Windows x64 using Node 24. The supplied runtime must
  match the build process's exact Node version, architecture and platform.
- Supply an existing reviewed web `dist`, a trusted Node executable, its actual
  SHA-256, the runtime's full license/third-party notices, and its provenance URL.
  The builder compares bytes with the supplied digest; it does not authenticate
  a user-supplied digest or verify the provenance URL remotely.
- esbuild 0.25.12 is pinned. Default SEA mode additionally requires the reviewed
  local `postject` package. No tool downloads dependencies or Node automatically.
  postject 1.0.0-alpha.6 is pinned after explicit dependency approval.
- Every output directory must be new, with an existing parent. Existing outputs
  are never replaced. Failed output stays for diagnosis; choose a new output
  directory for a retry. No user project or machine data is included.
- These scripts prepare local artifacts. They do not install, publish, notarize
  or sign them. On macOS SEA preparation removes the signature only from the
  new executable copy; that copy needs separately authorized signing before use.

## Host bundle

```sh
npm run build:host -- --out /absolute/new-bundle
```

The output includes `host.cjs`, an esbuild metafile, the application's license,
and the license/notice files found in bundled dependency roots. `dependencies.json`
lists included package versions and collected notice paths. Empty notice lists
or missing license metadata require review before redistribution; a manifest
alone is not a license clearance. This list covers the host, not all web assets
or models. Web dependency/font notices remain a separate distribution obligation.

The bundle expects its web files at `dist/` beside it. A standalone bundle still
needs Node; it is an intermediate artifact, not the end-user installation.

## Directory package

```sh
npm run build:package -- \
  --out /absolute/new-package \
  --dist /absolute/reviewed-dist \
  --runtime /absolute/matching-node \
  --runtime-license /absolute/NODE-LICENSE \
  --runtime-source https://nodejs.org/dist/v24.X.Y/ \
  --runtime-sha256 ACTUAL_EXECUTABLE_SHA256 \
  --scene-component /absolute/reviewed-scene-component \
  --visual-search-component /absolute/reviewed-visual-search-component
```

Use actual reviewed values instead of the placeholders. The default is `--mode sea`.
SEA requires the same Node binary version for preparation and injection, and
disables snapshots/code cache. It bundles the host while keeping web resources
as normal files. Missing postject is an explicit error, not an automatic download
or silent fallback. Review official Node and postject instructions before the
separately authorized signing step.

`--scene-component` is optional. When supplied, it must be a local, complete
Auto-cut SceneDetect component for the build platform. The builder verifies its
manifest, exact Python/PySceneDetect/OpenCV identity, imports, complete file
inventory, per-file SHA-256 values, license files and absence of links before
copying it to `resources/components/scene-detect`. It does not create a Python
environment, install packages, download files or fall back to PATH. Omitting the
option produces a package whose scene-analysis capability reports missing.

`--visual-search-component` is optional and follows the same no-download rule.
When supplied, it must be a complete component for the build platform with a
managed Python executable and adapter, exact package provenance/digests,
license files, and a locally present `openai/clip-vit-base-patch32` model. Its
manifest locks the model and processor commit revisions, every model file,
their aggregate digest, float32 precision and 512-dimensional output. The
builder verifies the complete link-free file inventory before copying it to
`resources/components/visual-search`; it does not install Python packages,
fetch model files, or test retrieval quality. Omitting it leaves visual search
unavailable while projects, saved scripts and manual editing remain usable.

The component root contains `component-manifest.json` with schema version 1,
component `autocut.scene-detect-runtime` revision `0.2.0`, tool
`autocut.scene_detect` revision `0.2.0`, target `platform`/`arch`, an exact
`python.version` and relative `python.executable`, package provenance/digests,
non-empty relative license paths, and every other file's relative path, byte
size and SHA-256. The reviewed package set for this revision requires
`scenedetect` 0.7.2 and `opencv-python` 4.14.0.94. The manifest itself is excluded
from its file inventory. All paths use `/`, stay inside the root and resolve
without symbolic links.

On macOS, a universal Node input is thinned to arm64 in the output copy before
injection, so postject sees a single SEA sentinel. The input runtime is unchanged.

For the architecture's explicit fallback, pass `--mode runtime`. It copies the
supplied runtime beside the same `host.cjs`. Record why SEA is unsuitable before
choosing this as the distribution mode. Testing this mode does not prove SEA.

macOS output is `Auto-cut.app`: SEA or a runtime launcher in `Contents/MacOS`,
web/bundle/notices in `Contents/Resources`. Runtime mode clears `NODE_OPTIONS`
and `NODE_PATH` before executing its bundled Node. Windows output is `Auto-cut/`,
with SEA at the root or runtime under `resources/runtime`. The generated installer
definition selects the appropriate shortcut target without searching PATH.

`package-manifest.json` records runtime plus optional SceneDetect and visual-search
component identities, provenance, signing-not-performed status and per-file byte hashes. Signing changes executable bytes; this manifest
describes the pre-signing artifact and must not be used as a signed release digest.

## macOS DMG

After separately completing the intended signing/acceptance work:

```sh
npm run build:dmg -- --app /absolute/Auto-cut.app --out /absolute/new-Auto-cut.dmg
```

This invokes the system `hdiutil` without mounting, installing or notarizing the
image. An unsigned local-test DMG is not a notarized release. No minimum macOS
version is invented; the tested OS/runtime/browser combination must be recorded.

## Windows installer

Build the directory package on Windows x64. In its output directory, compile
`Auto-cut.iss` using a reviewed Inno Setup 6 installation (6.3+ for architecture
identifiers). `package-defines.iss` is generated from the application version and
explicit package mode. The installer targets Windows 11 x64, installs for the
current user under `LocalAppData/Programs`, and does not delete machine data or
projects. Close the service via its UI before upgrading/uninstalling; the installer
does not force-kill processes. Windows runtime shortcuts launch the bundled Node
directly and may show its console; native GUI launcher polish is not yet supplied.

## Acceptance still required

Record source revision, Node/browser/OS versions, input hashes, mode and signing
state. Verify relocated paths (including spaces/Chinese), startup/reopen/exit,
resource failures, HTTP access boundaries, original resources/Workers and actual
installation/uninstallation on each target. Isolated fixture HTTP tests do not
prove browser rendering, Windows operation, signed distribution, complete project
save/open or the full product acceptance matrix.

References: [Node SEA](https://nodejs.org/docs/latest-v24.x/api/single-executable-applications.html),
[postject](https://github.com/nodejs/postject),
[Inno architecture selection](https://jrsoftware.org/ishelp/topic_setup_architecturesallowed.htm),
[non-administrative installation](https://jrsoftware.org/ishelp/topic_setup_privilegesrequired.htm).
