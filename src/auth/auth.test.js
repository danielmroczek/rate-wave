// Testy modułu OAuth (bilet 03) — oauth.js, token-store.js, pcloud-api.js.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { openDB } from "../store/db.js";
import {
  buildAuthUrl,
  generateState,
  verifyState,
  getRedirectUri,
  STATE_KEY,
  CLIENT_ID,
} from "./oauth.js";
import {
  saveToken,
  loadTokenFromLS,
  loadTokenFromDB,
  clearToken,
  apiBaseUrl,
  PCLOUD_SOURCE_KEY,
} from "./token-store.js";
import { pcloudApi, validateToken } from "./pcloud-api.js";
import { put, STORES } from "../store/db.js";

// ── Pomocnicze ──

/** @type {IDBFactory} */
let factory;
/** @type {IDBDatabase | undefined} */
let db;
let localStorage;

function makeEnv() {
  const idb = /** @type {any} */ (new IDBFactory());
  const storage = new Map();
  const localStorage = /** @type {any} */ ({
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
    clear: () => storage.clear(),
    get _size() {
      return storage.size;
    },
  });
  return { idb, localStorage };
}

beforeEach(() => {
  ({ idb: factory, localStorage } = makeEnv());
});

afterEach(async () => {
  if (db) {
    db.close();
    db = undefined;
  }
});

// ── oauth.js ──

describe("oauth.js — CLIENT_ID i redirect URI", () => {
  it("CLIENT_ID jest właściwy (appka rate-wave)", () => {
    expect(CLIENT_ID).toBe("8imNt7HXdPm");
  });

  it("getRedirectUri zwraca dev URI dla localhost", () => {
    const uri = getRedirectUri({ hostname: "localhost" });
    expect(uri).toBe("http://localhost:5173/");
  });

  it("getRedirectUri zwraca prod URI dla github.io", () => {
    const uri = getRedirectUri({ hostname: "danielmroczek.github.io" });
    expect(uri).toBe("https://danielmroczek.github.io/rate-wave/oauth.html");
  });

  it("getRedirectUri zwraca dev URI dla 127.0.0.1", () => {
    const uri = getRedirectUri({ hostname: "127.0.0.1" });
    expect(uri).toBe("http://localhost:5173/");
  });
});

describe("oauth.js — state (anty-CSRF)", () => {
  it("generateState zapisuje state w localStorage i zwraca losowy string", () => {
    const state = generateState(localStorage);
    expect(typeof state).toBe("string");
    expect(state.length).toBe(32);
    const stored = JSON.parse(localStorage.getItem(STATE_KEY));
    expect(stored.v).toBe(state);
    expect(typeof stored.t).toBe("number");
  });

  it("verifyState akceptuje poprawny state", () => {
    const state = generateState(localStorage);
    expect(verifyState(state, localStorage)).toBe(true);
  });

  it("verifyState odrzuca niezgodny state", () => {
    generateState(localStorage);
    expect(verifyState("wrong-state", localStorage)).toBe(false);
  });

  it("verifyState odrzuca gdy localStorage nie ma state", () => {
    expect(verifyState("anything", localStorage)).toBe(false);
  });

  it("verifyState czyści state z localStorage po weryfikacji (jednorazowy)", () => {
    const state = generateState(localStorage);
    verifyState(state, localStorage);
    expect(verifyState(state, localStorage)).toBe(false);
  });

  it("verifyState odrzuca przeterminowany state", () => {
    localStorage.setItem(STATE_KEY, JSON.stringify({ v: "abc", t: Date.now() - 11 * 60 * 1000 }));
    expect(verifyState("abc", localStorage)).toBe(false);
  });

  it("verifyState odrzuca zepsuty JSON w localStorage", () => {
    localStorage.setItem(STATE_KEY, "not-json");
    expect(verifyState("anything", localStorage)).toBe(false);
  });

  it("verifyState odrzuca gdy pola v/t mają zły typ", () => {
    localStorage.setItem(STATE_KEY, JSON.stringify({ v: 123, t: "not-number" }));
    expect(verifyState("123", localStorage)).toBe(false);
  });
});

describe("oauth.js — buildAuthUrl", () => {
  it("buduje poprawny URL autoryzacji", () => {
    const url = new URL(
      buildAuthUrl({ redirectUri: "http://localhost:5173/", state: "test-state" }),
    );
    expect(url.origin).toBe("https://my.pcloud.com");
    expect(url.pathname).toBe("/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("response_type")).toBe("token");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:5173/");
    expect(url.searchParams.get("state")).toBe("test-state");
  });

  it("generuje state automatycznie gdy nie podano", () => {
    const url = new URL(buildAuthUrl({ redirectUri: "http://localhost:5173/", localStorage }));
    const state = url.searchParams.get("state");
    expect(state).toBeTruthy();
    expect(state.length).toBe(32);
  });
});

// ── token-store.js ──

