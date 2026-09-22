export const CHANNEL_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isRemoteChangeChannel(value: string): boolean {
  return CHANNEL_PATTERN.test(value);
}
