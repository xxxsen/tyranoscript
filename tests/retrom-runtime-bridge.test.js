const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { createContext, runInContext } = require("node:vm");

const bridgeSource = readFileSync(resolve(__dirname, "../retrom-runtime/bridge.js"), "utf8");

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function runtimeFixture({
    emitLoadComplete = true,
    checkpointReady = true,
    legacyEngine = false,
    legacyMedia = false,
    engineReadyAtConnect = true,
    stalledAnimation = false,
    blockedLegacyAudio = false,
} = {}) {
    const windowListeners = new Map();
    const engineListeners = new Map();
    const frameCallbacks = [];
    const intervalCallbacks = new Map();
    const replies = [];
    const actions = [];
    let closeCalls = 0;
    let restoreOptions = null;
    let canShowMenu = checkpointReady;
    let now = 0;
    const gamepadState = {
        buttons: Array.from({ length: 17 }, () => ({ pressed: false })),
    };
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
                    title: "fixture",
                };
                if (legacyEngine) {
                    this.snap.img_data = "";
                    this.snap.save_date = "fixture-date";
                } else this.snap.three = { models: {}, stat: {} };
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
        weaklyStop() { actions.push("pause"); },
        cancelWeakStop() { actions.push("resume"); },
    };
    if (blockedLegacyAudio) {
        kag.tmp = { ready_audio: false };
        kag.layer = { showEventLayer() { actions.push("legacy-audio:event-layer"); } };
        kag.ftag.nextOrder = () => { actions.push("legacy-audio:next-order"); };
        kag.ftag.master_tag = {
            playbgm: { start(pm) { actions.push(`legacy-audio:native-tag:${pm.target}`); } },
        };
    }
    if (!legacyEngine) {
        kag.on = (eventName, callback) => {
            const event = eventName.split(".")[0];
            engineListeners.set(event, [...(engineListeners.get(event) || []), { callback }]);
        };
        kag.once = (eventName, callback) => {
            const event = eventName.split(".")[0];
            engineListeners.set(event, [...(engineListeners.get(event) || []), { callback }]);
        };
        kag.off = (eventName) => {
            if (eventName.startsWith(".")) engineListeners.clear();
        };
    } else {
        delete kag.weaklyStop;
        delete kag.cancelWeakStop;
    }
    const howl = {
        _sounds: [{ _id: 7 }],
        pause(id) { actions.push(`audio-pause:${id}`); },
        play(id) { actions.push(`audio-resume:${id}`); },
        playing(id) { return id === 7; },
    };
    const media = {
        ended: false,
        paused: false,
        volume: 1,
        pause() { this.paused = true; actions.push("media-pause"); },
        play() { this.paused = false; actions.push("media-resume"); return Promise.resolve(); },
    };
    const animation = {
        currentTime: 0,
        effect: { getComputedTiming: () => ({ duration: 500 }) },
        playState: "running",
        startTime: null,
    };
    const animated = {
        dispatchEvent(event) {
            actions.push(`animation:${event.type}`);
            animation.currentTime = 500;
            animation.playState = "finished";
            animation.startTime = 0;
        },
        getAnimations() { return [animation]; },
    };
    const BlockedHTMLMediaElement = blockedLegacyAudio ? class HTMLMediaElement {
        dispatchEvent(event) { actions.push(`blocked-media:${event.type}`); }
        play() {
            actions.push("blocked-media:native-play");
            return Promise.reject(Object.assign(new Error("autoplay blocked"), { name: "NotAllowedError" }));
        }
    } : undefined;
    const BlockedAudio = blockedLegacyAudio ? class Audio extends BlockedHTMLMediaElement {
        constructor(src = "") {
            super();
            this.src = src;
            actions.push(`blocked-audio:${src}`);
        }
    } : undefined;
    const runtime = {
        Audio: BlockedAudio,
        Howler: { _howls: [howl], volume(value) { actions.push(`volume:${value}`); } },
        TYRANO: engineReadyAtConnect ? { kag } : {},
        addEventListener(name, callback) { windowListeners.set(name, callback); },
        cancelAnimationFrame() {},
        clearInterval(identifier) { intervalCallbacks.delete(identifier); },
        clearTimeout,
        close() { closeCalls += 1; },
        CustomEvent: class CustomEvent {
            constructor(type, init) { this.type = type; this.detail = init.detail; }
        },
        Event: class Event {
            constructor(type) { this.type = type; }
        },
        HTMLMediaElement: BlockedHTMLMediaElement,
        document: {
            createElement(name) {
                if (!blockedLegacyAudio || name !== "audio") return {};
                actions.push("blocked-audio-element");
                const mediaElement = new BlockedHTMLMediaElement();
                mediaElement.src = "";
                return mediaElement;
            },
            dispatchEvent(event) { actions.push(`document:${event.type}`); },
            querySelectorAll(selector) {
                if (selector === ".animated") return stalledAnimation ? [animated] : [];
                return legacyMedia ? [media] : [];
            },
        },
        KeyboardEvent: class KeyboardEvent {
            constructor(type) { this.type = type; }
        },
        navigator: {
            userActivation: blockedLegacyAudio ? { hasBeenActive: false, isActive: false } : undefined,
            getGamepads() {
                return [{
                    buttons: gamepadState.buttons,
                    connected: true,
                    index: 0,
                    mapping: "standard",
                }];
            },
        },
        parent: null,
        performance: { now: () => now },
        postMessage() {},
        removeEventListener(name) { windowListeners.delete(name); },
        requestAnimationFrame(callback) { frameCallbacks.push(callback); return frameCallbacks.length; },
        setInterval(callback) {
            const identifier = intervalCallbacks.size + 1;
            intervalCallbacks.set(identifier, callback);
            return identifier;
        },
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
        advanceTime(milliseconds) { now += milliseconds; },
        closeCalls: () => closeCalls,
        createBlockedMedia() { return new runtime.HTMLMediaElement(); },
        createLegacyAudio(src) { return new runtime.Audio(src); },
        kag,
        port,
        replies,
        request,
        restoreOptions: () => restoreOptions,
        runtime,
        media,
        setGamepadButton(index, pressed) { gamepadState.buttons[index] = { pressed }; },
        setCheckpointReady(value) { canShowMenu = value; },
        setCurrentTag(name) { kag.ftag.array_tag[0].name = name; },
        setEngineReady() { runtime.TYRANO.kag = kag; },
        tick() {
            const callback = frameCallbacks.shift();
            if (callback) callback();
        },
        watchdogTick() {
            for (const callback of intervalCallbacks.values()) callback();
        },
    };
}

