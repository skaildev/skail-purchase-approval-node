import { describe, expect, it } from "vitest";
import { deadlinesFromEnvironment } from "../src/config.js";

describe("deadlinesFromEnvironment", () => {
  it("defaults to 60 seconds for both levels", () => {
    expect(deadlinesFromEnvironment({})).toEqual({ managerSeconds: 60, directorSeconds: 60 });
  });

  it("reads the seconds of each level (172800 = 48 hours)", () => {
    expect(
      deadlinesFromEnvironment({
        APPROVAL_MANAGER_DEADLINE_SECONDS: "172800",
        APPROVAL_DIRECTOR_DEADLINE_SECONDS: "30",
      }),
    ).toEqual({
      managerSeconds: 172800,
      directorSeconds: 30,
    });
  });

  it("blank means default; zero, negative, fractional or text are refused (delaySeconds needs a finite, non-negative value)", () => {
    expect(deadlinesFromEnvironment({ APPROVAL_MANAGER_DEADLINE_SECONDS: " " }).managerSeconds).toBe(60);
    for (const bad of ["0", "-1", "1.5", "abc"]) {
      expect(() => deadlinesFromEnvironment({ APPROVAL_MANAGER_DEADLINE_SECONDS: bad })).toThrow(
        /APPROVAL_MANAGER_DEADLINE_SECONDS/,
      );
    }
  });
});
