import { describe, expect, it } from "vitest";
import { HOT_DEBOUNCE_MS, HOT_MAX_CHECKPOINT_INTERVAL_MS, hotCheckpointDelayMs } from "../apps/sync-gateway/src/live-document-room";

/**
 * The checkpoint schedule, pinned as arithmetic.
 *
 * The design states two bounds — a pause in editing settles a revision after two seconds, and continued
 * editing may not postpone a save past ten seconds from the first unsaved change — and both are decisions
 * about *time*, which is exactly what an integration test cannot assert without either waiting ten
 * seconds or pretending the schedule does not matter. Here they are one function, so the policy is
 * checked directly, and the room's own alarm time is observable next to it (`storageStats().alarmAt`).
 */

const T = 1_700_000_000_000;

describe("the hot checkpoint schedule", () => {
  it("waits two seconds, and shrinks the wait once the cap is in reach", () => {
    // The alarm is only ever moved *earlier*, so in practice a save happens two seconds after the first
    // change of an editing interval. The cap takes over in the last two seconds of the interval, which is
    // what stops a stream of changes from pushing the save out indefinitely.
    expect(hotCheckpointDelayMs(T, T)).toBe(HOT_DEBOUNCE_MS);
    expect(hotCheckpointDelayMs(T, T + 1_000)).toBe(HOT_DEBOUNCE_MS);
    expect(hotCheckpointDelayMs(T, T + 8_000)).toBe(HOT_DEBOUNCE_MS);
    expect(hotCheckpointDelayMs(T, T + 9_000)).toBe(1_000);
    expect(hotCheckpointDelayMs(T, T + 9_500)).toBe(500);
    expect(hotCheckpointDelayMs(T, T + 10_000)).toBe(0);
  });

  it("never lets continuous editing postpone a save past the cap", () => {
    // Typing every second: the debounce would push the save out forever, the cap refuses to.
    let dirtySince = T;
    let now = T;
    for (let second = 0; second < 30; second++) {
      now += 1_000;
      const delay = hotCheckpointDelayMs(dirtySince, now);
      if (delay === 0) {
        // The cap was reached and the room saves here; the next change starts a new interval.
        dirtySince = now;
        continue;
      }
      expect(delay).toBeLessThanOrEqual(HOT_MAX_CHECKPOINT_INTERVAL_MS);
      expect(now + delay - dirtySince).toBeLessThanOrEqual(HOT_MAX_CHECKPOINT_INTERVAL_MS);
    }
    // Eight seconds in, the next change can only buy the remaining two seconds.
    expect(hotCheckpointDelayMs(T, T + 8_000)).toBe(2_000);
    // Past the cap the save is due immediately rather than in the past.
    expect(hotCheckpointDelayMs(T, T + 10_000)).toBe(0);
    expect(hotCheckpointDelayMs(T, T + 45_000)).toBe(0);
  });
});
