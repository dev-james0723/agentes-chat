# Export accepted shared memory to private files

`scripts/shared-memory-export.py` is an optional Python 3.10+ bridge for macOS or Linux and a locally installed file consumer, such as Claude Code. It reads the native Shared Memory API as the signed-in profile owner. The native profile remains authoritative. The bridge has no third-party dependency and does not import into the Claude or ChatGPT apps, edit memory facts, enroll workspaces, or claim that an agent used the files.

## Run

Use an existing authorized session. Create a dedicated directory with mode `0700` and pass the existing private Netscape/Mozilla cookie jar with mode `0600`, owned by the account running the bridge. The jar is read in place and is never copied, exported, rewritten, or saved. Standard-library cookie handling enforces its domain, path, expiry, and secure-cookie restrictions. Do not put credentials on the command line, in a repository, or in task logs. The script does not obtain credentials or perform sign-in.

```sh
python3 scripts/shared-memory-export.py \
  --base-url https://app.example.com \
  --org-id 00000000-0000-4000-8000-000000000001 \
  --cookie-jar /private/operator/owner.cookies \
  --output-root /private/operator/shared-memory \
  --prefix PERSONAL \
  --core-key personal.core \
  --record-receipt
```

The prefix and core key are examples. Use the exact logical key of the accepted core entry. HTTPS requires ordinary certificate validation. Plain HTTP is allowed only for loopback addresses and `localhost`. The base URL is an origin without an API path. Redirects and environment proxies are disabled, so a redirect cannot forward the session cookie to another origin. A `401` or `403` stops the run without attempting another authentication route.

`--cookie-file` is an alternative only when an existing authorized integration already supplies a private raw Cookie-header value file. It is mutually exclusive with `--cookie-jar`. A jar does not need to be converted into a header file. Both formats remain local.

Each run produces:

| File | Contents |
| --- | --- |
| `PERSONAL-MEMORY.md` | Every readable accepted active fact, with dates, assertion type, privacy classification, and registered source coverage |
| `PERSONAL-CORE.md` | The exact current core content, without an added heading or newline, at most 600 Unicode characters |
| `CLAUDE-IMPORT.md` | A prepared manual import file with the same accepted facts and source coverage; no native import is performed |
| `PERSONAL-MANIFEST.json` | Profile and source-availability revisions, file hashes, check time, readable and unavailable counts, and whether a readable active core existed |

Forgotten, rejected, disputed, candidate, historical, and source-withdrawn fact bodies are excluded. The export reports how many active facts were unavailable rather than presenting the readable subset as the entire profile. The source inventory retains provenance metadata, including capture dates and coverage statements, so an old source snapshot is not presented as newly refreshed evidence. If the core is absent, forgotten, or unreadable, the core file is replaced with empty bytes. A core longer than 600 characters stops the run before changes; the bridge never truncates it.

## Consistency and privacy

The bridge follows all cursors, verifies the native total, rejects repeated IDs/cursors, and pins one profile identity, content revision, and whole-profile source-availability revision across every page and a final read. Source metadata is also checked. The availability revision detects a withdrawn source on an earlier page even when no memory body changed. It does not scan the old unpaginated context-item endpoint. A changing or incomplete snapshot leaves the previous exports intact and exits unsuccessfully. The current limits are 50 pages of 200 records, 16 MiB per response, 64 MiB total transfer/rendered output, a 15-second socket timeout, and a 120-second run deadline checked while reading. Network timeouts are bounded, but a run can finish a pending socket read after the overall deadline.

An exclusive lock covers the complete run. Files are staged privately, flushed, atomically replaced, and followed by a directory flush. Every file is `0600`; the output directory must be `0700`. The core is replaced first and the manifest last. The bundle is not a multi-file filesystem transaction: a crash between replacements can leave a mixed bundle. A consumer that needs bundle consistency must verify each manifest hash before use. The next successful run repairs all files. No completion receipt is sent for a partially written or changed bundle.

The bridge reopens the final files without following symlinks, checks their permissions, and compares exact bytes and SHA-256 hashes. Standard output contains only revision/count/hash metadata. Error messages do not print credentials, response bodies, or memory content. Files and the cookie remain private; do not serve the output directory through a public website.

With `--record-receipt`, the bridge rechecks both native revisions and the exact local files, then records a `kind: file` receipt bound to both revisions. A current receipt means those files were verified at that revision and check time. A later source withdrawal makes that receipt stale even if the profile's content version is unchanged. It proves neither a native Claude/ChatGPT import nor actual agent retrieval. The receipt advertises no continuous write connection. A receipt request that times out may have completed; it is not automatically retried, and the run reports no confirmed receipt. Without this flag, native state is read only.

## Scheduling and consumers

Point the intended file consumer at the exported files using its supported configuration. A scheduled run may use the same command under the same user account. This script does not install a scheduler or alter consumer configuration. Treat a nonzero exit status as stale or unconfirmed output, retain the last verified manifest, and inspect the concise error. Refresh an expired session through the normal sign-in flow.

Use one output directory per profile and prefix. `CLAUDE-IMPORT.md` has a fixed name, so two profiles must not share a directory. Forgetting a fact removes it from these generated files on the next successful run; it does not erase prior manual imports, archived files, backups, or another consumer's memory. The Portal tracks those external removal obligations separately.

## Transition from a previous native writer

Retire a previous sync writer only after verified native adoption and destination enrollment. Keep only one native fact writer enabled during the transition.

1. Pause the previous writer's schedule before migration. Preserve its existing receipts for comparison.
2. As the profile owner, explicitly adopt the existing canonical facts and enroll the intended eligible workspaces with the chosen privacy categories. Check the current native item identities and any adopted replica mappings.
3. Reconcile through the native engine. Verify the expected accepted facts, destinations, and copy revisions, with pending work and conflicts resolved or explicitly accounted for. Actual agent retrieval remains a separate check.
4. Run this bridge and verify the private files, exact core, and manifest hashes. Check the intended file consumer's supported file configuration. An optional file receipt acknowledges this step only.
5. After those checks pass, retire the previous writer and its old schedule, then schedule this read/export bridge as needed. A failed migration is a reason to inspect the native state and receipts before enabling any previous writer again.

This transition does not authorize or perform writes to native ChatGPT or Claude memory. The prepared import file remains a local artifact until a separately authorized provider import occurs.

## Offline checks

```sh
python3 -B -m unittest discover -s scripts -p 'test_shared_memory_export.py'
```

These tests use synthetic records and mocked HTTP. They cover stable pagination, deletion and exact core behavior, private atomic writes and locks, credential boundaries, and file-only receipts. They do not contact a production service or a native provider.
