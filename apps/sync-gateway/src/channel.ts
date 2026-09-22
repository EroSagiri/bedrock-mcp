/**
 * Channel validation is owned by `@mineral/sync-core/channel`: the plugin derives channels with the
 * same package, so there is exactly one pattern and one canonical encoding across both repositories.
 * This module stays as the Gateway-local import site so route code does not reach into the package.
 */
export { CHANNEL_PATTERN, isRemoteChangeChannel } from "@mineral/sync-core/channel";
