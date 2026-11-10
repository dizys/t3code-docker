# Custom services

Custom services are part of the first Services release. A person can register a program installed through mise, another executable they can access, or an explicitly chosen shell script, then monitor and manage it through the same Services surface. Catalogue membership is not required.

This extends the earlier curated-only proposal. The restriction on arbitrary root services remains. Custom code runs with the same OS account permissions as a T3 terminal, ordinarily `t3`; it is not sandboxed from that user's files, projects or other same-user processes.

## One surface, explicit ownership

| Kind | Definition and installation | Execution boundary | Management |
| --- | --- | --- | --- |
| Catalogue service | Reviewed definition; verified protected artifact when required | Reviewed fixed privilege profile | Shared lifecycle, logs, health, dependencies, updates and removal |
| Custom service | User command; installed mise tool, accessible executable or explicit script | User account only | Same lifecycle, logs, health, dependencies and configuration review |
| External service | Host/Compose/native owner | Existing external owner | Status and route integration; no competing local supervisor |

Rows use a quiet **Custom** label and show the execution account in details. Do not call a user-writable mise installation a verified system artifact. A custom service can reference the same network/route model as other services, subject to protocol and capability requirements. It does not become privileged by attaching a route.

## Execution architecture

Use the same supervision engine and policies through a user-account worker. The root side launches only an image-owned fixed worker through a reviewed privilege-drop path. Complete UID/GID/supplementary-group/capability and environment setup before loading user definitions, resolving mise configuration, checking executable paths, evaluating hooks, or opening a user-defined working directory. The effective and saved privilege state must prevent regaining root.

Custom argv, scripts, working directories and environment do not cross the privileged command API. The authenticated Setup layer sends them to the user worker. Root handles only its own allowlisted service definitions and any fixed worker lifecycle. A forwarded command that is supposedly dropped later is not an acceptable implementation.

If s6 scan trees/run files are used, user-writable definitions must be read and executed by the user-owned tree. A root-owned supervisor must never execute a user-writable run script before dropping privileges. One service still has one owner; separate privilege domains do not justify two restart loops for the same child.

Use distinct durable stores with unambiguous namespaces, not competing copies of the same state:

- System controller: protected system-service authority under `/var/lib/t3code/services/`.
- User worker: custom definitions, revisions, operations and bounded logs in the persistent T3 data home, for example `/home/t3/.t3/setup/services/user/`.
- Setup: authenticated projection of both stores into one resource model, with source/owner and operation namespace preserved.

The privileged API cannot adopt a user-defined ID, definition or path as a trusted system service. Source/profile labels from a caller are never authority. A user cannot submit a custom definition with `runAs: root`, extra capabilities, host mounts or a privileged listener and have it accepted by changing metadata.

Custom services work in supported rootless deployments and do not require the protected system-services volume. Their own definitions, selected tools and working data still need persistent mounts for recreation. A missing user-data mount gets a truthful persistence remedy. Custom-worker/child exit policies must not propagate a normal failure into core T3 shutdown. Custom code still shares the user's OS permissions and container resources; supervision does not provide hostile-code or out-of-memory isolation. Strong isolation requires a separate OS/container boundary.

## Commands and environment

Three explicit launch modes:

1. **Installed tool:** choose a tool and exact installed version, executable and argument list.
2. **Executable:** choose an accessible executable path and argument list.
3. **Shell script:** explicitly choose a shell and enter a script. Mark this mode clearly because expansion, pipes and redirects execute user code.

Direct executable modes pass an argv array without a shell. Preserve spaces, quotes, empty arguments and Unicode. A readable quoted command preview is a presentation, not the parser. Do not split a free-form command on spaces or reinterpret `$()`, pipes, globbing or shell metacharacters. Offer a token editor and an advanced argv representation that can express empty strings. The prototype's one-argument-per-line editor illustrates the simple case.

Run foreground processes. Explain flags such as a program's no-daemon mode where known. Do not adopt arbitrary PIDs or a daemonized grandchild from a user-written PID file. If the parent exits, record its actual exit and follow the declared policy. A successful one-shot exit is **Exited (0)**, not a healthy running service. Scheduled jobs are a separate future feature, not an implicit restart loop.

Construct a minimal user environment and add only selected tool paths, explicitly entered values and selected secret references. Never inherit the controller's full environment or inject Setup credentials and all Vault/agent sign-ins. Custom child environment cannot modify the worker's own control paths, socket policy or privilege setup. Service-specific `HOME`, library or runtime variables, if supported, affect that child only.

Vault variables use named references and existing Vault authorization. Show the variable name and reference label during review, not the resolved value. Editing unrelated fields never reveals/replaces a saved secret. Removing or rotating a referenced credential participates in dependency planning. Custom code can print its own secrets; redaction of known values is useful but cannot guarantee arbitrary application output is secret-free. Logs and exports need authenticated access, retention limits and a preview.

## Mise integration and ownership

Default to **Pin installed version**. Selecting `python@3.13.2` means that exact installed tool remains the service's dependency even if the interactive project default becomes another version. Resolve the executable and required tool environment as the user and save the source/receipt used for the run. Do not install, update or trust project configuration as a side effect of merely inspecting a service.

Default execution resolves the explicitly selected installations without implicitly trusting or running project `.mise.toml` hooks. **Use project environment** is a separate option that shows the affected configuration and trust/hook behavior before activation. The implementation must prove how its mise version obtains an isolated installed-tool environment. Do not invent unsupported mise flags to claim project evaluation was disabled.

