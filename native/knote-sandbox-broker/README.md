# Knote Windows Sandbox Broker Prototype

This directory is a native, fail-closed Windows isolation prototype. It creates a unique AppContainer profile for each invocation, launches exactly one executable with `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`, and places the suspended process in a constrained Job Object before its first thread is resumed. It never falls back to `Process.Start`, a shell, a restricted-token-only process, or a Job-only process.

## Threat model

The untrusted task may execute arbitrary code supplied in a dedicated staging tree. The prototype is intended to demonstrate all of these controls together:

- a queried `TokenIsAppContainer` value and AppContainer SID matching the newly created profile;
- a replaced, protected staging DACL granting the AppContainer only read/execute/write, without delete, ownership, or ACL rights;
- a dedicated runtime subdirectory and executable DACL granting the AppContainer read/execute but no write;
- handle-pinned staging ancestors, stagingRoot, runtime, cwd, executable, and every existing staging entry, with final-path, reparse-tag, type, link-count, and volume/file-identity validation;
- zero token capabilities and no matching Windows loopback exemption, with no `internetClient`, `privateNetworkClientServer`, or other network capability;
- a Job attached atomically through `PROC_THREAD_ATTRIBUTE_JOB_LIST`, with `KILL_ON_JOB_CLOSE`, active-process, per-process memory, and aggregate Job memory limits, and without either breakaway flag;
- explicit stdin/stdout/stderr pipes plus `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`, so no other broker handle is inherited;
- combined stdout/stderr byte accounting that closes the Job and returns `OUTPUT_LIMIT` rather than reporting truncated success;
- timeout handling that closes the Job and therefore terminates descendants.

`isolationEnforced` is true only after the broker has pinned the staging tree, revalidated the executable identity immediately before launch, queried the child token, matched its SID, observed zero capabilities, verified no loopback exemption, verified the staging/runtime ACLs, assigned and queried the Job, and successfully resumed the child. `stagingHandlesPinned` and `executableIdentityVerified` report those two launch prerequisites. A task exit failure, timeout, or output-limit termination can still have `isolationEnforced: true`; a setup or launch failure cannot.

The host process, Windows kernel, administrators, pre-existing OS ACL grants, device/COM/registry attack surfaces, kernel exploits, denial of service below the configured limits, and side channels are outside this prototype's security claim. Before ACL application, the broker compares a validation snapshot to newly opened handles, pins the staging ancestor chain against rename, pins directories without delete sharing, and pins files read-only without write or delete sharing. It holds those handles through Job closure and root-process exit and reopens the critical names for an identity comparison immediately before `CreateProcessW`.

Enumeration and support-directory creation still resolve names rather than operating fully handle-relative to parent directory handles. Directory handles intentionally share write access, so they do not prevent creation of previously nonexistent names after the final enumeration. Pinning prevents ordinary replacement or in-place writing of existing pinned files, but it is not a defense against an already-compromised same-user process that can rewrite the sealed DACLs, manipulate the broker process or its handles, or supply new names. The caller must still exclusively own a newly created staging directory while a task runs.

## Build

Use 64-bit Windows PowerShell 5.1 or later:

```powershell
.\native\knote-sandbox-broker\build.ps1
```

The script checks its parent directory, the system x64 C# compiler, all source files, and `System.Web.Extensions.dll` before compiling. It downloads nothing. Outputs are:

- `native/knote-sandbox-broker/bin/KnoteSandboxBroker.exe`
- `native/knote-sandbox-broker/bin/KnoteSandboxProbe.exe`

`bin/` is ignored and is not source material.

## Manifest

The broker accepts no command-line task arguments. It reads one JSON object from stdin and rejects missing or unknown v1 fields:

