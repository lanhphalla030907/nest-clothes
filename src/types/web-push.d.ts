declare module 'web-push' {
  export function generateVAPIDKeys(): { publicKey: string; privateKey: string };
  export function sendNotification(
    subscription: {
      endpoint: string;
      keys: { p256dh: string; auth: string };
    },
    payload?: string | Buffer | Record<string, unknown>,
    options?: Record<string, unknown>,
    abortController?: AbortSignal,
  ): Promise<unknown>;
  export function setVapidDetails(
    subject: string,
    publicKey: string,
    privateKey: string,
  ): void;
}