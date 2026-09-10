import { readFile } from "node:fs/promises";

const GIT_LFS_POINTER_HEADER = "version https://git-lfs.github.com/spec/v1";

export async function assertFixtureMaterialized(path: string) {
  const contents = await readFile(path, "utf8");
  if (contents.startsWith(GIT_LFS_POINTER_HEADER)) {
    throw new Error(
      `Event trace fixture ${path} is a Git LFS pointer, not the real file. Run git lfs pull before recording event traces.`,
    );
  }
}
