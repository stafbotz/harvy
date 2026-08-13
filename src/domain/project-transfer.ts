/**
 * Source-neutral project snapshot transfer. The descriptor may cross a trust
 * domain; `open` is an internal Harvy handle and must never be serialized,
 * logged, persisted, or exposed to a model.
 */
export interface ProjectSnapshotBundleDescriptor {
  version: 1;
  snapshotId: string;
  bundleSha256: string;
  manifestSha256: string;
  size: number;
  fileCount: number;
  mediaType: "application/vnd.harvy.snapshot-bundle.v1";
}

export interface ProjectSnapshotBundleSource {
  descriptor: ProjectSnapshotBundleDescriptor;
  open(): AsyncIterable<Uint8Array>;
}
