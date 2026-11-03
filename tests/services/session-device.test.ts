import { describe, expect, it } from "vitest";
import { browser_of, country_code_of, device_of } from "../../src/services/session-device.ts";

describe("session metadata", () => {
  it("recognizes common browser and platform combinations without guessing unknowns", () => {
    expect(browser_of("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Mobile Safari/604.1")).toBe("Safari");
    expect(device_of("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe("iPhone");
    expect(browser_of("Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Helium/1.0 Safari/537.36")).toBe("Helium");
    expect(browser_of("Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36")).toBe("Chromium browser");
    expect(device_of("Mozilla/5.0 (Windows NT 10.0)")).toBe("Windows");
    expect(browser_of(null)).toBeNull();
    expect(device_of("unknown")).toBeNull();
  });

  it("normalizes country codes and rejects unknown markers", () => {
    expect(country_code_of("us")).toBe("US");
    expect(country_code_of("XX")).toBeNull();
    expect(country_code_of("T1")).toBeNull();
  });
});
