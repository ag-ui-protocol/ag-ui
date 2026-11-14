import { describe, expect, it } from "vitest";
import { EMPTY, Subject, of, from, firstValueFrom, lastValueFrom } from "rxjs";
import { toArray } from "rxjs/operators";
import { applyInOrder, type Backlog } from "../apply-in-order";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("applyInOrder", () => {
  it("handles one value at a time, in order, and passes on what each returns", async () => {
    const started: number[] = [];
    let running = 0;
    const result = await lastValueFrom(
      from([1, 2, 3, 4]).pipe(
        applyInOrder(async (value: number) => {
          running += 1;
          expect(running).toBe(1);
          started.push(value);
          await tick();
          running -= 1;
          return value % 2 === 0 ? of(value * 10) : EMPTY;
        }),
        toArray(),
      ),
    );
    expect(started).toEqual([1, 2, 3, 4]);
    expect(result).toEqual([20, 40]);
  });

  it("starts a value synchronously when idle and counts the ones waiting", async () => {
    const source = new Subject<number>();
    const backlog: Backlog = { waiting: 0 };
    const seen: [number, number][] = [];
    const done = lastValueFrom(
      source.pipe(
        applyInOrder(async (value: number) => {
          seen.push([value, backlog.waiting]);
          await tick();
          return of(value);
        }, backlog),
        toArray(),
      ),
    );
    source.next(1);
    expect(seen).toEqual([[1, 0]]); // Started synchronously.
    source.next(2);
    source.next(3);
    expect(backlog.waiting).toBe(2);
    source.complete();
    expect(await done).toEqual([1, 2, 3]);
    expect(seen).toEqual([
      [1, 0],
      [2, 1],
      [3, 0],
    ]);
    expect(backlog.waiting).toBe(0);
  });

  it("completes only after the backlog drains", async () => {
    let completed = false;
    const source = new Subject<number>();
    const sub = source
      .pipe(applyInOrder(async (value: number) => (await tick(), of(value))))
      .subscribe({ complete: () => (completed = true) });
    source.next(1);
    source.next(2);
    source.complete();
    expect(completed).toBe(false);
    await tick();
    await tick();
    await tick();
    expect(completed).toBe(true);
    sub.unsubscribe();
  });

  it("passes a source error on at once and a rejected project as an error", async () => {
    const source = new Subject<number>();
    const failed = firstValueFrom(
      source.pipe(
        applyInOrder(async (v: number) => of(v)),
        toArray(),
      ),
    );
    source.error(new Error("source"));
    await expect(failed).rejects.toThrow("source");

    await expect(
      lastValueFrom(
        from([1, 2]).pipe(
          applyInOrder(async (v: number) => {
            if (v === 1) throw new Error("project");
            return of(v);
          }),
        ),
      ),
    ).rejects.toThrow("project");
  });

  it("stops starting values after unsubscribe", async () => {
    const started: number[] = [];
    const sub = from([1, 2, 3])
      .pipe(
        applyInOrder(async (value: number) => {
          started.push(value);
          await tick();
          return of(value);
        }),
      )
      .subscribe();
    sub.unsubscribe();
    await tick();
    await tick();
    expect(started).toEqual([1]);
  });
});
