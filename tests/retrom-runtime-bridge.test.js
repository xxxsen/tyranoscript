const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { createContext, runInContext } = require("node:vm");

const bridgeSource = readFileSync(resolve(__dirname, "../retrom-runtime/bridge.js"), "utf8");

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function runtimeFixture({ emitLoadComplete = true, checkpointReady = true } = {}) {
    const windowListeners = new Map();
    const engineListeners = new Map();
    const frameCallbacks = [];
    const replies = [];
    const actions = [];
    let closeCalls = 0;
    let restoreOptions = null;
    let canShowMenu = checkpointReady;
    const kag = {
        ftag: { array_tag: [{ name: "s" }], current_order_index: 0 },
        key_mouse: { util: { canShowMenu: () => canShowMenu } },
        stat: { current_scenario: "first.ks", f: { marker: "A" } },
        menu: {
            snap: null,
            snapSave(_title, callback, thumbnail) {
                actions.push(`checkpoint:${thumbnail}`);
                this.snap = {
                    current_order_index: 4,
                    layer: { message: "fixture" },
                    stat: JSON.parse(JSON.stringify(kag.stat)),
                    three: { models: {}, stat: {} },
                    title: "fixture",
                };
                callback();
            },
            loadGameData(snapshot, options) {
                actions.push("restore");
                restoreOptions = options;
                queueMicrotask(() => {
                    for (const listener of engineListeners.get("nextorder") || []) listener.callback({
                        index: snapshot.current_order_index + 1,
                        scenario: snapshot.stat.current_scenario,
                    });
                    kag.stat.current_scenario = "make.ks";
                    for (const listener of engineListeners.get("nextorder") || []) {
                        listener.callback({ index: 0, scenario: "make.ks" });
                    }
                    queueMicrotask(() => {
                        kag.stat = JSON.parse(JSON.stringify(snapshot.stat));
                        kag.ftag.current_order_index = snapshot.current_order_index + 1;
                        if (emitLoadComplete) {
                            for (const listener of engineListeners.get("load-complete") || []) listener.callback();
                            engineListeners.delete("load-complete");
                        }
                    });
                });
            },
        },
        on(eventName, callback) {
            const event = eventName.split(".")[0];
            engineListeners.set(event, [...(engineListeners.get(event) || []), { callback }]);
        },
        once(eventName, callback) {
            const event = eventName.split(".")[0];
            engineListeners.set(event, [...(engineListeners.get(event) || []), { callback }]);
        },
        off(eventName) {
            if (eventName.startsWith(".")) engineListeners.clear();
        },
        weaklyStop() { actions.push("pause"); },
        cancelWeakStop() { actions.push("resume"); },
    };
    const howl = {
        _sounds: [{ _id: 7 }],
        pause(id) { actions.push(`audio-pause:${id}`); },
        play(id) { actions.push(`audio-resume:${id}`); },
        playing(id) { return id === 7; },
    };
    const runtime = {
        Howler: { _howls: [howl], volume(value) { actions.push(`volume:${value}`); } },
        TYRANO: { kag },
        addEventListener(name, callback) { windowListeners.set(name, callback); },
        cancelAnimationFrame() {},
        clearTimeout,
        close() { closeCalls += 1; },
        parent: null,
        postMessage() {},
        removeEventListener(name) { windowListeners.delete(name); },
        requestAnimationFrame(callback) { frameCallbacks.push(callback); return frameCallbacks.length; },
        setTimeout,
    };
    runtime.parent = runtime;
    const context = createContext({
        ArrayBuffer,
        JSON,
        Number,
        Promise,
        TextDecoder,
        TextEncoder,
        Uint8Array,
        queueMicrotask,
        window: runtime,
    });
    runInContext(bridgeSource, context);
    const port = {
        closed: false,
        onmessage: null,
        postMessage(message) { replies.push(message); },
        start() {},
        close() { this.closed = true; },
    };
    windowListeners.get("message")({
        data: {
            nonce: "0123456789abcdef",
            parentOrigin: "https://host.example",
            protocolVersion: 1,
            sessionId: "test-session",
            type: "GAME_RUNTIME_TYRANOSCRIPT_CONNECT",
        },
        origin: "https://host.example",
        ports: [port],
        source: runtime,
    });
    frameCallbacks.shift()();

    let requestId = 0;
    async function request(type, body = {}) {
        requestId += 1;
        port.onmessage({ data: {
            body,
            nonce: "0123456789abcdef",
            protocolVersion: 1,
            requestId,
            sessionId: "test-session",
            type,
        } });
        for (let attempt = 0; attempt < 50; attempt += 1) {
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
            const reply = replies.find((value) => value.requestId === requestId);
            if (reply) return reply;
        }
        throw new Error(`missing reply for ${type}`);
    }

    return {
        actions,
        closeCalls: () => closeCalls,
        kag,
        port,
        replies,
        request,
        restoreOptions: () => restoreOptions,
        runtime,
        setCheckpointReady(value) { canShowMenu = value; },
        setCurrentTag(name) { kag.ftag.array_tag[0].name = name; },
    };
}

