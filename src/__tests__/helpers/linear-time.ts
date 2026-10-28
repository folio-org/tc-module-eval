const RUNS_PER_SIZE = 3;

/**
 * Runs `run` on inputs of `size` and four times `size`, and fails if the larger input costs eight times
 * as much CPU time or more: linear work costs about four times as much, quadratic work sixteen.
 * It measures the CPU time of this process (including its GC and thread-pool threads, but not child
 * processes) rather than elapsed time, so waiting for a busy machine does not count, and each size
 * keeps its cheapest run. `prepare` builds the input for a size and is not measured.
 * Returns the result of a run on the larger input.
 */
export async function expectLinearTime<Input, Result>(
  size: number,
  prepare: (size: number) => Input | Promise<Input>,
  run: (input: Input) => Promise<Result>
): Promise<Result> {
  const small = await prepare(size);
  const large = await prepare(size * 4);
  let smallMs = Infinity;
  let largeMs = Infinity;
  let result: Result | undefined;
  for (let attempt = 0; attempt < RUNS_PER_SIZE; attempt++) {
    smallMs = Math.min(smallMs, await cpuTime(() => run(small)));
    largeMs = Math.min(largeMs, await cpuTime(async () => { result = await run(large); }));
  }
  const ratio = largeMs / smallMs;
  if (!(ratio < 8)) {
    throw new Error(`Four times the input cost ${ratio.toFixed(1)} times the CPU time (${smallMs.toFixed(0)} ms at size ${size}, ${largeMs.toFixed(0)} ms at size ${size * 4}); linear work costs about four times as much.`);
  }
  return result!;
}

async function cpuTime(action: () => Promise<unknown>): Promise<number> {
  const started = process.cpuUsage();
  await action();
  const { user, system } = process.cpuUsage(started);
  return (user + system) / 1000;
}
