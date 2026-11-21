// Testy negocjacji metody READ-PROXY (#20): QUERY z fallbackiem na POST.
// @vitest-environment node
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  detectProxyMethod,
  currentProxyMethod,
  demoteProxyMethod,
  isUnsupportedMethod,
  resetProxyMethod,
} from "./proxy-capability.js";

afterEach(() => {
  resetProxyMethod();
  vi.unstubAllGlobals();
});

describe("detectProxyMethod", () => {
  it("QUERY /health 200 → QUERY", async () => {
    const mock = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", mock);

    await expect(detectProxyMethod()).resolves.toBe("QUERY");
    expect(mock.mock.calls[0][1].method).toBe("QUERY");
    expect(currentProxyMethod()).toBe("QUERY");
  });

  it("QUERY /health 405/501 → POST (wynik ostateczny)", async () => {
    for (const status of [405, 501]) {
      resetProxyMethod();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status })));
      await expect(detectProxyMethod()).resolves.toBe("POST");
      expect(currentProxyMethod()).toBe("POST");
    }
  });

  it("błąd sieci przy sondzie → POST, ale wynik nie jest ostateczny", async () => {
    const mock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", mock);
    await expect(detectProxyMethod()).resolves.toBe("POST");
    // kolejna sonda (np. po powrocie sieci) może jeszcze wybrać QUERY
    await expect(detectProxyMethod()).resolves.toBe("QUERY");
  });

  it("403/429/502 na sondzie → POST, ale wciąż ponawialne", async () => {
    for (const status of [403, 429, 502]) {
      resetProxyMethod();
      const mock = vi
        .fn()
        .mockResolvedValueOnce(new Response("", { status }))
        .mockResolvedValueOnce(new Response("", { status: 200 }));
      vi.stubGlobal("fetch", mock);
      await expect(detectProxyMethod()).resolves.toBe("POST");
      await expect(detectProxyMethod()).resolves.toBe("QUERY");
    }
  });

  it("cache'uje wynik, force ponawia sondę", async () => {
    const mock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", mock);
    await detectProxyMethod();
    await detectProxyMethod();
    expect(mock).toHaveBeenCalledTimes(1);
    await detectProxyMethod({ force: true });
    expect(mock).toHaveBeenCalledTimes(2);
  });
});

describe("fallback", () => {
  it("przed sondą klient używa POST", () => {
    expect(currentProxyMethod()).toBe("POST");
  });

  it("demoteProxyMethod wraca do POST", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));
    await detectProxyMethod();
    expect(currentProxyMethod()).toBe("QUERY");
    demoteProxyMethod("test");
    expect(currentProxyMethod()).toBe("POST");
  });

  it("isUnsupportedMethod: 405/501", () => {
    expect(isUnsupportedMethod(new Response("", { status: 405 }))).toBe(true);
    expect(isUnsupportedMethod(new Response("", { status: 501 }))).toBe(true);
    expect(isUnsupportedMethod(new Response("", { status: 500 }))).toBe(false);
    expect(isUnsupportedMethod(new Response("", { status: 200 }))).toBe(false);
  });
});
