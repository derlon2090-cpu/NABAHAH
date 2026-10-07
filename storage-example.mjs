import "dotenv/config";
import { config } from "dotenv";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Neon writes branch-scoped credentials to .env.local after deployment.
config({ path: ".env.local", override: false, quiet: true });

const requiredEnvironment = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_ENDPOINT_URL_S3",
  "AWS_REGION",
];
const missingEnvironment = requiredEnvironment.filter((name) => !process.env[name]);

if (missingEnvironment.length > 0) {
  throw new Error(
    `Missing Neon Object Storage environment variables: ${missingEnvironment.join(", ")}. Run neon deploy first.`,
  );
}

const s3 = new S3Client({ forcePathStyle: true });
const bucket = "assets";
const key = "uploads/file.txt";

await s3.send(
  new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: "Hello World!",
    ContentType: "text/plain; charset=utf-8",
  }),
);

const url = await getSignedUrl(
  s3,
  new GetObjectCommand({ Bucket: bucket, Key: key }),
  { expiresIn: 3600 },
);

console.log(`[view] ${url}`);
