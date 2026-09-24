import { describe, expect, it } from "vitest";
import {
  addBusinessMinutes,
  businessMinutesBetween,
  DEFAULT_SCHEDULE,
  isBusinessTime,
  type BusinessHours,
} from "@/lib/helpdesk/business-hours";

const london: BusinessHours = {
  timezone: "Europe/London",
  schedule: DEFAULT_SCHEDULE,
  holidays: ["2026-12-25", "2026-12-28"],
};

describe("business hours", () => {
  it("counts only working windows and skips weekends and holidays", () => {
    // Thu 24 Dec 2026 16:00 London (UTC+0) → Tue 29 Dec 09:30: 1.5h Thu + 0 Fri (holiday) + 0 weekend + 0 Mon (holiday) + 0.5h Tue = 120 min
    expect(
      businessMinutesBetween(
        new Date("2026-12-24T16:00:00Z"),
        new Date("2026-12-29T09:30:00Z"),
        london,
      ),
    ).toBe(120);
    expect(isBusinessTime(new Date("2026-12-25T10:00:00Z"), london)).toBe(
      false,
    );
    expect(isBusinessTime(new Date("2026-12-24T10:00:00Z"), london)).toBe(true);
    expect(
      businessMinutesBetween(
        new Date("2026-12-24T20:00:00Z"),
        new Date("2026-12-24T21:00:00Z"),
        london,
      ),
    ).toBe(0);
  });
  it("adds business minutes across the day boundary and the weekend", () => {
    // Fri 26 Jun 2026 16:00 London (BST, UTC+1 → 15:00Z) + 4h → 1.5h Fri, 2.5h Mon → Mon 29 Jun 11:30 BST = 10:30Z
    expect(
      addBusinessMinutes(
        new Date("2026-06-26T15:00:00Z"),
        240,
        london,
      ).toISOString(),
    ).toBe("2026-06-29T10:30:00.000Z");
    // Starting outside hours clocks from the next opening
    expect(
      addBusinessMinutes(
        new Date("2026-06-27T12:00:00Z"),
        60,
        london,
      ).toISOString(),
    ).toBe("2026-06-29T09:00:00.000Z");
  });
  it("follows the wall clock across a daylight-saving change", () => {
    // Clocks go back Sun 25 Oct 2026. Fri 23 Oct 17:00 BST (16:00Z) + 60 min → Mon 26 Oct 09:30 GMT = 09:30Z (not 08:30Z).
    expect(
      addBusinessMinutes(
        new Date("2026-10-23T16:00:00Z"),
        60,
        london,
      ).toISOString(),
    ).toBe("2026-10-26T09:30:00.000Z");
    // Clocks go forward Sun 29 Mar 2026: Fri 27 Mar 17:00 GMT (17:00Z) + 60 → Mon 30 Mar 09:30 BST = 08:30Z
    expect(
      addBusinessMinutes(
        new Date("2026-03-27T17:00:00Z"),
        60,
        london,
      ).toISOString(),
    ).toBe("2026-03-30T08:30:00.000Z");
    // A full working day is 8.5h in either regime
    expect(
      businessMinutesBetween(
        new Date("2026-03-30T00:00:00Z"),
        new Date("2026-03-31T00:00:00Z"),
        london,
      ),
    ).toBe(510);
  });
  it("24x7 schedules use calendar time", () => {
    const always: BusinessHours = { ...london, always: true };
    expect(
      businessMinutesBetween(
        new Date("2026-12-25T00:00:00Z"),
        new Date("2026-12-25T02:00:00Z"),
        always,
      ),
    ).toBe(120);
    expect(
      addBusinessMinutes(
        new Date("2026-12-25T00:00:00Z"),
        30,
        always,
      ).toISOString(),
    ).toBe("2026-12-25T00:30:00.000Z");
  });
});