describe("token-store.js — saveToken + loadTokenFromLS", () => {
  beforeEach(async () => {
    db = await openDB(factory);
  });

  it("saveToken zapisuje token do localStorage i loadTokenFromLS czyta", async () => {
    await saveToken({ db, token: "abc", hostname: "eapi.pcloud.com", locationid: 2, localStorage });

    const result = loadTokenFromLS(localStorage);
    expect(result).toEqual({
      token: "abc",
      hostname: "eapi.pcloud.com",
      locationid: 2,
    });
  });

  it("loadTokenFromLS zwraca null gdy brak tokenu", () => {
    const result = loadTokenFromLS(localStorage);
    expect(result).toBeNull();
  });

  it("loadTokenFromDB czyta z IDB (+ folder biblioteki, bilet #17)", async () => {
    await saveToken({ db, token: "xyz", hostname: "api.pcloud.com", locationid: 1, localStorage });
    const result = await loadTokenFromDB(db);
    expect(result).toEqual({
      token: "xyz",
      hostname: "api.pcloud.com",
      locationid: 1,
      folderId: null,
      folderName: null,
    });
    await put(db, STORES.SOURCES, PCLOUD_SOURCE_KEY, {
      token: "xyz",
      folderId: "7",
      folderName: "Muzyka",
    });
    const again = await loadTokenFromDB(db);
    expect(again.folderId).toBe("7");
    expect(again.folderName).toBe("Muzyka");
  });

  it("clearToken usuwa token z localStorage i IDB", async () => {
    await saveToken({
      db,
      token: "todelete",
      hostname: "api.pcloud.com",
      locationid: 1,
      localStorage,
    });
    await clearToken({ db, localStorage });

    expect(loadTokenFromLS(localStorage)).toBeNull();
    const fromDB = await loadTokenFromDB(db);
    expect(fromDB).toBeNull();
  });

  it("loadTokenFromDB zwraca null gdy brak rekordu", async () => {
    const result = await loadTokenFromDB(db);
    expect(result).toBeNull();
  });

  it("loadTokenFromLS używa domyślnych wartości gdy brak hostname/locationid", async () => {
    localStorage.setItem("rate-wave.pcloud.token", "bare-token");
    const result = loadTokenFromLS(localStorage);
    expect(result).toEqual({
      token: "bare-token",
      hostname: "api.pcloud.com",
      locationid: 1,
    });
  });
});

describe("token-store.js — apiBaseUrl", () => {
  it("zwraca eapi.pcloud.com dla hostname EU", () => {
    expect(apiBaseUrl({ hostname: "eapi.pcloud.com" })).toBe("https://eapi.pcloud.com");
  });

  it("zwraca api.pcloud.com domyślnie", () => {
    expect(apiBaseUrl()).toBe("https://api.pcloud.com");
  });

  it("czyta hostname z localStorage gdy nie podano jawnie", () => {
    localStorage.setItem("rate-wave.pcloud.hostname", "eapi.pcloud.com");
    expect(apiBaseUrl({ localStorage })).toBe("https://eapi.pcloud.com");
  });
});

// ── pcloud-api.js ──

describe("pcloud-api.js — pcloudApi", () => {
  it("konstruuje poprawny URL z tokenem jako query param", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ result: 0, userid: 1, email: "a@b", name: "Test" }), {
        headers: { "Content-Type": "application/json" },
      }),
    );

    await pcloudApi({
      method: "userinfo",
      token: "test-token",
      hostname: "eapi.pcloud.com",
    });

    const calledUrl = new URL(fetchSpy.mock.calls[0][0]);
    expect(calledUrl.origin).toBe("https://eapi.pcloud.com");
    expect(calledUrl.pathname).toBe("/userinfo");
    expect(calledUrl.searchParams.get("access_token")).toBe("test-token");

    fetchSpy.mockRestore();
  });

  it("rzuca błąd gdy result !== 0", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ result: 2000, error: "Invalid token" }), {
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      pcloudApi({ method: "userinfo", token: "bad", hostname: "api.pcloud.com" }),
    ).rejects.toThrow("pCloud API error 2000");
  });

  it("rzuca błąd gdy HTTP fail", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Internal Server Error", { status: 500 }),
    );

    await expect(
      pcloudApi({ method: "userinfo", token: "tok", hostname: "api.pcloud.com" }),
    ).rejects.toThrow("pCloud API HTTP 500");
  });
});

describe("pcloud-api.js — validateToken", () => {
  it("zwraca dane użytkownika przy poprawnym tokenie", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ result: 0, userid: 42, email: "user@test.com", name: "Test User" }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );

    const info = await validateToken({ token: "valid", hostname: "api.pcloud.com" });
    expect(info).toEqual({ userid: 42, email: "user@test.com", name: "Test User" });
  });

  it("rzuca błąd przy nieważnym tokenie", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ result: 2000, error: "Invalid access token" }), {
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(validateToken({ token: "invalid", hostname: "api.pcloud.com" })).rejects.toThrow();
  });
});
