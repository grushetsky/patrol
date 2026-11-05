/**
 * The content-addressed evidence store (ADR 0006; docs/design/
 * evidence-capture.md "Storage layout", "Immutability"). PostgreSQL holds
 * the records; the bucket holds the bytes, keyed by the SHA-256 of their
 * content so an unchanged artifact produces an identical key and no object
 * is ever overwritten. Every write names the hash in the object's own
 * metadata (hashes in two places), every read pins the version the write
 * observed (a delete marker must not hide a citation), and no component
 * issues an unversioned delete — deletes belong to the retention job in
 * slice 9 alone.
 */
/** The artifact kinds the contract's EvidenceArtifactKind fixes. */
export type EvidenceArtifactKind = "response_body" | "response_headers" | "rendered_dom" | "screenshot" | "thumbnail" | "extraction_sidecar";
/** True for the one artifact kind stored under the derived prefix. */
export declare function isThumbnailKind(kind: string): boolean;
/** The handoff pack's artifact kinds (the contract's HandoffArtifactKind). */
export type PackArtifactKind = "notice_html" | "fields_json" | "upload_file" | "handoff_markdown";
/** True for the pack's artifact kinds, stored under the packs prefix. */
export declare function isPackKind(kind: string): kind is PackArtifactKind;
/**
 * The object key one artifact lives under — the ONE key helper, used by the
 * production store's writes and presigns and by the test fakes alike:
 * `evidence/sha256/<first two>/<next two>/<full hash>` for evidence
 * artifacts, `derived/thumbnail/sha256/...` for the viewport thumbnails,
 * `packs/sha256/...` for the handoff pack's files (ADR 0020: the pack is
 * content-addressed in the same bucket), sharded by the hash's leading byte
 * pairs so a listing stays walkable.
 */
export declare function artifactKey(kind: string, sha256: string): string;
/** The SHA-256 of some bytes as lowercase hex — the identity of an object. */
export declare function sha256Hex(bytes: Uint8Array): string;
/** One artifact's bytes ready for the store. */
export interface ArtifactUpload {
    kind: EvidenceArtifactKind | PackArtifactKind;
    sha256: string;
    bytes: Uint8Array;
    contentType: string;
}
/** What storing one artifact produced. */
export interface StoredObject {
    sha256: string;
    /** The version the write observed; reads pin it. Null on unversioned stores. */
    objectVersion: string | null;
    /** True when the object already stood and the upload was skipped. */
    existed: boolean;
}
/** The parameters a signed download reference carries. */
export interface PresignRequest {
    kind: EvidenceArtifactKind | PackArtifactKind;
    sha256: string;
    contentType: string;
    /** The version to pin the read to, when one was recorded at write time. */
    objectVersion?: string | null;
    /** How long the signed URL stays valid. */
    expiresInSeconds: number;
}
/** A signed, version-pinned download reference. */
export interface PresignedDownload {
    url: string;
    expiresAt: Date;
}
/**
 * The store's port. The worker writes through it; the API presigns through
 * it; tests inject fakes that record the calls. Deletes exist on no
 * implementation — the retention job (slice 9) owns the only purge path.
 */
export interface EvidenceStore {
    /** Creates the bucket when absent and enables versioning. */
    ensureReady(): Promise<void>;
    /**
     * Stores one artifact's bytes content-addressed. A HEAD first: when the
     * object already stands the upload is skipped and the existing version is
     * pinned (byte dedup). After a PUT the bytes are read back and re-hashed —
     * a store that returns different bytes fails loudly rather than silently
     * passing.
     */
    putArtifact(upload: ArtifactUpload): Promise<StoredObject>;
    /** Presigns a GET for one artifact's bytes, pinned to a version. */
    presignDownload(request: PresignRequest): Promise<PresignedDownload>;
}
/** The S3-compatible store's configuration. */
export interface S3StoreConfig {
    /** The S3 API endpoint; absent for AWS itself, http://… for MinIO. */
    endpoint?: string;
    region: string;
    bucket: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    /** Path-style addressing, which MinIO and most on-prem stores need. */
    forcePathStyle?: boolean;
}
/**
 * The S3-compatible store over @aws-sdk/client-s3. The SDK choice is
 * deliberate: one client covers AWS in production and MinIO in development
 * through the endpoint override, presigning comes from the same credential
 * chain, and flexible checksums ride the PUT.
 */
export declare class S3EvidenceStore implements EvidenceStore {
    private readonly client;
    private readonly bucket;
    private ready;
    constructor(config: S3StoreConfig);
    ensureReady(): Promise<void>;
    private prepare;
    putArtifact(upload: ArtifactUpload): Promise<StoredObject>;
    private readAll;
    presignDownload(request: PresignRequest): Promise<PresignedDownload>;
}
/**
 * Reads the PATROL_OBJECT_STORE_* environment into a store configuration —
 * the same names docker-compose.yml and .env.example already carry. The
 * endpoint override selects MinIO or another S3-compatible provider;
 * absent credentials fall back to the SDK's own chain (IAM in production).
 */
export declare function s3ConfigFromEnv(env?: NodeJS.ProcessEnv): S3StoreConfig;
