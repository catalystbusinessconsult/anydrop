import { describe, expect, it } from "vitest";
import { isAllowedRemoteAddress, isPrivateOrLoopbackIPv4 } from "../src/network.js";

describe("isPrivateOrLoopbackIPv4", () => {
  it("accepts RFC1918 ranges, link-local, and loopback", () => {
    expect(isPrivateOrLoopbackIPv4("10.0.0.5")).toBe(true);
    expect(isPrivateOrLoopbackIPv4("172.16.0.1")).toBe(true);
    expect(isPrivateOrLoopbackIPv4("172.31.255.255")).toBe(true);
    expect(isPrivateOrLoopbackIPv4("192.168.1.100")).toBe(true);
    expect(isPrivateOrLoopbackIPv4("169.254.1.1")).toBe(true);
    expect(isPrivateOrLoopbackIPv4("127.0.0.1")).toBe(true);
  });

  it("rejects public addresses and malformed input", () => {
    expect(isPrivateOrLoopbackIPv4("8.8.8.8")).toBe(false);
    expect(isPrivateOrLoopbackIPv4("172.32.0.1")).toBe(false); // just outside 172.16-31
    expect(isPrivateOrLoopbackIPv4("1.1.1.1")).toBe(false);
    expect(isPrivateOrLoopbackIPv4("not-an-ip")).toBe(false);
  });
});

describe("isAllowedRemoteAddress", () => {
  it("accepts IPv4-mapped IPv6 private addresses", () => {
    expect(isAllowedRemoteAddress("::ffff:192.168.1.5")).toBe(true);
  });

  it("accepts IPv6 loopback", () => {
    expect(isAllowedRemoteAddress("::1")).toBe(true);
  });

  it("rejects a public address", () => {
    expect(isAllowedRemoteAddress("203.0.113.5")).toBe(false);
  });
});
