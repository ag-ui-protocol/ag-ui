import {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
  TestStep,
} from "@playwright/test/reporter";
import { createS3Uploader, VideoToUpload } from "../lib/upload-video";
import { writeFileSync, existsSync } from "fs";
import { dirname } from "path";
import { mkdirSync } from "fs";

interface S3VideoReporterOptions {
  outputFile?: string;
  uploadVideos?: boolean;
}

interface VideoInfo {
  url: string;
  testName: string;
  suiteName?: string;
  videoPath?: string; // Store the file path for upload
  timestamp?: number; // For deduplication - keep most recent
}

// Global variable to store video URLs for other reporters to access
export const uploadedVideos: VideoInfo[] = [];

export default class S3VideoReporter implements Reporter {
  private options: S3VideoReporterOptions;
  private videos: VideoInfo[] = []; // Only final attempt videos

  constructor(options: S3VideoReporterOptions = {}) {
    this.options = {
      outputFile: options.outputFile || "test-results/video-urls.json",
      uploadVideos: options.uploadVideos !== false, // Default to true
      ...options,
    };
    console.log(
      `📹 DEBUG: S3VideoReporter constructor called with options:`,
      options
    );
  }

  onBegin(config: FullConfig, suite: Suite) {
    console.log(`📹 S3 Video Reporter initialized`);
    console.log(`   Upload enabled: ${this.options.uploadVideos}`);
    console.log(`   Output file: ${this.options.outputFile}`);
  }

  onTestEnd(test: TestCase, result: TestResult) {
    // Only process failed tests
    if (result.status !== "failed" && result.status !== "timedOut") {
      return;
    }

    console.log(`📹 Processing test attempt for: ${test.title}`);

    // Look for video attachments
    const videoAttachments = result.attachments.filter(
      (attachment) => attachment.name === "video" && attachment.path
    );

    if (videoAttachments.length === 0) {
      console.log(`📹 No video attachments found for final attempt`);
      return;
    }

    console.log(
      `📹 Found ${videoAttachments.length} video(s) for failed test: ${test.title}`
    );

    // Store video info for later upload
    videoAttachments.forEach((attachment) => {
      console.log(
        `📹 DEBUG: Processing attachment path=${attachment.path}, exists=${
          attachment.path ? existsSync(attachment.path) : false
        }`
      );
      if (attachment.path && existsSync(attachment.path)) {
        const videoInfo = {
          url: "", // Will be set after upload
          testName: test.title,
          suiteName: test.parent?.title,
          videoPath: attachment.path, // Store actual file path
          timestamp: Date.now(), // For deduplication
        };
        this.videos.push(videoInfo);
        console.log(`📹 DEBUG: Added video info:`, videoInfo);
        console.log(`📹 DEBUG: Total videos now: ${this.videos.length}`);
      } else {
        console.log(
          `📹 DEBUG: Skipping attachment - path invalid or file doesn't exist`
        );
      }
    });
  }

  async onEnd(result: FullResult) {
    console.log(`📹 DEBUG: onEnd called`);
    console.log(`📹 DEBUG: uploadVideos=${this.options.uploadVideos}`);
    console.log(`📹 DEBUG: videos.length=${this.videos.length}`);
    console.log(
      `📹 DEBUG: videos=`,
      this.videos.map((v) => ({
        testName: v.testName,
        hasPath: !!v.videoPath,
        pathExists: v.videoPath ? existsSync(v.videoPath) : false,
      }))
    );

    if (!this.options.uploadVideos) {
      console.log("📹 Upload disabled in options");
      return;
    }

    if (this.videos.length === 0) {
      console.log("📹 No videos collected");
      return;
    }

    const uploader = createS3Uploader();
    if (!uploader) {
      console.warn("⚠️  S3 uploader not configured, skipping video upload");
      return;
    }

    try {
      // Deduplicate videos - keep only the most recent one for each test
      const videoMap = new Map<string, VideoInfo>();
      this.videos.forEach((video) => {
        const existing = videoMap.get(video.testName);
        if (!existing || (video.timestamp || 0) > (existing.timestamp || 0)) {
          videoMap.set(video.testName, video);
        }
      });

      const deduplicatedVideos = Array.from(videoMap.values());
      console.log(
        `📹 Deduplicated ${this.videos.length} videos down to ${deduplicatedVideos.length} (keeping most recent per test)`
      );

      // Use the deduplicated videos for upload
      const videosToUpload: VideoToUpload[] = deduplicatedVideos
        .filter((video) => video.videoPath && existsSync(video.videoPath))
        .map((video) => {
          const s3ObjectPath = uploader.generateS3Path(
            video.videoPath!,
            video.testName,
            video.suiteName
          );

          return {
            videoPath: video.videoPath!,
            s3ObjectPath,
            testName: video.testName,
            suiteName: video.suiteName,
          };
        });

      if (videosToUpload.length === 0) {
        console.log("📹 No video files found to upload");
        return;
      }

      console.log(
        `📹 Preparing to upload ${videosToUpload.length} video(s)...`
      );

      // Upload videos to S3
      const uploadResults = await uploader.uploadVideos(videosToUpload);

      // Update our video info with URLs
      this.videos = uploadResults;

      // Store globally for other reporters
      uploadedVideos.splice(0);
      uploadedVideos.push(...this.videos);

      // Write video URLs to file for other processes
      await this.writeVideoUrls();

      console.log(
        `✅ Successfully uploaded ${this.videos.length} videos to S3`
      );
    } catch (error) {
      console.error("❌ Failed to upload videos:", error);
    }
  }

  private async writeVideoUrls() {
    if (!this.options.outputFile) return;

    const outputDir = dirname(this.options.outputFile);
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    const videoData = {
      uploadTime: new Date().toISOString(),
      runId: process.env.GITHUB_RUN_ID || `local-${Date.now()}`,
      repository: process.env.GITHUB_REPOSITORY || "unknown",
      videos: this.videos,
    };

    writeFileSync(this.options.outputFile, JSON.stringify(videoData, null, 2));
    console.log(`📄 Video URLs written to: ${this.options.outputFile}`);
  }

  // Helper methods removed - we now collect videos directly in onTestEnd
}

/**
 * Get uploaded video URLs for use in other reporters
 */
export function getUploadedVideos(): VideoInfo[] {
  return [...uploadedVideos];
}

/**
 * Get all uploaded videos
 */
export function getAllVideos(): VideoInfo[] {
  return [...uploadedVideos];
}
