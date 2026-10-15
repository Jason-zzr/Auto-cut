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
  --runtime-sha256 ACTUAL_EXECUTABLE_SHA256
```

Use actual reviewed values instead of the placeholders. The default is `--mode sea`.
SEA requires the same Node binary version for preparation and injection, and
disables snapshots/code cache. It bundles the host while keeping web resources
as normal files. Missing postject is an explicit error, not an automatic download
or silent fallback. Review official Node and postject instructions before the
separately authorized signing step.

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

`package-manifest.json` records runtime identity, provenance, signing-not-performed
status and per-file byte hashes. Signing changes executable bytes; this manifest
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