Some commands need several tools, such as a package manager plus Node. Allow a typed set of exact tool dependencies and a deterministic PATH order. Keep the UI simple for one tool and expose additional runtimes as an advanced section. Do not assume the first executable is the whole dependency closure.

Services and Toolchains share references and operation locks:

- Updating the interactive default does not silently switch a running/pinned service.
- Tool removal or cleanup lists dependent custom services and blocks removal until they are moved, stopped with references explicitly released, or removed. Retaining a disabled service's version dependency is explicit; disabling alone is not permission to erase its tool.
- Switching service versions uses a review with affected processes, configuration and rollback limits. Reuse the supported tool installer/updater rather than running a second mise installation.
- External/manual deletion or mutation of the selected installation is **Tool unavailable** or **Tool changed**. Do not fall back to latest or silently reinstall. Stop repeated failure and offer Choose version or Reinstall through Toolchains.
- User-writable tool/project bytes remain mutable. A pinned version is not immutable code or an atomic application snapshot. Show the actual executable/version observation and avoid promising rollback of source code, dependencies, database writes or other application data.

## Create and manage

**Services → Add service** offers **From catalogue** and **Custom service** as equal clear choices. Catalogue browsing stays compatible with its existing Available view. Rename the shared first view to **Configured** because a registered custom service may not install anything. Search includes custom name, command and tool; Needs attention includes missing tools, exhausted restarts and failed health checks.

Custom setup:

1. **Command:** name, launch mode, selected tool/version or executable/script, arguments, working directory. Browse the actual installed inventory. Explain empty inventory and link to Add a tool, preserving the draft on return. Treat inventory and path checks as read-only.
2. **Behavior:** Enable after adding, restart policy, optional health check, environment/secret references and advanced shutdown/log settings. Enabling starts the service now and on container startup. Leaving it unchecked creates a disabled service.
3. **Review:** exact command/argv, account, directory, pinned dependencies, startup/restart/health policy, selected secret names, retention, and network exposure. Primary **Add and enable**, or **Add service** if creating disabled. No arbitrary root option.

Backend validation resolves exact installed references, filesystem access, directory/executable availability, occupied declared endpoints and current revisions. A validation failure preserves the form and focuses the relevant field. A syntax/path check is not proof the application can start. Launch is a durable operation and becomes Running only after observation.

Inspector sections share the existing shell: status and freshness; run-as/source; exact command and tool references; working directory; startup/restart policy; health; declared endpoints/routes; recent operation; logs and actions. Custom-specific actions are **Edit configuration**, **Restart**, **Stop for now**, **Enable/Disable** and **Remove service**.

**Stop for now** cancels pending restart attempts and suppresses restarts for the current container run. An enabled service resumes at the next container start; say this explicitly. **Disable** persists off and stops it. **Remove service** unregisters it after stop and route/dependency review, retaining application files, installed tools, Vault entries and unrelated services. It is not an uninstall command. Data deletion and tool removal are separate actions.

Editing first creates a revisioned candidate. Name-only changes need no process restart. Command, directory, environment or launch-policy changes state their restart impact. Validate before stopping the old run; never start two copies against the same port/data directory to fake seamless validation. On failure, restore the previous configuration when possible and report what actually recovered. A custom application may have irreversible side effects, so configuration rollback is not an application-data rollback guarantee.

## Health, logs and networking

Default: **Process only**, displayed as **Running · No health check configured**. Do not imply readiness merely because a PID exists. Optional HTTP/TCP checks target declared local endpoints, with bounded time/body limits, intervals and initial grace. Optional executable checks are explicit user commands run by the same user worker. Probe execution never uses the root broker.

Separate Running, Starting, Unhealthy, Restarting, Failed, Exited, Stopped for now, Disabled, Tool unavailable and Status unavailable. A health failure marks Unhealthy by default; it does not automatically restart a process forever. Restart-on-unhealthy is a separate reviewed policy with a crash budget. Process exit retries also use bounded backoff. Manual stop wins over every pending retry.

Logs separate stdout/stderr, timestamps and run IDs, with tail, pause/resume, search and bounded history. A disconnected viewer resumes from a cursor or shows a gap. Byte/event budgets, rotation and overflow behavior prevent a noisy child from exhausting disk or blocking T3. Use OS-backed PID/start/run identity and owned process groups, not arbitrary disk PIDs, to stop descendants. CPU/memory numbers are observations when available; hard per-service limits are offered only if the deployment can enforce them. Do not present unsupported cgroup limits as applied.

Declaring a port or selecting a local HTTP health check does not publish it. Bind-address guidance, Ports integration and explicit connection/route creation determine external exposure. Reuse existing tunnel ownership and protocol rules. Avoid adopting or exposing running terminal/MCP processes automatically. A later explicit adoption feature requires a handover proof.

## Required evidence

The custom-service acceptance rows cover real amd64/arm64 and core/browser images, supported rootless mode, privilege-drop attacks, user-data recreation, exact mise selection and tool retention, safe argv/shell behavior, environment/Vault handling, missing-tool/config cases, durable operations, owned shutdown, health/retry behavior, logs/backpressure, network exposure, and accessible creation/edit/removal.

The interactive reference simulates adding and managing an installed Python preview. It executes no command, installs no tool and resolves no Vault secret. Production trust, process and mise guarantees remain open until tested.
