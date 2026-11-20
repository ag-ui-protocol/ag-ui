import { copyFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

type PendingWrite = { path: string; temporaryPath: string; content: string };

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export class EventTracePublicationRecoveryError extends AggregateError {
  constructor(
    readonly recoveryDirectory: string,
    publicationError: unknown,
    rollbackErrors: unknown[],
  ) {
    super(
      [publicationError, ...rollbackErrors],
      `Event trace publication failed: ${describeError(publicationError)}. ` +
        `Rollback failed: ${rollbackErrors.map(describeError).join("; ")}. ` +
        `Original baselines and recovery.json are retained in ${recoveryDirectory}; restore them before retrying.`,
      { cause: publicationError },
    );
  }
}

// Call under the update workspace's publication lock with validated destinations.
// Individual renames are atomic; the batch is not crash-atomic.
export async function publishEventTraceUpdates(
  pendingWrites: readonly PendingWrite[],
  stagingDirectory: string,
  replace: (source: string, destination: string) => Promise<void> = rename,
) {
  if (pendingWrites.length === 0) return;
  const recovery: Array<{ path: string; backupPath: string | null }> =
    pendingWrites.map((pending, index) => ({
      path: pending.path,
      backupPath: join(stagingDirectory, `original-${index}.bak`),
    }));
  // Prepare all originals and replacements before changing any destination.
  for (const [index, pending] of pendingWrites.entries()) {
    const backupPath = recovery[index].backupPath;
    if (backupPath !== null) {
      try {
        await copyFile(pending.path, backupPath);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          recovery[index].backupPath = null;
        } else {
          throw error;
        }
      }
    }
    await writeFile(pending.temporaryPath, pending.content, "utf8");
  }
  await writeFile(
    join(stagingDirectory, "recovery.json"),
    JSON.stringify(recovery, null, 2) + "\n",
    "utf8",
  );
  let publishedCount = 0;
  try {
    for (const pending of pendingWrites) {
      await replace(pending.temporaryPath, pending.path);
      publishedCount += 1;
    }
  } catch (publicationError) {
    const rollbackErrors: unknown[] = [];
    for (let index = publishedCount - 1; index >= 0; index -= 1) {
      const original = recovery[index];
      try {
        if (original.backupPath === null) {
          await rm(original.path, { force: true });
          continue;
        }
        // Keep the backup intact even if restoration fails or the process exits.
        const restorePath = join(stagingDirectory, `restore-${index}.tmp`);
        await copyFile(original.backupPath, restorePath);
        await replace(restorePath, original.path);
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new EventTracePublicationRecoveryError(
        stagingDirectory,
        publicationError,
        rollbackErrors,
      );
    }
    throw publicationError;
  }
}
