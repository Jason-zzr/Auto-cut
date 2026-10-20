# Jianying draft field-level comparison

Development-only verification; Python and the vendored package are not Host runtime dependencies.
Run from `ai-video-editor/` with a Node runtime supporting TypeScript type stripping and Python 3:

```sh
node scripts/verify-jianying-draft/compare.mjs
node scripts/export-jianying.mjs --help
```

`PYTHON` may select the local Python executable. No dependency installation is performed.
The fixture supplies synthetic absolute media paths and declared metadata. The Python
reference bypasses media probing only; material/segment/script serialization uses the
vendored upstream implementation. Thus this does not validate real media probing.

Eight transition variants are compared on the same basic multi-track fixture,
including the built-in sticker represented as an editable image layer. The harness
also resolves that sticker from the current `dist/assets/stickers` tree and reads its
real PNG dimensions; project media paths and metadata remain synthetic.
Comparison includes canvas, fps, duration, all material buckets, tracks, segments and
time ranges. Random IDs are canonicalized consistently, material bucket order is
normalized and nested text JSON is parsed before comparison. Referenced material IDs
must exist. No differing semantic fields are silently dropped.

The oracle explicitly corrects one upstream serialization defect: TextSegment creates
a speed material reference but the script omits registration of that speed material.
`generate-reference.py` registers it; vendored files remain unchanged. This correction
is intentional, so this is not a byte-for-byte comparison with unmodified upstream output.

Additional checks cover reported missing media/unsupported features, invalid names,
non-macOS rejection, missing/default/explicit roots, four-file output and refusal to
overwrite an existing draft. Synthetic output is retained in the printed OS temporary
directory for inspection; it is not a playable project.

Not covered: authenticated Host HTTP requests, real project media, production packaging,
native Jianying sticker resources, advanced effect fidelity or opening the result in Jianying Pro.

## Provenance

The vendored `pyJianYingDraft` and template sources come from `jianying-editor-skill`
reference commit `32c56928ded4f9e2c2b80e099dc7abb793d2c30b`. Preserve the vendor license
and `apps/host/jianying-draft/{LICENSE,LICENSE.jianying-editor-skill,NOTICE}` when
redistributing their respective derived material.
