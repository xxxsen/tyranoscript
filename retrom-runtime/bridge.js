(function installTyranoScriptRuntimeBridge(global) {
    "use strict";

    const PROTOCOL_VERSION = 1;
    const CHECKPOINT_FORMAT = "tyranoscript-snapshot-v1";
    const MAX_CHECKPOINT_BYTES = 32 * 1024 * 1024;
    const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
    const RESTORE_TIMEOUT_MS = 30_000;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const nativeClose = typeof global.close === "function" ? global.close.bind(global) : function () {};
    let sessionId = null;
    let nonce = null;
    let parentOrigin = null;
    let port = null;
    let exited = false;
    let paused = false;
    let readySent = false;
    let frameCount = 0;
    let animationFrameId = 0;
    let pausedHowls = [];

    function ownKeys(value, expected) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const actual = Object.keys(value).sort();
        const sortedExpected = expected.slice().sort();
        return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
    }

    function engine() {
        const kag = global.TYRANO && global.TYRANO.kag;
        return kag && kag.menu && typeof kag.menu.snapSave === "function" &&
            typeof kag.menu.loadGameData === "function" ? kag : null;
    }

    function checkpointAvailable() {
        const kag = engine();
        if (exited || !kag || !kag.stat || typeof kag.stat.current_scenario !== "string" ||
            !kag.stat.current_scenario || kag.stat.is_wait || kag.stat.is_adding_text) return false;
        const canShowMenu = kag.key_mouse && kag.key_mouse.util && kag.key_mouse.util.canShowMenu;
        if (typeof canShowMenu !== "function") return true;
        try {
            return Boolean(canShowMenu.call(kag.key_mouse.util));
        } catch {
            return false;
        }
    }

    function envelope(requestId, type, body) {
        return { protocolVersion: PROTOCOL_VERSION, sessionId, nonce, requestId, type, body };
    }

    function send(requestId, type, body, transfer) {
        if (!port) return;
        port.postMessage(envelope(requestId, type, body), transfer || []);
    }

    function event(type, body) {
        send(0, type, body);
    }

    function stableCode(error, fallback) {
        const message = error && typeof error.message === "string" ? error.message : "";
        return /^[A-Z][A-Z0-9_]{2,80}$/.test(message) ? message : fallback;
    }

    function reportExitRequested() {
        if (exited) return;
        exited = true;
        pausedHowls = [];
        event("EXIT_REQUESTED", {});
        event("CHECKPOINT_AVAILABILITY", { available: false });
    }

    global.close = function closeFromTyranoScript() {
        reportExitRequested();
        return nativeClose();
    };

    function frameTick() {
        if (exited) return;
        frameCount += 1;
        if (!readySent && engine()) {
            readySent = true;
            event("READY", { checkpointAvailable: checkpointAvailable(), engine: "TYRANOSCRIPT" });
        }
        animationFrameId = global.requestAnimationFrame(frameTick);
    }

    function cloneJSON(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function validateSnapshot(snapshot) {
        if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) ||
            !snapshot.stat || typeof snapshot.stat !== "object" || Array.isArray(snapshot.stat) ||
            typeof snapshot.stat.current_scenario !== "string" || !snapshot.stat.current_scenario ||
            !Number.isSafeInteger(snapshot.current_order_index) || snapshot.current_order_index < -1 ||
            !("layer" in snapshot) || !snapshot.three || typeof snapshot.three !== "object") {
            throw new Error("TYRANOSCRIPT_CHECKPOINT_INVALID");
        }
        return snapshot;
    }

    function encodeCheckpoint(snapshot) {
        let bytes;
        try {
            bytes = encoder.encode(JSON.stringify({
                engine: "TYRANOSCRIPT",
                schemaVersion: 1,
                snapshot: validateSnapshot(snapshot),
            }));
        } catch (error) {
            if (stableCode(error, "") === "TYRANOSCRIPT_CHECKPOINT_INVALID") throw error;
            throw new Error("TYRANOSCRIPT_CHECKPOINT_CREATE_FAILED");
        }
        if (!bytes.byteLength || bytes.byteLength > MAX_CHECKPOINT_BYTES) {
            throw new Error("TYRANOSCRIPT_CHECKPOINT_TOO_LARGE");
        }
        return bytes;
    }

    function decodeCheckpoint(data) {
        if (!(data instanceof ArrayBuffer) || !data.byteLength || data.byteLength > MAX_CHECKPOINT_BYTES) {
            throw new Error("TYRANOSCRIPT_CHECKPOINT_INVALID");
        }
        let value;
        try {
            value = JSON.parse(decoder.decode(new Uint8Array(data)));
        } catch {
            throw new Error("TYRANOSCRIPT_CHECKPOINT_INVALID");
        }
        if (!ownKeys(value, ["engine", "schemaVersion", "snapshot"]) || value.engine !== "TYRANOSCRIPT" ||
            value.schemaVersion !== 1) {
            throw new Error("TYRANOSCRIPT_CHECKPOINT_INVALID");
        }
        return cloneJSON(validateSnapshot(value.snapshot));
    }

    function checkpoint() {
        if (!checkpointAvailable()) return Promise.reject(new Error("TYRANOSCRIPT_CHECKPOINT_UNAVAILABLE"));
        const kag = engine();
        return new Promise((resolve, reject) => {
            let completed = false;
            const restoreWeakStop = paused;
            if (restoreWeakStop && typeof kag.cancelWeakStop === "function") {
                kag.cancelWeakStop();
                paused = false;
            }
            function finish(error) {
                if (completed) return;
                completed = true;
                if (restoreWeakStop) {
                    if (typeof kag.weaklyStop === "function") kag.weaklyStop();
                    paused = true;
                }
                if (error) reject(error);
                else {
                    try {
                        resolve(encodeCheckpoint(cloneJSON(kag.menu.snap)));
                    } catch (encodeError) {
                        reject(encodeError);
                    }
                }
            }
            try {
                kag.menu.snapSave("Retrom checkpoint", () => finish(), "false");
            } catch {
                finish(new Error("TYRANOSCRIPT_CHECKPOINT_CREATE_FAILED"));
            }
        });
    }

    function restore(data) {
        if (exited) return Promise.reject(new Error("TYRANOSCRIPT_CHECKPOINT_RESTORE_FAILED"));
        const snapshot = decodeCheckpoint(data);
        const kag = engine();
        if (!kag) return Promise.reject(new Error("TYRANOSCRIPT_RUNTIME_NOT_READY"));
        return new Promise((resolve, reject) => {
            let completed = false;
            let makeStarted = false;
            let pollTimer = 0;
            const timer = global.setTimeout(() => finish(new Error("TYRANOSCRIPT_CHECKPOINT_RESTORE_TIMEOUT")), RESTORE_TIMEOUT_MS);
            function finish(error) {
                if (completed) return;
                completed = true;
                global.clearTimeout(timer);
                if (pollTimer) global.clearTimeout(pollTimer);
                if (typeof kag.off === "function") kag.off(".retrom-runtime-restore");
                if (error) reject(error);
                else resolve();
            }
            function pollTarget() {
                if (completed) return;
                if (makeStarted && kag.stat.current_scenario === snapshot.stat.current_scenario &&
                    kag.ftag && kag.ftag.current_order_index === snapshot.current_order_index + 1) {
                    finish();
                    return;
                }
                pollTimer = global.setTimeout(pollTarget, 16);
            }
            function observeRestoreOrder(eventObject) {
                if (eventObject && eventObject.scenario === "make.ks") makeStarted = true;
            }
            try {
                kag.once("load-complete.retrom-runtime-restore", () => finish());
                kag.on("nextorder.retrom-runtime-restore", observeRestoreOrder);
                kag.menu.loadGameData(snapshot, { auto_next: "no", bgm_over: "false" });
                pollTarget();
            } catch {
                finish(new Error("TYRANOSCRIPT_CHECKPOINT_RESTORE_FAILED"));
            }
        });
    }

    function pauseAudio() {
        const howler = global.Howler;
        if (!howler || !Array.isArray(howler._howls)) return;
        pausedHowls = [];
        howler._howls.forEach((howl) => {
            if (!howl || !Array.isArray(howl._sounds)) return;
            howl._sounds.forEach((sound) => {
                if (sound && typeof howl.playing === "function" && howl.playing(sound._id)) {
                    pausedHowls.push({ howl, id: sound._id });
                    howl.pause(sound._id);
                }
            });
        });
    }

    function resumeAudio() {
        const pending = pausedHowls;
        pausedHowls = [];
        pending.forEach(({ howl, id }) => {
            if (howl && typeof howl.play === "function") howl.play(id);
        });
    }

    function pause() {
        if (exited || paused) return;
        const kag = engine();
        if (kag && typeof kag.weaklyStop === "function") kag.weaklyStop();
        pauseAudio();
        paused = true;
        event("CHECKPOINT_AVAILABILITY", { available: checkpointAvailable() });
    }

    function resume() {
        if (exited || !paused) return;
        const kag = engine();
        if (kag && typeof kag.cancelWeakStop === "function") kag.cancelWeakStop();
        resumeAudio();
        paused = false;
        event("CHECKPOINT_AVAILABILITY", { available: checkpointAvailable() });
    }

    function setVolume(value) {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
            throw new Error("TYRANOSCRIPT_VOLUME_INVALID");
        }
        if (global.Howler && typeof global.Howler.volume === "function") global.Howler.volume(value);
    }

    function screenshot() {
        const target = global.document && global.document.getElementById("tyrano_base");
        if (!target || typeof global.html2canvas !== "function") {
            return Promise.reject(new Error("TYRANOSCRIPT_SCREENSHOT_UNAVAILABLE"));
        }
        return global.html2canvas(target, { backgroundColor: "#000000", logging: false }).then((source) => {
            const widthScale = Math.min(1, 640 / Math.max(1, source.width));
            const heightScale = Math.min(1, 360 / Math.max(1, source.height));
            const scale = Math.min(widthScale, heightScale);
            const canvas = global.document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(source.width * scale));
            canvas.height = Math.max(1, Math.round(source.height * scale));
            const context = canvas.getContext("2d");
            if (!context) throw new Error("TYRANOSCRIPT_SCREENSHOT_UNAVAILABLE");
            context.drawImage(source, 0, 0, canvas.width, canvas.height);
            return new Promise((resolve, reject) => {
                canvas.toBlob((blob) => {
                    if (!blob || !blob.size || blob.size > MAX_SCREENSHOT_BYTES) {
                        reject(new Error("TYRANOSCRIPT_SCREENSHOT_UNAVAILABLE"));
                        return;
                    }
                    blob.arrayBuffer().then(resolve, reject);
                }, "image/jpeg", 0.75);
            });
        });
    }

    async function handleRequest(message) {
        const requestId = message.requestId;
        try {
            switch (message.type) {
                case "CHECKPOINT": {
                    const bytes = await checkpoint();
                    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
                    send(requestId, "CHECKPOINT_RESULT", { data, format: CHECKPOINT_FORMAT }, [data]);
                    break;
                }
                case "RESTORE":
                    if (!ownKeys(message.body, ["data"])) throw new Error("TYRANOSCRIPT_PROTOCOL_INVALID");
                    await restore(message.body.data);
                    send(requestId, "RESTORE_RESULT", {});
                    break;
                case "SCREENSHOT": {
                    const data = await screenshot();
                    send(requestId, "SCREENSHOT_RESULT", { data, mediaType: "image/jpeg" }, [data]);
                    break;
                }
                case "PAUSE":
                    pause();
                    send(requestId, "PAUSE_RESULT", {});
                    break;
                case "RESUME":
                    resume();
                    send(requestId, "RESUME_RESULT", {});
                    break;
                case "SET_VOLUME":
                    if (!ownKeys(message.body, ["value"])) throw new Error("TYRANOSCRIPT_PROTOCOL_INVALID");
                    setVolume(message.body.value);
                    send(requestId, "SET_VOLUME_RESULT", {});
                    break;
                case "PROBE":
                    send(requestId, "PROBE_RESULT", { checkpointAvailable: checkpointAvailable(), continuousFrames: frameCount });
                    break;
                case "CLEANUP":
                    exited = true;
                    if (animationFrameId) global.cancelAnimationFrame(animationFrameId);
                    global.close = nativeClose;
                    send(requestId, "CLEANUP_RESULT", {});
                    port.close();
                    port = null;
                    break;
                default:
                    throw new Error("TYRANOSCRIPT_PROTOCOL_INVALID");
            }
        } catch (error) {
            send(requestId, "ERROR", { code: stableCode(error, "TYRANOSCRIPT_RUNTIME_FAILED") });
        }
    }

    function readRequest(value) {
        if (!ownKeys(value, ["body", "nonce", "protocolVersion", "requestId", "sessionId", "type"]) ||
            value.protocolVersion !== PROTOCOL_VERSION || value.sessionId !== sessionId || value.nonce !== nonce ||
            !Number.isSafeInteger(value.requestId) || value.requestId < 1 || typeof value.type !== "string" ||
            !value.body || typeof value.body !== "object" || Array.isArray(value.body)) {
            return null;
        }
        return value;
    }

    function connect(event) {
        const value = event.data;
        if (port || event.source !== global.parent || !ownKeys(value, ["nonce", "parentOrigin", "protocolVersion", "sessionId", "type"]) ||
            value.type !== "GAME_RUNTIME_TYRANOSCRIPT_CONNECT" || value.protocolVersion !== PROTOCOL_VERSION ||
            typeof value.sessionId !== "string" || !value.sessionId || typeof value.nonce !== "string" || value.nonce.length < 16 ||
            value.parentOrigin !== event.origin || typeof value.parentOrigin !== "string" || event.ports.length !== 1) {
            return;
        }
        sessionId = value.sessionId;
        nonce = value.nonce;
        parentOrigin = value.parentOrigin;
        port = event.ports[0];
        port.onmessage = (portEvent) => {
            const request = readRequest(portEvent.data);
            if (request) void handleRequest(request);
        };
        port.start();
        global.removeEventListener("message", connect, true);
        animationFrameId = global.requestAnimationFrame(frameTick);
    }

    global.addEventListener("message", connect, true);
    if (global.parent && typeof global.parent.postMessage === "function") {
        global.parent.postMessage({ protocolVersion: PROTOCOL_VERSION, type: "GAME_RUNTIME_TYRANOSCRIPT_BRIDGE_READY" }, "*");
    }
})(window);
