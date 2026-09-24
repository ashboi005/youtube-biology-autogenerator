const STDERR_TAIL_LINES = 20;

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly stderrTail: string,
  ) {
    super(message);
  }
}

/**
 * Run ffmpeg at low priority, reporting progress (0-100) from `-progress pipe:1`.
 * `totalDuration` is the expected output length in seconds.
 */
export async function runFfmpeg(
  args: string[],
  totalDuration: number,
  onProgress: (pct: number) => void,
): Promise<void> {
  const proc = Bun.spawn(
    ["nice", "-n", "10", "ffmpeg", "-hide_banner", "-nostats", "-loglevel", "error", "-progress", "pipe:1", ...args],
    { stdout: "pipe", stderr: "pipe" },
  );

  const tail: string[] = [];
  const readStderr = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr) {
      for (const line of decoder.decode(chunk).split("\n")) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > STDERR_TAIL_LINES) tail.shift();
      }
    }
  })();

  const readProgress = (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of proc.stdout) {
      buf += decoder.decode(chunk);
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith("out_time_us=")) {
          const sec = Number(line.slice("out_time_us=".length)) / 1e6;
          if (Number.isFinite(sec) && totalDuration > 0) {
            onProgress(Math.max(0, Math.min(99, Math.floor((sec / totalDuration) * 100))));
          }
        } else if (line === "progress=end") {
          onProgress(100);
        }
      }
    }
  })();

  const [code] = await Promise.all([proc.exited, readStderr, readProgress]);
  if (code !== 0) {
    const stderrTail = tail.join("\n");
    throw new FfmpegError(`ffmpeg exited with code ${code}: ${stderrTail.slice(-500)}`, stderrTail);
  }
}
