export type YoutubeErrorCode =
  | "YOUTUBE_RECONNECT" // token revoked/expired — admin must reconnect
  | "YOUTUBE_QUOTA" // daily limit — retry tomorrow
  | "YOUTUBE_INVALID" // 4xx: YouTube will never accept this request as-is
  | "YOUTUBE_NOT_CONNECTED"
  | "YOUTUBE_OTHER"; // transient (5xx / network) — safe to retry

export class YoutubeError extends Error {
  constructor(
    readonly code: YoutubeErrorCode,
    message: string,
  ) {
    super(message);
  }
}
