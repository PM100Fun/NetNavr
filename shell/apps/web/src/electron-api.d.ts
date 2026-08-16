export {};

declare global {
  interface Window {
    netnavr?: {
      getShellConnection(): Promise<{
        webSocketUrl: string;
        sessionToken: string;
      }>;
    };
  }
}