```json
{
  "manifestVersion": "knote.sandbox-task.v1",
  "taskId": "example-1",
  "executable": "C:\\dedicated-staging\\runtime\\node.exe",
  "argv": ["--preserve-symlinks", "--preserve-symlinks-main", "C:\\dedicated-staging\\work\\task.js", "argument without shell parsing"],
  "cwd": "C:\\dedicated-staging\\work",
  "stagingRoot": "C:\\dedicated-staging",
  "timeoutMs": 10000,
  "memoryBytes": 536870912,
  "processCount": 1,
  "stdoutBytes": 65536
}
```

Paths must be absolute local-drive paths. `cwd` and `executable` must be inside staging. The executable must be in a dedicated subdirectory distinct from `stagingRoot`, and `cwd` cannot be in that read-only runtime directory. `argv` is an array and is encoded using Windows `CommandLineToArgvW`-compatible quoting; shell command strings are not accepted. Ranges are:

- `timeoutMs`: 100 through 600000
- `memoryBytes`: 32 MiB through 8 GiB
- `processCount`: 1 through 32, including the root process
- `stdoutBytes`: 1024 through 16 MiB, shared by stdout and stderr

The child does not inherit the broker environment. It receives a fixed allowlist of Windows system-path/architecture variables plus `TEMP`, app-data, home, and current-drive values redirected into staging. stdin is an explicit pipe closed to EOF. The broker writes one `knote.sandbox-attestation.v1` JSON result to stdout and uses a nonzero exit code for setup failure, nonzero child exit, timeout, or output limit.

Current Node resolves its main module through the drive root by default. Because this prototype intentionally grants no ACL outside staging, Node manifests use `--preserve-symlinks` and `--preserve-symlinks-main`; granting the AppContainer traversal or read access on `C:\` is not an acceptable workaround.

## Real-machine test

```powershell
.\native\knote-sandbox-broker\test.ps1
```

The test rebuilds both executables, verifies the Authenticode signature on `C:\Program Files\nodejs\node.exe`, copies that signed image into a disposable runtime directory, and exercises:

- normal JavaScript and an awaited `setTimeout`;
- staging write access and denial when reading a host sentinel outside staging;
- loopback and public `fetch` failure, including a host listener that detects an actual loopback connect;
- `child_process.fork` and non-IPC `spawn` unable to escape an active-process limit of one;
- a root plus descendant killed on timeout, followed by host PID checks;
- output-budget termination with `OUTPUT_LIMIT`;
- rejection of hard-linked staging input and, where junction creation is available, a staging junction;
- the C# probe's independent token/SID, staging/host, network, and Job observations.

Some Windows application-control policies or Node builds cannot initialize as a classic Win32 process in an AppContainer. `CreateProcessW` failures are returned as explicit `APPCONTAINER_RUNTIME_*` errors with the Win32 code and stage. `test.ps1` may run `KnoteSandboxProbe.exe` afterward to preserve exact diagnostics, but the Node compatibility gate still fails and the script exits nonzero. A successful probe never substitutes for the production runtime. The broker itself never performs a fallback.

## Runtime signing and integration gates

Production integration must use an Authenticode-signed, AppContainer-compatible runtime image copied into a fresh runtime directory before ACL sealing. The unsigned C# probe is diagnostic test code, not an allowed production worker.

Before integrating this prototype into Electron, require at least:

- code signing and installer ACLs for the broker and production runtime;
- fully handle-relative staging construction/enumeration for eliminating the remaining new-name window;
- cleanup/revocation policy for staging ACLs and orphan-profile recovery after broker crashes;
- a cancellation protocol in addition to the current one-shot CLI timeout;
- parser, Windows quoting, ACL, nested-Job, memory-limit, process-limit, and output-race adversarial tests;
- real Windows CI across supported Windows versions and application-control configurations;
- independent network-policy and loopback-exemption verification under enterprise policy;
- review of registry, named-object, device, clipboard, COM/RPC, and other AppContainer-accessible surfaces.

A Job-only or restricted-token-only result must never be described as complete isolation. This prototype reports complete enforcement only for the measured AppContainer + handle-pinned staging + staging ACL + zero-network-capability + Job combination.
