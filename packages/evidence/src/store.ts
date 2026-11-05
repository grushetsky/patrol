import { createHash } from "node:crypto";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

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
export type EvidenceArtifactKind =
  | "response_body"
  | "response_headers"
  | "rendered_dom"
  | "screenshot"
  | "thumbnail"
  | "extraction_sidecar";

/** True for the one artifact kind stored under the derived prefix. */
export function isThumbnailKind(kind: string): boolean {
  return kind === "thumbnail";
}

/** The handoff pack's artifact kinds (the contract's HandoffArtifactKind). */
export type PackArtifactKind =
  | "notice_html"
  | "fields_json"
  | "upload_file"
  | "handoff_markdown";

/** True for the pack's artifact kinds, stored under the packs prefix. */
export function isPackKind(kind: string): kind is PackArtifactKind {
  return (
    kind === "notice_html" ||
    kind === "fields_json" ||
    kind === "upload_file" ||
    kind === "handoff_markdown"
  );
}

/**
 * The object key one artifact lives under — the ONE key helper, used by the
 * production store's writes and presigns and by the test fakes alike:
 * `evidence/sha256/<first two>/<next two>/<full hash>` for evidence
 * artifacts, `derived/thumbnail/sha256/...` for the viewport thumbnails,
 * `packs/sha256/...` for the handoff pack's files (ADR 0020: the pack is
 * content-addressed in the same bucket), sharded by the hash's leading byte
 * pairs so a listing stays walkable.
 */
