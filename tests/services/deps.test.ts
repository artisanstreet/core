import { describe, expect, it } from "vitest";
import { parse_cookie_domain } from "../../src/services/deps.ts";

describe("parse_cookie_domain", () => {
  const sites = ["https://auth.artisan.st", "https://dashboard.artisan.st"];

  it("accepts a parent domain of both browser sites, with or without a leading dot", () => {
    expect(parse_cookie_domain("artisan.st", sites)).toBe("artisan.st");
    expect(parse_cookie_domain(".Artisan.st", sites)).toBe("artisan.st");
    expect(parse_cookie_domain(null, sites)).toBeNull();
  });

  it("refuses a domain the browser would not send to one of the sites", () => {
    expect(() => parse_cookie_domain("auth.artisan.st", sites)).toThrow(/does not cover dashboard\.artisan\.st/);
    expect(() => parse_cookie_domain("rtisan.st", sites)).toThrow(/does not cover/);
  });

  it("refuses anything that is not a bare domain", () => {
    expect(() => parse_cookie_domain("https://artisan.st", sites)).toThrow(/bare domain/);
    expect(() => parse_cookie_domain("localhost", sites)).toThrow(/bare domain/);
  });
});
