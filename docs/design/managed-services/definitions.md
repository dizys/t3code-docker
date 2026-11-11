# Definition and controller contract

Proposed internal contract. Names and example values below illustrate the boundary; they are not an implemented API or a finalized schema.

## Trusted definitions and optional payloads

Separate three things that might otherwise be called a formula:

1. An image-owned service definition describes behavior, allowed configuration, privilege and lifecycle policy.
2. A signed artifact catalogue resolves approved exact versions to immutable architecture-specific payloads and their verification metadata.
3. A user-selected instance supplies typed configuration and references to credentials, connections and artifacts.

The user opts into the installation through a task such as Set up SSH. Mise owns the image-approved HTTP packages in an isolated root-owned store inside the Services volume. A trusted adapter unpacks Debian package data without maintainer scripts. User and project config, hooks and plugins are excluded from privileged Mise commands. Normal Mise tools remain unprivileged. Reuse the existing catalogue presentation, operation patterns and install receipts where suitable; keep privileged execution and protected storage separate.

A reviewed generic user-process adapter supports arbitrary custom executables and explicit scripts as part of the first Services release. It executes only in the user-account worker and reuses shared lifecycle/operation/inspector contracts. A new root privilege profile requires an image/controller release and review. Neither a custom definition nor a catalogue update can silently grant a root capability. See [custom-services.md](custom-services.md).

Illustrative definition:

```json
{
  "schema": "t3.service-definition/1",
  "id": "openssh",
  "displayName": "SSH server",
  "instanceLimit": 1,
  "artifactFamily": "openssh-runtime",
  "controllerCompatibility": "reviewed-range",
  "owner": "managed-local",
  "adapter": "openssh-v1",
  "privilegeProfile": "openssh-server-v1",
  "capabilities": ["interactive-shell", "sftp", "editor-forwarding"],
  "requirements": ["protected-storage", "root-entrypoint", "supported-account-policy"],
  "configurationSchema": "openssh-config-v1",
  "endpoints": [{ "id": "shell", "protocol": "ssh" }],
  "readinessProbe": "openssh-handshake-v1",
  "updatePolicy": "manual-disruptive-with-rollback",
  "retentionPolicy": "keep-identity-and-configuration-on-uninstall"
}
```

For a catalogue/system definition, adapter and profile IDs resolve to image-owned implementation. Its privileged API accepts no user-authored command, executable path, arbitrary environment map, root configuration template or startup script. Execution uses trusted absolute paths resolved from the verified artifact receipt. Custom definitions accept user argv/environment through the user worker, with a fixed user-account execution scope. Profile changes cannot be smuggled through a version field or a claimed source label.

Each definition includes documentation, license/source attribution, tested image/architecture combinations, bounded start/stop/probe policies, log retention limits, instance conflicts, storage categories, update/migration constraints, safe cancellation checkpoints, and error-code remedies. The first catalogue should be small enough to test every supported definition.

A custom registration has a separate schema and owning worker, for example:

```json
{
  "schema": "t3.user-service/1",
  "id": "user:docs-preview",
  "name": "Docs preview",
  "launch": {
    "mode": "installed-tool",
    "tools": [{ "id": "python", "version": "3.13.2" }],
    "executable": "python",
    "argv": ["-m", "http.server", "8081", "--bind", "127.0.0.1"],
    "workingDirectory": "/home/t3/workspace/docs"
  },
  "desired": { "enabled": true },
  "restart": "on-failure",
  "health": { "kind": "process-only" }
}
```

The user execution identity is fixed by the worker, not selected by this document. Source/schema/ID claims do not grant system-service authority. This example does not install Python or publish its port.

## Configuration, identities and dependencies

Configuration fields have type, bounds, default, sensitivity, mutability, restart impact, and a server-side validator. Shared fields can produce generic controls. A reviewed custom editor is appropriate for SSH public keys or provider sign-in; it uses the same revision, plan and operation model.

No generic editable environment table for root services. Secrets are opaque references with a permitted consumer and version policy. Secret resolution is confined to that consumer and never returned with its ordinary configuration. Deleting a Vault entry in use must produce a dependency plan instead of silently leaving a daemon with stale credentials. Protected tailnet/SSH machine identity is not an ordinary exportable tool setting.

The dependency graph distinguishes:

