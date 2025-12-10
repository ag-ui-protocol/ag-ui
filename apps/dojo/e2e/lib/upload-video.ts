import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { readFileSync, existsSync } from "fs";
import { basename } from "path";

export interface VideoToUpload {
  videoPath: string;
  s3ObjectPath: string;
  testName: string;
  suiteName?: string;
}

export interface S3Config {
  bucketName: string;
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export class S3VideoUploader {
  private s3Client: S3Client;
  private config: S3Config;

  constructor(config: S3Config) {
    this.config = config;

    // Initialize S3 client with credentials from environment or passed config
    this.s3Client = new S3Client({
      region: config.region,
      credentials:
        config.accessKeyId && config.secretAccessKey
          ? {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            }
          : undefined, // Use default credential chain if not provided
    });
  }

  /**
   * Generate S3 object path for a video file
   */
  generateS3Path(
    videoPath: string,
    testName: string,
    suiteName?: string
  ): string {
    const filename = basename(videoPath);
    const runId = process.env.GITHUB_RUN_ID || `local-${Date.now()}`;
    const projectName =
      process.env.GITHUB_REPOSITORY?.split("/")[1] || "cpk-demos-smoke-tests";

    // Clean test names for file paths
    const cleanSuite =
      suiteName?.replace(/[^a-zA-Z0-9-_]/g, "-") || "unknown-suite";
    const cleanTest = testName.replace(/[^a-zA-Z0-9-_]/g, "-");

    return `github-runs/${runId}/${projectName}/${cleanSuite}/${cleanTest}/${filename}`;
  }

  /**
   * Generate public S3 URL for a given object path
   */
  generatePublicUrl(s3ObjectPath: string): string {
    return `https://${this.config.bucketName}.s3.${this.config.region}.amazonaws.com/${s3ObjectPath}`;
  }

  /**
   * Upload a single video file to S3
   */
  async uploadVideo(video: VideoToUpload): Promise<string> {
    try {
      // Check if file exists
      if (!existsSync(video.videoPath)) {
        throw new Error(`Video file not found: ${video.videoPath}`);
      }

      console.log(
        `📹 Uploading video: ${basename(video.videoPath)} for test: ${
          video.testName
        }`
      );

      // Read file content
      const fileContent = readFileSync(video.videoPath);

      // Upload to S3
      const command = new PutObjectCommand({
        Bucket: this.config.bucketName,
        Key: video.s3ObjectPath,
        Body: fileContent,
        ContentType: "video/webm",
        CacheControl: "public, max-age=86400", // Cache for 1 day
        Metadata: {
          "test-name": video.testName,
          "suite-name": video.suiteName || "unknown",
          "upload-time": new Date().toISOString(),
        },
      });

      await this.s3Client.send(command);

      const publicUrl = this.generatePublicUrl(video.s3ObjectPath);
      console.log(`✅ Video uploaded successfully: ${publicUrl}`);

      return publicUrl;
    } catch (error) {
      console.error(`❌ Failed to upload video ${video.videoPath}:`, error);
      throw error;
    }
  }

  /**
   * Upload multiple videos concurrently
   */
  async uploadVideos(
    videos: VideoToUpload[]
  ): Promise<{ url: string; testName: string; suiteName?: string }[]> {
    if (videos.length === 0) {
      console.log("📹 No videos to upload");
      return [];
    }

    console.log(`📹 Uploading ${videos.length} video(s) to S3...`);

    const uploadPromises = videos.map(async (video) => {
      try {
        const url = await this.uploadVideo(video);
        return {
          url,
          testName: video.testName,
          suiteName: video.suiteName,
        };
      } catch (error) {
        console.error(
          `Failed to upload video for test ${video.testName}:`,
          error
        );
        return null;
      }
    });

    const results = await Promise.allSettled(uploadPromises);

    // Filter out failed uploads
    const successfulUploads = results
      .filter(
        (
          result
        ): result is PromiseFulfilledResult<{
          url: string;
          testName: string;
          suiteName?: string;
        } | null> => result.status === "fulfilled" && result.value !== null
      )
      .map((result) => result.value!);

    const failedUploads = results.filter(
      (result) => result.status === "rejected"
    ).length;

    console.log(`✅ Successfully uploaded ${successfulUploads.length} videos`);
    if (failedUploads > 0) {
      console.warn(`⚠️  ${failedUploads} videos failed to upload`);
    }

    return successfulUploads;
  }
}

/**
 * Factory function to create uploader with environment variables
 */
export function createS3Uploader(): S3VideoUploader | null {
  const bucketName = process.env.AWS_S3_BUCKET_NAME;
  const region = process.env.AWS_S3_REGION || "us-east-1";

  if (!bucketName) {
    console.warn("⚠️  AWS_S3_BUCKET_NAME not set, video upload disabled");
    return null;
  }

  return new S3VideoUploader({
    bucketName,
    region,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  });
}
