// Klient zapisu oceny (bilet #8): POST uploadfile z multipart + overwrite.
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { uploadFileOverwrite, revokeToken } from "./pcloud-api.js";

const BYTES = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]);

/** @type {any} */
let fetchMock;
const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** @param {any} body @param {number} [status] */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("revokeToken", () => {
  it("woła deletetoken z tokenem", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ result: 0 }));
    await expect(
      revokeToken({ token: "tok", hostname: "eapi.pcloud.com" }),
    ).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.origin + parsed.pathname).toBe("https://eapi.pcloud.com/deletetoken");
    expect(parsed.searchParams.get("access_token")).toBe("tok");
    expect(init).toBeUndefined();
  });

  it("błąd pCloud propaguje (caller czyści lokalny token i tak)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ result: 1000, error: "Log in required." }));
    await expect(revokeToken({ token: "tok" })).rejects.toThrow(/1000/);
  });

  it("bez tokena → błąd, bez wywołania sieciowego", async () => {
    await expect(revokeToken({ token: "" })).rejects.toThrow(/token required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("uploadFileOverwrite", () => {
  it("wysyła access_token, folderid i nopartial=1 w query; nazwa pliku tylko w polu plikowym", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        result: 0,
        fileids: [42],
        metadata: [{ fileid: 42, name: "a.mp3", size: 1234, modified: 1700000000 }],
      }),
    );

    const out = await uploadFileOverwrite({
      token: "tok",
      hostname: "eapi.pcloud.com",
      folderId: 777,
      filename: "a.mp3",
      bytes: BYTES,
    });

    expect(out).toEqual({ fileid: 42, name: "a.mp3", size: 1234, modified: 1700000000 });

    const [url, init] = fetchMock.mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.origin + parsed.pathname).toBe("https://eapi.pcloud.com/uploadfile");
    expect(parsed.searchParams.get("access_token")).toBe("tok");
    expect(parsed.searchParams.get("folderid")).toBe("777");
    expect(parsed.searchParams.get("nopartial")).toBe("1");
    expect(parsed.searchParams.get("timeformat")).toBe("timestamp");
    expect(init.method).toBe("POST");
    expect(init.headers).toBeUndefined(); // boundary ustawia przeglądarka sama

    const form = /** @type {FormData} */ (init.body);
    expect(form).toBeInstanceOf(FormData);
    const keys = [...form.keys()];
    expect(keys).toEqual(["file"]); // brak osobnego pola `filename` (pułapka z T5)
    const file = /** @type {File} */ (form.get("file"));
    expect(file.name).toBe("a.mp3");
    expect(file.type).toBe("audio/mpeg");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(BYTES);
  });

  it("fileid zachowany po overwrite (result 0) — zwraca go z metadata", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        result: 0,
        fileids: [71496730995],
        metadata: [{ fileid: 71496730995, size: 2, modified: 1700000001 }],
      }),
    );
    const out = await uploadFileOverwrite({
      token: "tok",
      hostname: "eapi.pcloud.com",
      folderId: 1,
      filename: "x.mp3",
      bytes: BYTES,
    });
    expect(out.fileid).toBe(71496730995);
  });

  it("result != 0 → błąd z flagą isAuthError dla 2xxx", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ result: 2001, error: "Invalid access_token" }));
    await expect(
      uploadFileOverwrite({
        token: "tok",
        hostname: "eapi.pcloud.com",
        folderId: 1,
        filename: "x.mp3",
        bytes: BYTES,
      }),
    ).rejects.toMatchObject({ isAuthError: true });
  });

  it("błąd sieci → isNetworkError (token zostaje, nie czyścimy)", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    await expect(
      uploadFileOverwrite({
        token: "tok",
        hostname: "eapi.pcloud.com",
        folderId: 1,
        filename: "x.mp3",
        bytes: BYTES,
      }),
    ).rejects.toMatchObject({ isNetworkError: true });
  });

  it("brak folderId → natychmiastowy błąd (nie zgadujemy folderu)", async () => {
    await expect(
      uploadFileOverwrite({
        token: "tok",
        hostname: "eapi.pcloud.com",
        folderId: /** @type {any} */ (null),
        filename: "x.mp3",
        bytes: BYTES,
      }),
    ).rejects.toThrow(/folderId/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
