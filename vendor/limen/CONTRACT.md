# Picture contract

The picture is a map a cold reader takes in at one sitting: the places a project is made of, how they connect, and later which features and journeys cross them. This file is the reusable contract between three parties: the picture worker that writes the dataset, `limen picture build` that renders it, and `limen picture tick` that decides when a refresh is worth a model call.

The dataset and the rendered map are local, gitignored artifacts. They are never committed, merged, or landed onto a tip, and nothing in this contract gates spawn or land. The map is not a live feature list: a feature or journey says which places it crosses, never whether it is planned, active, or done. The board owns feature state.

Schema: `architecture-map/1`. It is the schema of the first dataset (Alice, 2026-10-02) plus the fields marked **new**.

## Dataset directory

One dataset is one directory. Default: `<project root>/.limen/picture/`, which `/.limen/` already ignores. A plant may choose another gitignored directory with `--dir`.

| Path | Role |
| --- | --- |
| `nodes/*.md` | Places: the plant root and its modules. Flat files only. |
| `edges/*.md` | Directed connections between places. Flat files only. |
| `features/*.md` | Overlay: product features. Read from the overlay slice on. |
| `journeys/*.md` | Overlay: ordered user journeys. Read from the overlay slice on. |
| `README.md` | Optional survey for humans and the worker. Not a graph file. |
| `map.html` | Rendered view. Disposable; rebuilt from the Markdown. |
| `map.json` | Optional model dump. Disposable. |
| `job` | One line: the id of the last job `tick` started. |
| `tick.lock` | Present only while one `tick` decides. Holds that pass's process id. |

The generator reads only `*.md` directly inside the graph directories. It ignores subdirectories and every other file. The file name is the id plus `.md`; dots stay in the name (`nodes/alice.runtime.md`). A missing file is a gap. Nothing invents it.

## Front matter

Each graph file starts with YAML between two `---` lines; the first line of the file is `---`. Scalars, `null`, and block lists (`- item`) only. No block scalars (`|`, `>`).

Common required fields: `schema` (`architecture-map/1`), `kind`, `id`, `project`, `title`, `status`. Optional: `sources`, a list of paths relative to the project root. Cite every project file that the body names: the tick counts a modified file only when some `sources` entry names it. Unknown keys are kept as metadata.

| Kind | Directory | Required beyond common | Notes |
| --- | --- | --- | --- |
| `plant` | `nodes/` | `parent: null` | Exactly one per project. Optional **new** `revision`. |
| `module` | `nodes/` | `parent` | A code or host boundary. Parent is a place id in the same project. |
| `edge` | `edges/` | `from`, `to`, `relation` | Directed. Never a `contains` edge: `parent` stores containment. |
| `feature` | `features/` | **new** `touches` | Overlay. Not a place and not a block. No `parent`; one is kept as metadata only. |
| `journey` | `journeys/` | **new** `steps` | Overlay. Not a place and not a block. No `parent`; one is kept as metadata only. |

**`revision`** (plant, new): the full 40-hex commit the dataset describes. It is the watcher's cursor; there is no other cursor file. The worker writes it last, after the dataset is consistent at that commit. A plant without `revision` has never been refreshed.

**`touches`** (feature, new): a block list of at least one module id. It is the only way a feature lights places. A missing list, a non-list, or an item that is not a valid id is an error (`feature.bad-field`); an id that names no module is a warning and is dropped (`feature.unknown-touch`). Never derive `touches` from Git history, branch diffs, or commit messages; it is written from the feature's own sources and the code it names.

**`steps`** (journey, new): an ordered block list of at least two place ids (modules or the plant), read as "the action crosses these places in this order". Order and repeats are kept. Malformed lists are `journey.bad-field` errors; an id that names no place is dropped with `journey.unknown-step`. The body says what happens at each step. Steps do not create edges.

An edge with a feature or journey at either end is dropped with a warning (`edge.feature`, `edge.journey`). Overlays never become blocks or edges.

`status` is `ready` (matches the cited sources), `partial` (true but incomplete; the body names the gap), or `stub` (id reserved; the body claims no behavior). Do not mark `ready` when a cited source was not read.

A trailing body line `owner: <name>`, alone on its line, is metadata, not prose.

## Identifiers and relations

Ids are lowercase ASCII, start with a letter, and use `.` between segments of letters, digits, or `-` (no leading `-`). Unique inside one project. A rename is a new id plus removal of the old file; never keep two ids for one thing.

| Relation | Meaning |
| --- | --- |
| `depends-on` | Build or import dependency. |
| `hosts` | A host process starts or holds the target. |
| `calls` | A request, IPC call, or HTTP call. |
| `implements` | The source fulfills a target seam. |
| `generates` | A generator writes a consumer artifact. |
| `reads` | The source reads data it does not own. |
| `writes` | The source writes data the target owns. |
| `composes` | The source wires the target and does not own it. |

A negative fact stays in prose ("The runtime does not depend on the adapter crate"). A feature gate stays in the edge body. Dependency arrows and runtime-call arrows are different relations; do not merge them.

## Wording

