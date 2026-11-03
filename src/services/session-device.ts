import { Match } from "effect";

export const country_code_of = (raw: string | undefined): string | null => {
  const code = raw?.trim().toUpperCase() ?? "";
  return /^[A-Z]{2}$/.test(code) && code !== "XX" ? code : null;
};

export const browser_of = (ua: string | null): string | null => {
  const value = ua ?? "";
  return Match.value(value).pipe(
    Match.when((v) => /Helium\//i.test(v), () => "Helium"),
    Match.when((v) => /Edg(?:e|A|iOS)?\//i.test(v), () => "Edge"),
    Match.when((v) => /OPR\/|OPiOS\//i.test(v), () => "Opera"),
    Match.when((v) => /Firefox\/|FxiOS\//i.test(v), () => "Firefox"),
    Match.when((v) => /CriOS\//i.test(v), () => "Chrome"),
    Match.when((v) => /Chrome\//i.test(v), () => "Chromium browser"),
    Match.when((v) => /Safari\//i.test(v) && /Version\//i.test(v), () => "Safari"),
    Match.orElse(() => null),
  );
};

export const device_of = (ua: string | null): string | null => {
  const value = ua ?? "";
  return Match.value(value).pipe(
    Match.when((v) => /iPhone/i.test(v), () => "iPhone"),
    Match.when((v) => /iPad/i.test(v), () => "iPad"),
    Match.when((v) => /Android/i.test(v), () => "Android"),
    Match.when((v) => /Windows/i.test(v), () => "Windows"),
    Match.when((v) => /Macintosh|Mac OS X/i.test(v), () => "Mac"),
    Match.when((v) => /Linux/i.test(v), () => "Linux"),
    Match.orElse(() => null),
  );
};