- Required artifact dependencies, with exact version/ABI constraints and reference counts.
- Required runtime dependencies, with startup ordering and health propagation.
- A route's service endpoint and connection.
- A connection's account/identity and lifecycle owner.
- Optional conveniences that do not justify stopping a service when absent.

Resolve cycles and conflicts before applying a plan. Shared dependencies cannot be auto-removed. A connector can remain healthy even when one consuming service is failed. A route can be blocked while the SSH listener remains ready. Propagate reasons rather than collapsing all resources into Failed.

## Plans and durable mutations

The authenticated Setup layer handles current browser/session policy. The privileged layer independently validates every safe operation. Its protocol is bounded, versioned, local, and typed. User-process operations use a separately scoped user worker and durable authority. A Unix peer UID is not evidence of which same-user program made the request. The API families below are shared concepts; arbitrary user commands are accepted only by the user worker, never the privileged endpoint.

Illustrative API families:

| Family | Inputs | Output and rule |
| --- | --- | --- |
| Inspect | Stable resource ID, optional observation cursor | Sanitized snapshot with generation, evidence, owner and freshness |
| Plan | Named action, target ID, typed draft, expected revision | Plan ID, normalized diff, dependency graph, prerequisite reasons, exact artifact selection, impact and expiry |
| Apply | Plan ID, expected revision, idempotency key | Existing or newly committed operation ID; command draft belongs to a scoped plan, never a new command body at apply |
| Follow | Operation ID and event sequence | Bounded replay plus current snapshot; read-only |
| Cancel | Operation ID, revision, idempotency key | Checked transition only at declared safe checkpoints |
| Verify | Approved check kind and declared resource/route ID | Evidence record; never installs, starts or repairs |
| Export | Allowed sanitized export kind and resource IDs | Previewable safe configuration/diagnostics; protected backup is separate |

Readiness checks do not need a mutation confirmation. They are still bounded, authorized where needed, and prohibited from becoming privileged arbitrary-destination probes. Evidence writes use the controller's own validated journal path.

A plan records source resource revisions, definition/catalogue revisions, exact selected artifacts, config hashes, dependency graph, affected access paths, and any unknown impact. Apply rechecks those facts under locks. A successful preview is not authority to apply a different target after catalogue drift. A conflict keeps the user draft and returns stable reasons for replanning.

Use per-instance operation serialization plus an explicit artifact/store lock order. The implementation must document that order and test deadlock/cleanup races. A durable operation can span several resources, but every effect records its receipt and compensating action. Do not claim a remote provider transaction is atomic with the local database.

Recommended operation checkpoints:

```text
planned → committed → preflight → stage → verify → configure → activate → check → finished
                                                 ↘ awaiting authorization
                           any interrupted step → reconcile same operation
                              activation failure → restore → check → rolled back / failed
```

The exact state graph is action-specific. A provider approval may precede activation; package verification never means account sign-in succeeded. Cleanup/revocation can remain pending after local stop. Terminal outcomes include succeeded, cancelled with a defined retained state, rolled back, failed with recovery result, and cleanup pending where reconciliation is still required.

## Versioning and catalogue trust

Track image integration/controller schema, service definition revision, artifact version/digest, configuration revision and observation generation independently. Display user-relevant versions in Updates/Services; leave internal generation counters in details.

New catalogue trust metadata needs expiry, key rotation, revocation and rollback protection. Network installation requires currently trusted metadata. Previously verified retained artifacts may be re-enabled offline according to the explicit receipt/revocation policy; do not reinterpret missing internet as a signature bypass. A known revoked artifact must not be activated just because its bytes match an old receipt. Define operational recovery for expired trust metadata without silently downloading untrusted replacements.

Controller/store migration is transactional and backed up with compatibility metadata. An older image encountering a newer unsupported store must not rewrite it or execute an incompatible artifact. Block affected optional services with a precise remedy while preserving core access. Same-version resource integration goes through the supported updater and does not alter the selected runtime version or channel.

## Adding a future service

To demonstrate reuse beyond SSH, an implementation slice must add a reviewed non-SSH definition using the existing catalogue, operation timeline, inspector, update and storage contracts. Examples include a user-account synchronization or preview service. This does not preapprove a specific service or its package.

A contribution includes its definition, verified artifact source, configuration/privilege adapter, lifecycle and readiness behavior, dependency semantics, redaction rules, migration/rollback support, UI-specific fields only where necessary, and cross-architecture evidence. If each definition needs another entrypoint branch, another persistence model or another supervisor, the platform contract has failed.