test("reports READY through the watchdog when iframe animation frames are throttled", () => {
    const fixture = runtimeFixture({ engineReadyAtConnect: false });
    assert.equal(fixture.replies.some((value) => value.type === "READY"), false);

    fixture.setEngineReady();
    fixture.watchdogTick();

    assert.equal(fixture.replies.filter((value) => value.type === "READY").length, 1);
});

test("finishes an old Tyrano CSS animation that never receives a browser start time", () => {
    const fixture = runtimeFixture({ stalledAnimation: true });

    fixture.advanceTime(749);
    fixture.watchdogTick();
    assert.equal(fixture.actions.includes("animation:animationend"), false);

    fixture.advanceTime(1);
    fixture.watchdogTick();
    assert.equal(fixture.actions.filter((value) => value === "animation:animationend").length, 1);
    fixture.advanceTime(1_000);
    fixture.watchdogTick();
    assert.equal(fixture.actions.filter((value) => value === "animation:animationend").length, 1);
});

test("lets Tyrano 4.x continue silently before a trusted audio gesture", async () => {
    const fixture = runtimeFixture({ blockedLegacyAudio: true, legacyEngine: true });
    assert.equal(fixture.kag.tmp.ready_audio, true);

    const automaticAudio = fixture.createLegacyAudio("./data/sound/automatic.ogg");
    assert.equal(automaticAudio.src, "");
    assert.equal(fixture.actions.includes("blocked-audio-element"), true);
    assert.equal(fixture.actions.includes("blocked-audio:./data/sound/automatic.ogg"), false);
    await automaticAudio.play();

    assert.deepEqual(fixture.actions.slice(-1), ["blocked-media:play"]);
    fixture.kag.ftag.master_tag.playbgm.start({target: "se"});
    assert.deepEqual(fixture.actions.slice(-2), ["legacy-audio:event-layer", "legacy-audio:next-order"]);

    fixture.runtime.navigator.userActivation.hasBeenActive = true;
    const activatedAudio = fixture.createLegacyAudio("./data/sound/activated.ogg");
    assert.equal(activatedAudio.src, "./data/sound/activated.ogg");
    fixture.kag.ftag.master_tag.playbgm.start({target: "bgm"});
    assert.deepEqual(fixture.actions.slice(-1), ["legacy-audio:native-tag:bgm"]);
});

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

test("checkpoints and restores a TyranoScript 4.x snapshot without modern event APIs", async () => {
    const fixture = runtimeFixture({ legacyEngine: true });
    fixture.kag.stat.f.marker = "B";
    const saved = await fixture.request("CHECKPOINT");
    assert.equal(saved.type, "CHECKPOINT_RESULT");
    const decoded = JSON.parse(new TextDecoder().decode(new Uint8Array(saved.body.data)));
    assert.equal(decoded.snapshot.three, undefined);
    assert.equal(decoded.snapshot.stat.f.marker, "B");
    assert.equal(typeof fixture.kag.once, "function");

    fixture.kag.stat.f.marker = "C";
    const restored = await fixture.request("RESTORE", { data: saved.body.data });
    assert.equal(restored.type, "RESTORE_RESULT");
    assert.equal(fixture.kag.stat.f.marker, "B");
});

test("projects a standard gamepad B edge through the TyranoScript 4.x event facade", () => {
    const fixture = runtimeFixture({ legacyEngine: true });
    let observed = null;
    fixture.kag.once("gamepad-pressdown.retrom-test", (event) => { observed = event.detail.button_name; });

    fixture.setGamepadButton(1, true);
    fixture.tick();

    assert.equal(observed, "B");
    assert.equal(fixture.actions.includes("document:keydown"), true);
});

test("pauses, resumes, and changes volume on TyranoScript 4.x HTML media", async () => {
    const fixture = runtimeFixture({ legacyEngine: true, legacyMedia: true });
    assert.equal((await fixture.request("PAUSE")).type, "PAUSE_RESULT");
    assert.equal(fixture.media.paused, true);
    assert.equal((await fixture.request("RESUME")).type, "RESUME_RESULT");
    assert.equal(fixture.media.paused, false);
    assert.equal((await fixture.request("SET_VOLUME", { value: 0.35 })).type, "SET_VOLUME_RESULT");
    assert.equal(fixture.media.volume, 0.35);
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
