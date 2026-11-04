import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ApiError } from "../errors.js";

export interface SignedArtifact {
  url: string;
  expiresAt: string;
}

export interface ArtifactStore {
  signedUrl(
    key: string,
    version: string | null,
    expiresInSeconds?: number,
  ): Promise<SignedArtifact>;
  /** Store immutable bytes and return the object version, when the store has one. */
  put?(key: string, body: Buffer, contentType: string): Promise<string | null>;
}

export class S3ArtifactStore implements ArtifactStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(options: {
    bucket: string;
    region: string;
    endpoint?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
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
  }

  async put(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<string | null> {
    const result = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    return result.VersionId ?? null;
  }

  async signedUrl(
    key: string,
    version: string | null,
    expiresInSeconds = 300,
  ): Promise<SignedArtifact> {
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(version ? { VersionId: version } : {}),
      }),
      { expiresIn: expiresInSeconds },
    );
    return { url, expiresAt: expiresAt.toISOString() };
  }
}

export class UnavailableArtifactStore implements ArtifactStore {
  async signedUrl(): Promise<SignedArtifact> {
    throw new ApiError(
      503,
      "not_supported",
      "Object storage is not configured.",
    );
  }
}

export function storeFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ArtifactStore {
  if (!env.S3_BUCKET) {
    return new UnavailableArtifactStore();
  }
  return new S3ArtifactStore({
    bucket: env.S3_BUCKET,
    region: env.AWS_REGION ?? "eu-central-1",
    endpoint: env.S3_ENDPOINT,
    accessKeyId: env.S3_ACCESS_KEY_ID ?? env.MINIO_ROOT_USER,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? env.MINIO_ROOT_PASSWORD,
  });
}
