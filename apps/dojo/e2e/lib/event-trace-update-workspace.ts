import { mkdir, mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { EventTracePublicationRecoveryError } from "./event-trace-update-publication";

type UpdateWorkspace = {
  stagingDirectory: string;
  publish: <T>(write: () => Promise<T>) => Promise<T>;
};

type CleanupOperations = {
  closeLock: (lock: FileHandle) => Promise<void>;
  remove: typeof rm;
};

// Only aggregates created here are flattened; caller errors retain their identity.
class WorkspaceCleanupError extends AggregateError {}

async function withCleanup<T>(
  action: () => Promise<T>,
  cleanups: Array<() => Promise<void>>,
): Promise<T> {
  const errors: unknown[] = [];
  try {
    return await action();
  } catch (error) {
    errors.push(error);
    throw error;
  } finally {
    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      const failures = errors.flatMap((error) =>
        error instanceof WorkspaceCleanupError ? error.errors : [error],
      );
      throw new WorkspaceCleanupError(
        failures,
        "Event trace update failed and/or cleanup failed",
        { cause: failures[0] },
      );
    }
  }
}

export async function withEventTraceUpdateWorkspace<T>(
  stagingRoot: string,
  capture: (workspace: UpdateWorkspace) => Promise<T>,
  cleanup: CleanupOperations = {
    closeLock: (lock) => lock.close(),
    remove: rm,
  },
): Promise<T> {
  await mkdir(stagingRoot, { recursive: true });
  const stagingDirectory = await mkdtemp(join(stagingRoot, "run-"));
  let preserveRecovery = false;
  return withCleanup(
    async () =>
      capture({
        stagingDirectory,
        publish: async (write) => {
          const lockPath = join(stagingRoot, "publish.lock");
          const lock = await open(lockPath, "wx").catch((error: unknown) => {
            if (
              error instanceof Error &&
              "code" in error &&
              error.code === "EEXIST"
            ) {
              throw new Error(
                "Another Event trace update is publishing; retry after it completes",
                { cause: error },
              );
            }
            throw error;
          });
          return withCleanup(async () => {
            try {
              return await write();
            } catch (error) {
              if (
                error instanceof EventTracePublicationRecoveryError &&
                error.recoveryDirectory === stagingDirectory
              ) {
                preserveRecovery = true;
              }
              throw error;
            }
          }, [() => cleanup.closeLock(lock), () => cleanup.remove(lockPath)]);
        },
      }),
    [
      async () => {
        if (!preserveRecovery) {
          await cleanup.remove(stagingDirectory, {
            recursive: true,
            force: true,
          });
        }
      },
    ],
  );
}
