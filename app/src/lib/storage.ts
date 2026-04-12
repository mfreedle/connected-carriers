import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "crypto";
import path from "path";

// ── R2 client (S3-compatible) ─────────────────────────────────────

function getClient(): S3Client {
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const region = "auto";

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error("R2 storage not configured — R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY required");
  }

  return new S3Client({
    region,
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });
}

const BUCKET = () => {
  const b = process.env.R2_BUCKET_NAME;
  if (!b) throw new Error("R2_BUCKET_NAME not set");
  return b;
};

// ── Upload ────────────────────────────────────────────────────────

export interface UploadResult {
  objectKey: string;
  fileUrl: string;      // internal reference — not a public URL
  fileName: string;
  fileSize: number;
  mimeType: string;
}

export async function uploadToR2(
  fileBuffer: Buffer,
  originalName: string,
  mimeType: string,
  prefix: string = "docs"
): Promise<UploadResult> {
  const ext = path.extname(originalName).toLowerCase() || "";
  const objectKey = `${prefix}/${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`;

  const client = getClient();
  await client.send(new PutObjectCommand({
    Bucket: BUCKET(),
    Key: objectKey,
    Body: fileBuffer,
    ContentType: mimeType,
    // Private by default — no public ACL
  }));

  return {
    objectKey,
    fileUrl: `r2://${BUCKET()}/${objectKey}`,  // internal reference only
    fileName: originalName,
    fileSize: fileBuffer.length,
    mimeType,
  };
}

// ── Delete ────────────────────────────────────────────────────────

export async function deleteFromR2(objectKey: string): Promise<void> {
  const client = getClient();
  await client.send(new DeleteObjectCommand({
    Bucket: BUCKET(),
    Key: objectKey,
  }));
}

// ── Presigned download URL (short-lived, authenticated) ───────────

export async function getPresignedDownloadUrl(objectKey: string, expiresInSeconds = 300): Promise<string> {
  const client = getClient();
  const command = new GetObjectCommand({
    Bucket: BUCKET(),
    Key: objectKey,
  });
  return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
}

// ── Validate upload ───────────────────────────────────────────────

const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/heic",
  "image/heif",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export function validateUpload(mimeType: string, fileSize: number): string | null {
  if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
    return "File type not allowed. Please upload a PDF, image (JPG/PNG), or Word document.";
  }
  if (fileSize > MAX_FILE_SIZE) {
    return "File is too large. Maximum size is 10MB.";
  }
  return null;
}

export function isR2Configured(): boolean {
  return !!(process.env.R2_ENDPOINT && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET_NAME);
}
