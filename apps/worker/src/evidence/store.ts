import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export interface StoredObject {
  key: string;
  version: string | null;
}

export interface CaptureStore {
  put(input: {
    kind: string;
    sha256: string;
    body: Buffer;
    contentType: string;
    evidenceId: string;
    retainUntil?: Date;
  }): Promise<StoredObject>;
  /** Delete one version after its retention lock has lapsed. */
  delete?(key: string, version: string | null): Promise<void>;
}

export function artifactKey(kind: string, sha256: string): string {
  const prefix =
    kind === "thumbnail" ? "derived/thumbnail" : "evidence";
  return `${prefix}/sha256/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}

export class S3CaptureStore implements CaptureStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly objectLockMode?: "COMPLIANCE" | "GOVERNANCE";

  constructor(options: {
    bucket: string;
    region: string;
    endpoint?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    objectLockMode?: "COMPLIANCE" | "GOVERNANCE";
  }) {
    this.bucket = options.bucket;
    this.client = new S3Client({
      region: options.region,
      ...(options.endpoint
        ? { endpoint: options.endpoint, forcePathStyle: true }
        : {}),
      ...(options.accessKeyId && options.secretAccessKey
        ? {
            credentials: {
              accessKeyId: options.accessKeyId,
              secretAccessKey: options.secretAccessKey,
            },
          }
        : {}),
    });
    this.objectLockMode = options.objectLockMode;
  }

  async put(input: {
    kind: string;
    sha256: string;
    body: Buffer;
    contentType: string;
    evidenceId: string;
    retainUntil?: Date;
  }): Promise<StoredObject> {
    const key = artifactKey(input.kind, input.sha256);
    const existing = await this.client
      .send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      .catch(() => undefined);
    if (existing) {
      return { key, version: existing.VersionId ?? null };
    }
    const result = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: input.body,
        ContentType: input.contentType,
        Metadata: {
          sha256: input.sha256,
          kind: input.kind,
          evidenceid: input.evidenceId,
        },
        ...(this.objectLockMode && input.retainUntil
          ? {
              ObjectLockMode: this.objectLockMode,
              ObjectLockRetainUntilDate: input.retainUntil,
            }
          : {}),
      }),
    );
    return { key, version: result.VersionId ?? null };
  }

  async delete(key: string, version: string | null): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ...(version ? { VersionId: version } : {}),
        }),
      );
    } catch (error) {
      if (httpStatus(error) === 404) {
        return;
      }
      throw error;
    }
  }
}

function httpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("$metadata" in error)) {
    return undefined;
  }
  const metadata = error.$metadata;
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("httpStatusCode" in metadata)
  ) {
    return undefined;
  }
  return typeof metadata.httpStatusCode === "number"
    ? metadata.httpStatusCode
    : undefined;
}

export function storeFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): CaptureStore | undefined {
  if (!env.S3_BUCKET) {
    return undefined;
  }
  return new S3CaptureStore({
    bucket: env.S3_BUCKET,
    region: env.AWS_REGION ?? "eu-central-1",
    endpoint: env.S3_ENDPOINT,
    accessKeyId: env.S3_ACCESS_KEY_ID ?? env.MINIO_ROOT_USER,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? env.MINIO_ROOT_PASSWORD,
    objectLockMode:
      env.S3_OBJECT_LOCK_MODE === "COMPLIANCE"
        ? "COMPLIANCE"
        : env.S3_OBJECT_LOCK_MODE === "GOVERNANCE"
          ? "GOVERNANCE"
          : undefined,
  });
}