Present tense, active voice, one idea per sentence, under 25 words. No contractions, no marketing words, one name for one thing. Name the owner of each authority and what a place does not own when the source says so. Never describe a wish as a fact: a landed design, a planned edge, or a rejected transport is prose with its status, not a solid edge. Cite `spec/` for intent and code for behavior. The body is the description; do not repeat the title or copy the edge list into a node.

## `limen picture build`

Deterministic and offline. Reads the dataset, writes one self-contained HTML file that works from `file://` with no network. Never calls a model. The embedded model is `architecture-map-model/2`: `project`, `nodes`, `edges`, `features` (common fields plus `touches`), `journeys` (common fields plus `steps`), and `diagnostics`; `--json` writes the same model. Diagnostics (dangling edge, unknown parent, bad id, unknown touch or step, and so on) are listed in the view and on stderr; `--strict` exits 1 on any error diagnostic, otherwise the map still renders. Each `sources` path that does not exist in the project root is a `source.missing` warning; it does not fail `--strict`. The header names the plant `revision` and, when the project's current `HEAD` differs, says the map is behind and names that commit.

The view opens on the whole plant, with top-level places and edges lifted between them. Explore lists Features, Journeys, and Places beside the map. Search matches their ids, titles, summaries, and cited source paths. Selecting a feature or journey opens their shared level and reveals the places named in `touches` or `steps`, across collapsed boundaries. Only those places light; nested places retain parent captions. Collapsed containers show that they contain listed places; that hint is not a touch highlight. Each place shows its body, sources, edges, and the features and journeys that name it. Journey navigation preserves ordered steps, repeated visits, and steps at the plant. Place links use `#<id>`; the URL also preserves selected feature, journey, and step context for reload and browser Back. Partial and stub places look incomplete. Features and journeys remain overlays, never blocks or edges.

## `limen picture tick`

One pass, started by the project's watch when its top branch moves, or by a coordinator by hand. No loop, no intervals. The tip is the project root's `HEAD`; the cursor is the plant `revision`. With `--branch B`, the pass runs only when the project root has `B` checked out; otherwise it prints one line and stops.

1. No plant file or no `revision`: print one line saying the first picture starts by hand. Never spawn. The initial map is a coordinator decision.
2. `revision` equals `HEAD`: silent. `--dry-run` prints one line that the map is current.
3. Diff `revision..HEAD` by path and status. Drop the dataset directory, `spec/`, `docs/`, `.agents/`, and root-level `*.md` first; dropped paths never count, even when cited. A remaining path is relevant when it was added, deleted, or renamed, or when it was modified and a `sources` entry of the plant, a module, an edge, a feature, or a journey names it exactly or as a directory prefix.
4. Nothing relevant: silent. No model call. `--dry-run` prints one line that no relevant change happened. Spec-only, docs-only, and picture-only changes end here; a change to the board (`spec/build.md`) or a feature folder never starts a refresh.
5. Another live pass holds `tick.lock`: one line, no spawn. A lock whose process is gone is taken over.
6. `job` names a live job, or a job whose recorded base is `HEAD`: one line, no spawn. One tip is attempted once.
7. Engine, provider, model, or reasoning flag missing: one line naming the relevant paths, no spawn. There is no package fallback model for the watcher.
8. Otherwise spawn one detached picture job with those flags and record its id in `job`. The handoff names this contract's absolute path, the dataset's absolute directory, both commits, and the relevant paths.

`--dry-run` prints one line with the decision in every case and never spawns. The watcher never commits, merges, lands, or blocks anything, and the map's own files can never trigger it.

## `limen picture watch`

Off by default. A project turns it on from its primary checkout with `limen picture watch on --engine E --provider P --model M --thinking T`. `--branch` names the top branch (default: the branch checked out there); `--dir` names the dataset. `limen picture watch` prints the state, and `limen picture watch off` turns it off.

The watch is one `reference-transaction` hook in the repository's own hooks directory; no hook means off. It never replaces a hook it did not write, and it refuses a `core.hooksPath` outside the repository.

When a ref update moves the top branch, the hook starts one background `limen picture tick --branch <top>` in the project root and returns at once. It never delays or rejects the update. Every other ref (worker branches, worktrees, `HEAD`) starts nothing. The watch reads no job records; it sees only the branch.

The tick does not inherit the mover's Git overrides, wake routing, or job identity, so a refresh job wakes no conversation. Each move and the tick's output are appended to `<root>/.limen/picture-watch.log`.

## The picture job

The role prompt (`templates/picture.md`) holds the judgment. The contract holds these limits:

- Edit only the dataset directory named in the handoff, at its absolute path. Commit nothing to the repository.
- Read source at the named commit. Follow each relevant path to the place that owns it and one hop beyond. Update only the affected places, edges, features, and journeys; leave stable prose alone.
- Place every structural change or name it as a gap in the plant body. Never drop an unplaced path silently.
- Run `limen picture build --dir <dataset>` and fix error diagnostics. Write `revision` as the last dataset edit, then build once more so the HTML header carries it.
- The final message says what moved on the map, or that the shape did not move, and names any gap.
