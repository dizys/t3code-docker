// One home for every release size and integrity bound.
//
// The GitHub release stack (releases.mjs) and the container-registry stack
// (distribution.mjs) resolve different backends but stage the same archives
// through the same verifier (unpackRelease). An integrity hardening that
// lands in only one file leaves the other on the old bound, so both stacks
// import these limits and predicates instead of keeping their own copies.
import { createHash } from "node:crypto";

// Largest single archive the updater will stage or trust from a manifest.
export const ARCHIVE_LIMIT = 300 * 1024 * 1024;
// Largest extracted tree the updater will accept.
export const UNPACKED_LIMIT = 1024 * 1024 * 1024;
// Free space kept in reserve on the staging volume while downloading.
export const RELEASE_HEADROOM = 64 * 1024 * 1024;
// Largest checksum list accepted from a GitHub release.
export const SUMS_LIMIT = 1024 * 1024;
// Largest registry document (release API page, image index or manifest).
export const DOCUMENT_LIMIT = 4 * 1024 * 1024;

// Registry blob digest ("sha256:…") used in manifests and blob URLs.
export const isSha256Digest = (value) => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
// Download integrity ("sha256-…") carried on a resolved release.
export const isSha256Integrity = (value) => typeof value === "string" && /^sha256-[a-f0-9]{64}$/.test(value);
export const digestOfText = (text) => "sha256:" + createHash("sha256").update(text).digest("hex");