test("checkpoints and restores the TyranoScript snapshot in the same wire format", async () => {
    const fixture = runtimeFixture();
    assert.deepEqual(plain(fixture.replies[0]), {
        body: { checkpointAvailable: true, engine: "TYRANOSCRIPT" },
        nonce: "0123456789abcdef",
        protocolVersion: 1,
        requestId: 0,
        sessionId: "test-session",
        type: "READY",
    });

    fixture.kag.stat.f.marker = "B";
    const saved = await fixture.request("CHECKPOINT");
    assert.equal(saved.type, "CHECKPOINT_RESULT");
    assert.equal(saved.body.format, "tyranoscript-snapshot-v1");
    const decoded = JSON.parse(new TextDecoder().decode(new Uint8Array(saved.body.data)));
    assert.equal(decoded.snapshot.stat.f.marker, "B");
    assert.equal(decoded.snapshot.img_data, undefined);

    fixture.kag.stat.f.marker = "C";
    const restored = await fixture.request("RESTORE", { data: saved.body.data });
    assert.equal(restored.type, "RESTORE_RESULT");
    assert.equal(fixture.kag.stat.f.marker, "B");
    assert.deepEqual(plain(fixture.restoreOptions()), { auto_next: "no", bgm_over: "false" });
    assert.deepEqual(fixture.actions.slice(0, 2), ["checkpoint:false", "restore"]);
});

test("recognizes a completed restore when the engine omits load-complete", async () => {
    const fixture = runtimeFixture({ emitLoadComplete: false });
    fixture.kag.stat.f.marker = "B";
    const saved = await fixture.request("CHECKPOINT");
    fixture.kag.stat.f.marker = "C";

    const restored = await fixture.request("RESTORE", { data: saved.body.data });

    assert.equal(restored.type, "RESTORE_RESULT");
    assert.equal(fixture.kag.stat.f.marker, "B");
});

test("keeps checkpoints unavailable while the engine is between stable menu states", async () => {
    const fixture = runtimeFixture({ checkpointReady: false });
    assert.equal((await fixture.request("PROBE")).body.checkpointAvailable, false);
    assert.equal((await fixture.request("CHECKPOINT")).body.code, "TYRANOSCRIPT_CHECKPOINT_UNAVAILABLE");

    fixture.setCheckpointReady(true);
    assert.equal((await fixture.request("PROBE")).body.checkpointAvailable, true);
});

test("does not advertise a checkpoint while an active scenario tag is running", async () => {
    const fixture = runtimeFixture();
    fixture.setCurrentTag("bg");
    assert.equal((await fixture.request("PROBE")).body.checkpointAvailable, false);
    assert.equal((await fixture.request("CHECKPOINT")).body.code, "TYRANOSCRIPT_CHECKPOINT_UNAVAILABLE");

    fixture.setCurrentTag("s");
    assert.equal((await fixture.request("PROBE")).body.checkpointAvailable, true);
});

test("pauses audio, resumes input state, and updates checkpoint availability", async () => {
    const fixture = runtimeFixture();
    assert.equal((await fixture.request("PAUSE")).type, "PAUSE_RESULT");
    assert.deepEqual(fixture.actions, ["pause", "audio-pause:7"]);
    assert.equal((await fixture.request("PROBE")).body.checkpointAvailable, true);
    fixture.kag.stat.f.marker = "PAUSED";
    const checkpoint = await fixture.request("CHECKPOINT");
    assert.equal(checkpoint.type, "CHECKPOINT_RESULT");
    const decoded = JSON.parse(new TextDecoder().decode(new Uint8Array(checkpoint.body.data)));
    assert.equal(decoded.snapshot.stat.f.marker, "PAUSED");

    assert.equal((await fixture.request("RESUME")).type, "RESUME_RESULT");
    assert.deepEqual(fixture.actions, [
        "pause", "audio-pause:7", "resume", "checkpoint:false", "pause", "resume", "audio-resume:7",
    ]);
    assert.equal((await fixture.request("SET_VOLUME", { value: 0.4 })).type, "SET_VOLUME_RESULT");
    assert.equal(fixture.actions.at(-1), "volume:0.4");
    assert.equal((await fixture.request("PROBE")).body.checkpointAvailable, true);
});

test("reports a core-owned close exactly once and rejects later checkpoints", async () => {
    const fixture = runtimeFixture();
    fixture.runtime.close();
    fixture.runtime.close();
    assert.equal(fixture.closeCalls(), 2);
    assert.equal(fixture.replies.filter((value) => value.type === "EXIT_REQUESTED").length, 1);
    const checkpoint = await fixture.request("CHECKPOINT");
    assert.deepEqual(plain(checkpoint.body), { code: "TYRANOSCRIPT_CHECKPOINT_UNAVAILABLE" });
    assert.equal(checkpoint.type, "ERROR");
});

test("rejects a malformed restore without mutating the running scene", async () => {
    const fixture = runtimeFixture();
    const malformed = new TextEncoder().encode("{}").buffer;
    const reply = await fixture.request("RESTORE", { data: malformed });
    assert.equal(reply.type, "ERROR");
    assert.deepEqual(plain(reply.body), { code: "TYRANOSCRIPT_CHECKPOINT_INVALID" });
    assert.equal(fixture.kag.stat.f.marker, "A");
});