export function artifactKey(kind: string, sha256: string): string {
  const root = isThumbnailKind(kind)
    ? "derived/thumbnail"
    : isPackKind(kind)
      ? "packs"
      : "evidence";
  return `${root}/sha256/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}

/** The SHA-256 of some bytes as lowercase hex — the identity of an object. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

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
  /** What the response advertises as its content type. */
}

/** A signed, version-pinned download reference. */
export interface PresignedDownload {
  url: string;
  expiresAt: Date;
}

/** One version-pinned delete the retention job issues. */
export interface ArtifactVersionDelete {
  kind: EvidenceArtifactKind | PackArtifactKind;
  sha256: string;
  /**
   * The version the write observed and the artifact row pins; null on
   * unversioned stores, where the delete removes the only version.
   */
  objectVersion: string | null;
}

/** The prefix the raw SERP payload objects Patrol owns live under. */
export const RAW_SERP_PREFIX = "serp/";

/**
 * The store's port. The worker writes through it; the API presigns through
 * it; tests inject fakes that record the calls. The retention job (slice 9)
 * owns the only purge path: no other component deletes, and its deletes name
 * the version the write observed so a shared blob's surviving version is
 * never hidden behind a delete marker.
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
  /**
   * Deletes one artifact's version — the retention job's purge path alone.
   * The caller has already set the evidence row's purge marker (metadata
   * first, bytes second), and has checked no unpurged artifact row still
   * references the hash, because one blob serves many records.
   */
  deleteArtifactVersion(request: ArtifactVersionDelete): Promise<void>;
  /**
   * Deletes the raw SERP payload object VERSIONS under `serp/` whose last
   * modification precedes the cutoff — the ninety-day window for the raw
   * payloads Patrol owns (a Yandex response stored for parser audits; the
   * result ROWS stay in PostgreSQL permanently as provenance). Returns the
   * keys whose versions it deleted, once per key however many versions
   * went. When no adapter stores raw payloads the call lists an empty
   * prefix and deletes nothing.
   */
  purgeRawSerpPayloadsOlderThan(cutoff: Date): Promise<string[]>;
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
export class S3EvidenceStore implements EvidenceStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private ready: Promise<void> | null = null;

  constructor(config: S3StoreConfig) {
    this.client = new S3Client({
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
      region: config.region,
      ...(config.accessKeyId !== undefined && config.secretAccessKey !== undefined
        ? { credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } }
        : {}),
      ...(config.forcePathStyle === undefined ? {} : { forcePathStyle: config.forcePathStyle }),
    });
    this.bucket = config.bucket;
  }

  async ensureReady(): Promise<void> {
    // Idempotent per store instance; concurrent callers share one run.
    this.ready ??= this.prepare();
    await this.ready;
  }

  private async prepare(): Promise<void> {
    const exists = await this.client
      .send(new HeadBucketCommand({ Bucket: this.bucket }))
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
    // Versioning is the floor under version-pinned reads: without it a
    // delete is a delete, and a citation's bytes could vanish while the
    // record survived. Object Lock is a production-bucket decision (the
    // deployment creates the bucket with a lock before this code runs
    // against it); MinIO in development accepts the weaker guarantee the
    // risks register already records.
    await this.client.send(
      new PutBucketVersioningCommand({
        Bucket: this.bucket,
        VersioningConfiguration: { Status: "Enabled" },
      }),
    );
  }

  async putArtifact(upload: ArtifactUpload): Promise<StoredObject> {
    const key = artifactKey(upload.kind, upload.sha256);
    const head = await this.client
      .send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      .then((result) => result)
      .catch(() => null);
    if (head !== null) {
      return { sha256: upload.sha256, objectVersion: head.VersionId ?? null, existed: true };
    }
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: upload.bytes,
        ContentType: upload.contentType,
        // The hash in the object's own metadata: a restore that produces
        // different bytes fails a check rather than silently passing.
        Metadata: { sha256: upload.sha256 },
        ChecksumAlgorithm: "SHA256",
      }),
    );
    const stored = await this.client
      .send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      .catch(() => null);
    const objectVersion = stored?.VersionId ?? null;
    // Read the bytes back and re-hash them: the PUT's own checksum covers
    // the wire, this covers the store — the object that now stands must
    // hash to the key it filed under.
    const read = await this.readAll(key, objectVersion);
    if (sha256Hex(read) !== upload.sha256) {
      throw new Error(
        `stored object ${key} does not hash to its key; the write is not evidence`,
      );
    }
    return { sha256: upload.sha256, objectVersion, existed: false };
  }

  private async readAll(key: string, versionId: string | null): Promise<Uint8Array> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(versionId === null ? {} : { VersionId: versionId }),
      }),
    );
    const body = response.Body;
    if (body === undefined) {
      throw new Error(`object ${key} read back without a body`);
    }
    // The SDK's stream mixin collects the body in the runtime's own way.
    return await body.transformToByteArray();
  }

  async presignDownload(request: PresignRequest): Promise<PresignedDownload> {
    const expiresAt = new Date(Date.now() + request.expiresInSeconds * 1000);
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: artifactKey(request.kind, request.sha256),
      ResponseContentType: request.contentType,
      ...(request.objectVersion === null || request.objectVersion === undefined
        ? {}
        : { VersionId: request.objectVersion }),
    });
    const url = await getSignedUrl(this.client, command, {
      expiresIn: request.expiresInSeconds,
    });
    return { url, expiresAt };
  }

  async deleteArtifactVersion(request: ArtifactVersionDelete): Promise<void> {
    // A version-pinned delete, never an unversioned one: a delete marker
    // would hide a key every surviving citation reads while the version
    // stayed in storage (docs/design/evidence-capture.md "Immutability" #3).
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: artifactKey(request.kind, request.sha256),
        ...(request.objectVersion === null
          ? {}
          : { VersionId: request.objectVersion }),
      }),
    );
  }

  async purgeRawSerpPayloadsOlderThan(cutoff: Date): Promise<string[]> {
    // A versioned bucket reclaims bytes only through version-addressed
    // deletes: an unversioned DeleteObject lays a delete marker that hides
    // the key while every version's bytes stay in storage — the same
    // anti-pattern the store forbids everywhere else (docs/design/
    // evidence-capture.md "Immutability" #3). The window therefore walks
    // object VERSIONS under the prefix and names each past-cutoff
    // VersionId it deletes (the restore rehearsal's destroy phase uses the
    // same pattern); delete markers carry no bytes and are left alone.
    const deleted = new Set<string>();
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    do {
      const listing = await this.client.send(
        new ListObjectVersionsCommand({
          Bucket: this.bucket,
          Prefix: RAW_SERP_PREFIX,
          ...(keyMarker === undefined ? {} : { KeyMarker: keyMarker }),
          ...(versionMarker === undefined ? {} : { VersionIdMarker: versionMarker }),
        }),
      );
      for (const version of listing.Versions ?? []) {
        if (
          version.Key === undefined ||
          version.VersionId === undefined ||
          version.LastModified === undefined
        ) {
          continue;
        }
        if (version.LastModified >= cutoff) {
          continue;
        }
        await this.client.send(
          new DeleteObjectCommand({
            Bucket: this.bucket,
            Key: version.Key,
            VersionId: version.VersionId,
          }),
        );
        deleted.add(version.Key);
      }
      keyMarker = listing.IsTruncated ? listing.NextKeyMarker : undefined;
      versionMarker = listing.IsTruncated ? listing.NextVersionIdMarker : undefined;
    } while (keyMarker !== undefined);
    return [...deleted];
  }
}

/**
 * Reads the PATROL_OBJECT_STORE_* environment into a store configuration —
 * the same names docker-compose.yml and .env.example already carry. The
 * endpoint override selects MinIO or another S3-compatible provider;
 * absent credentials fall back to the SDK's own chain (IAM in production).
 */
export function s3ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): S3StoreConfig {
  const endpoint = env.PATROL_OBJECT_STORE_ENDPOINT;
  return {
    ...(endpoint === undefined || endpoint === "" ? {} : { endpoint }),
    region: env.PATROL_OBJECT_STORE_REGION ?? "us-east-1",
    bucket: env.PATROL_OBJECT_STORE_BUCKET ?? "patrol-evidence",
    ...(env.PATROL_OBJECT_STORE_ACCESS_KEY === undefined
      ? {}
      : { accessKeyId: env.PATROL_OBJECT_STORE_ACCESS_KEY }),
    ...(env.PATROL_OBJECT_STORE_SECRET_KEY === undefined
      ? {}
      : { secretAccessKey: env.PATROL_OBJECT_STORE_SECRET_KEY }),
    // An explicit endpoint means an on-prem store almost every time; AWS
    // itself stays virtual-hosted.
    forcePathStyle:
      env.PATROL_OBJECT_STORE_FORCE_PATH_STYLE === undefined && endpoint !== undefined
        ? true
        : env.PATROL_OBJECT_STORE_FORCE_PATH_STYLE === "1",
  };
}
