import { createHash } from "node:crypto";
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
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

/**
 * The object key one artifact lives under:
 * `evidence/sha256/<first two>/<next two>/<full hash>` for evidence
 * artifacts, `derived/thumbnail/sha256/...` for the viewport thumbnails,
 * sharded by the hash's leading byte pairs so a listing stays walkable.
 */
export function artifactKey(kind: string, sha256: string): string {
  const root = isThumbnailKind(kind) ? "derived/thumbnail" : "evidence";
  return `${root}/sha256/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}

/** The SHA-256 of some bytes as lowercase hex — the identity of an object. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** One artifact's bytes ready for the store. */
export interface ArtifactUpload {
  kind: EvidenceArtifactKind;
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
  kind: EvidenceArtifactKind;
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
