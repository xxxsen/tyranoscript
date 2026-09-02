(function installTyranoScriptRuntimeBridge(global) {
    "use strict";

    const PROTOCOL_VERSION = 1;
    const CHECKPOINT_FORMAT = "tyranoscript-snapshot-v1";
    const MAX_CHECKPOINT_BYTES = 32 * 1024 * 1024;
    const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
    const MAX_DOM_SCREENSHOT_DIMENSION = 2048;
    const MAX_DOM_SCREENSHOT_ELEMENTS = 512;
    const MAX_DOM_SCREENSHOT_PIXELS = 4 * 1024 * 1024;
    const MAX_DOM_SCREENSHOT_TEXT = 512;
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
    let bridgePollIntervalId = 0;
    let pausedHowls = [];
    let pausedMedia = [];
    let legacyKag = null;
    let legacyListeners = [];
    let legacyButtons = [];
    let legacyInputArmed = false;
    let legacyMediaPrototype = null;
    let nativeLegacyMediaPlay = null;
    let legacyMediaPlay = null;
    let nativeLegacyAudioConstructor = null;
    let legacyAudioConstructor = null;
    let legacyPlayBgmTag = null;
    let nativeLegacyPlayBgmStart = null;
    let legacyPlayBgmStart = null;
    let autoplayUnmuteInstalled = false;
    const autoplayAttempts = new WeakSet();
    const autoplayMedia = new Set();
    const detachedAutoplayMedia = new WeakSet();
    const mutedAutoplayMedia = new Set();
    const pendingAnimations = new WeakMap();

    const legacyButtonNames = [
        "A", "B", "X", "Y", "L1", "R1", "L2", "R2", "SELECT", "START", "L3", "R3",
        "UP", "DOWN", "LEFT", "RIGHT", "HOME",
    ];
    const legacyButtonKeys = new Map([
        [0, ["Enter", 13]], [1, ["Escape", 27]], [2, [" ", 32]], [3, ["y", 89]],
        [8, ["Backspace", 8]], [9, ["Enter", 13]], [12, ["ArrowUp", 38]],
        [13, ["ArrowDown", 40]], [14, ["ArrowLeft", 37]], [15, ["ArrowRight", 39]],
    ]);

    function ownKeys(value, expected) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const actual = Object.keys(value).sort();
        const sortedExpected = expected.slice().sort();
        return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
    }

    function engine() {
        const kag = global.TYRANO && global.TYRANO.kag;
        if (!kag || !kag.menu || typeof kag.menu.snapSave !== "function" ||
            typeof kag.menu.loadGameData !== "function") return null;
        installLegacyEventAPI(kag);
        installLegacyMediaFallback(kag);
        return kag;
    }

    function eventIdentity(value) {
        const separator = value.indexOf(".");
        return {
            event: separator < 0 ? value : value.slice(0, separator),
            namespace: separator < 0 ? "" : value.slice(separator + 1),
        };
    }

    function installLegacyEventAPI(kag) {
        if (legacyKag === kag || typeof kag.on === "function" && typeof kag.once === "function" &&
            typeof kag.off === "function" && typeof kag.trigger === "function") return;
        if (typeof kag.on === "function" || typeof kag.once === "function" ||
            typeof kag.off === "function" || typeof kag.trigger === "function") return;
        legacyKag = kag;
        kag.on = (name, callback) => addLegacyListener(name, callback, false);
        kag.once = (name, callback) => addLegacyListener(name, callback, true);
        kag.off = removeLegacyListeners;
        kag.trigger = triggerLegacyListeners;
    }

    function installLegacyMediaFallback(kag) {
        if (legacyKag !== kag || !kag.tmp || typeof kag.tmp !== "object") return;
        kag.tmp.ready_audio = true;
        installLegacyAudioTagFallback(kag);
        installLegacyAudioConstructorFallback();
        if (legacyMediaPlay || typeof global.HTMLMediaElement !== "function") return;
        const prototype = global.HTMLMediaElement.prototype;
        if (!prototype || typeof prototype.play !== "function") return;
        legacyMediaPrototype = prototype;
        nativeLegacyMediaPlay = prototype.play;
        legacyMediaPlay = function playWithLegacyAutoplayFallback() {
            const media = this;
            if (legacyAutoplayBlocked() && !isVideo(media)) {
                return Promise.resolve().then(() => {
                    if (typeof media.dispatchEvent === "function") {
                        media.dispatchEvent(new global.Event("play"));
                    }
                });
            }
            const result = nativeLegacyMediaPlay.apply(media, arguments);
            if (!result || typeof result.catch !== "function") return result;
            return result.catch((error) => {
                if (!error || error.name !== "NotAllowedError" || typeof media.dispatchEvent !== "function") {
                    throw error;
                }
                if (isVideo(media) && !media.muted) {
                    media.muted = true;
                    mutedAutoplayMedia.add(media);
                    const retry = nativeLegacyMediaPlay.apply(media, arguments);
                    if (!retry || typeof retry.catch !== "function") return retry;
                    return retry.catch((retryError) => {
                        mutedAutoplayMedia.delete(media);
                        media.muted = false;
                        throw retryError;
                    });
                }
                media.dispatchEvent(new global.Event("play"));
            });
        };
        prototype.play = legacyMediaPlay;
        installAutoplayUnmute();
    }

    function legacyAutoplayBlocked() {
        const activation = global.navigator && global.navigator.userActivation;
        return Boolean(activation && !activation.isActive && !activation.hasBeenActive);
    }

    function isVideo(media) {
        return Boolean(media && media.tagName === "VIDEO");
    }

    function installAutoplayUnmute() {
        if (autoplayUnmuteInstalled || !global.document ||
            typeof global.document.addEventListener !== "function") return;
        ["pointerdown", "touchstart", "keydown"].forEach((name) => {
            global.document.addEventListener(name, unmuteAutoplayMedia, true);
        });
        autoplayUnmuteInstalled = true;
    }

    function unmuteAutoplayMedia() {
        mutedAutoplayMedia.forEach((media) => {
            if (media && !media.ended) media.muted = false;
        });
        mutedAutoplayMedia.clear();
    }

    function startAutoplayVideos() {
        if (!global.document || typeof global.document.querySelectorAll !== "function") return;
        const connected = Array.from(global.document.querySelectorAll("video[autoplay]"));
        connected.forEach((media) => {
            autoplayMedia.add(media);
            detachedAutoplayMedia.delete(media);
            if (!media || !media.paused || media.ended || autoplayAttempts.has(media)) return;
            autoplayAttempts.add(media);
            let playing;
            try {
                playing = media.play();
            } catch {
                return;
            }
            if (!playing || typeof playing.catch !== "function") return;
            playing.catch((error) => {
                if (!error || error.name !== "NotAllowedError" || media.muted) throw error;
                media.muted = true;
                mutedAutoplayMedia.add(media);
                installAutoplayUnmute();
                return media.play();
            }).catch(() => {
                mutedAutoplayMedia.delete(media);
                media.muted = false;
            });
        });
        autoplayMedia.forEach((media) => {
            if (!media || media.isConnected !== false) return;
            if (!detachedAutoplayMedia.has(media)) {
                detachedAutoplayMedia.add(media);
                return;
            }
            releaseAutoplayMedia(media);
            autoplayMedia.delete(media);
        });
    }

    function releaseAutoplayMedia(media) {
        mutedAutoplayMedia.delete(media);
        try {
            if (typeof media.pause === "function") media.pause();
        } catch {}
        try {
            if (typeof media.removeAttribute === "function") media.removeAttribute("src");
            if (typeof media.querySelectorAll === "function") {
                Array.from(media.querySelectorAll("source")).forEach((source) => {
                    if (source && typeof source.removeAttribute === "function") source.removeAttribute("src");
                });
            }
            if (typeof media.load === "function") media.load();
        } catch {}
    }

    function releaseAutoplayMediaAll() {
        autoplayMedia.forEach(releaseAutoplayMedia);
        autoplayMedia.clear();
    }

    function installLegacyAudioConstructorFallback() {
        if (legacyAudioConstructor || typeof global.Audio !== "function") return;
        nativeLegacyAudioConstructor = global.Audio;
        legacyAudioConstructor = function Audio() {
            if (legacyAutoplayBlocked() && arguments.length > 0 && global.document &&
                typeof global.document.createElement === "function") {
                return global.document.createElement("audio");
            }
            const args = Array.from(arguments);
            return Reflect.construct(nativeLegacyAudioConstructor, args);
        };
        legacyAudioConstructor.prototype = nativeLegacyAudioConstructor.prototype;
        Object.setPrototypeOf(legacyAudioConstructor, nativeLegacyAudioConstructor);
        global.Audio = legacyAudioConstructor;
    }

    function installLegacyAudioTagFallback(kag) {
        const tag = kag.ftag && kag.ftag.master_tag && kag.ftag.master_tag.playbgm;
        if (legacyPlayBgmTag || !tag || typeof tag.start !== "function") return;
        legacyPlayBgmTag = tag;
        nativeLegacyPlayBgmStart = tag.start;
        legacyPlayBgmStart = function startWithLegacyAutoplayFallback() {
            if (!legacyAutoplayBlocked()) return nativeLegacyPlayBgmStart.apply(this, arguments);
            if (kag.layer && typeof kag.layer.showEventLayer === "function") kag.layer.showEventLayer();
            kag.ftag.nextOrder();
        };
        tag.start = legacyPlayBgmStart;
    }

    function restoreLegacyMediaFallback() {
        if (global.document && typeof global.document.removeEventListener === "function") {
            ["pointerdown", "touchstart", "keydown"].forEach((name) => {
                global.document.removeEventListener(name, unmuteAutoplayMedia, true);
            });
        }
        autoplayUnmuteInstalled = false;
        unmuteAutoplayMedia();
        if (legacyPlayBgmTag && legacyPlayBgmTag.start === legacyPlayBgmStart && nativeLegacyPlayBgmStart) {
            legacyPlayBgmTag.start = nativeLegacyPlayBgmStart;
        }
        if (legacyAudioConstructor && global.Audio === legacyAudioConstructor && nativeLegacyAudioConstructor) {
            global.Audio = nativeLegacyAudioConstructor;
        }
        if (legacyMediaPrototype && legacyMediaPrototype.play === legacyMediaPlay && nativeLegacyMediaPlay) {
            legacyMediaPrototype.play = nativeLegacyMediaPlay;
        }
        nativeLegacyAudioConstructor = null;
        legacyAudioConstructor = null;
        legacyPlayBgmTag = null;
        nativeLegacyPlayBgmStart = null;
        legacyPlayBgmStart = null;
        legacyMediaPrototype = null;
        nativeLegacyMediaPlay = null;
        legacyMediaPlay = null;
    }

    function addLegacyListener(name, callback, once) {
        if (typeof name !== "string" || !name || typeof callback !== "function") return;
        name.split(/\s+/).filter(Boolean).forEach((value) => {
            const identity = eventIdentity(value);
            legacyListeners.push({ ...identity, callback, once });
        });
    }

    function removeLegacyListeners(name) {
        if (typeof name !== "string" || !name) {
            legacyListeners = [];
            return;
        }
        const identity = eventIdentity(name);
        legacyListeners = legacyListeners.filter((listener) => {
            if (!identity.event && identity.namespace) return listener.namespace !== identity.namespace;
            return listener.event !== identity.event ||
                Boolean(identity.namespace) && listener.namespace !== identity.namespace;
        });
    }

    function triggerLegacyListeners(name, eventObject) {
        const eventName = eventIdentity(name).event;
        const matching = legacyListeners.filter((listener) => listener.event === eventName);
        legacyListeners = legacyListeners.filter((listener) => listener.event !== eventName || !listener.once);
        matching.forEach((listener) => listener.callback(eventObject));
    }

    function checkpointAvailable() {
        const kag = engine();
        if (exited || !kag || !kag.stat || typeof kag.stat.current_scenario !== "string" ||
            !kag.stat.current_scenario || kag.stat.is_wait || kag.stat.is_adding_text ||
            !stableCheckpointTag(kag)) return false;
        const canShowMenu = kag.key_mouse && kag.key_mouse.util && kag.key_mouse.util.canShowMenu;
        if (typeof canShowMenu !== "function") return true;
        try {
            return Boolean(canShowMenu.call(kag.key_mouse.util));
        } catch {
            return false;
        }
    }

    function stableCheckpointTag(kag) {
        const ftag = kag.ftag;
        if (!ftag || !Number.isSafeInteger(ftag.current_order_index) || !Array.isArray(ftag.array_tag)) return false;
        const current = ftag.array_tag[ftag.current_order_index];
        return Boolean(current && ["text", "l", "p", "s"].includes(current.name));
    }

    function standardGamepad() {
        if (!global.navigator || typeof global.navigator.getGamepads !== "function") return null;
        try {
            return Array.from(global.navigator.getGamepads() || []).find((gamepad) =>
                gamepad && gamepad.connected !== false && gamepad.mapping === "standard") || null;
        } catch {
            return null;
        }
    }

    function pollLegacyGamepad(kag) {
        if (kag !== legacyKag || exited || paused) return;
        const gamepad = standardGamepad();
        const pressed = legacyButtonNames.map((_, index) => Boolean(
            gamepad && gamepad.buttons && gamepad.buttons[index] && gamepad.buttons[index].pressed,
        ));
        if (!legacyInputArmed) {
            legacyButtons = pressed;
            legacyInputArmed = !pressed.some(Boolean);
            return;
        }
        pressed.forEach((active, index) => {
            if (active === Boolean(legacyButtons[index])) return;
            emitLegacyGamepad(kag, gamepad, index, active);
        });
        legacyButtons = pressed;
    }

    function emitLegacyGamepad(kag, gamepad, index, pressed) {
        const detail = {
            button_index: index,
            button_name: legacyButtonNames[index],
            gamepad,
            gamepad_index: gamepad ? gamepad.index : 0,
        };
        const type = pressed ? "gamepad-pressdown" : "gamepad-pressup";
        kag.trigger(type, { detail, type });
        if (global.document && typeof global.CustomEvent === "function") {
            global.document.dispatchEvent(new global.CustomEvent(
                pressed ? "gamepadpressdown" : "gamepadpressup", { detail },
            ));
        }
        const key = legacyButtonKeys.get(index);
        if (key) dispatchLegacyKey(pressed ? "keydown" : "keyup", key[0], key[1]);
    }

    function dispatchLegacyKey(type, key, keyCode) {
        if (!global.document || typeof global.document.dispatchEvent !== "function" ||
            typeof global.KeyboardEvent !== "function") return;
        const keyboardEvent = new global.KeyboardEvent(type, { bubbles: true, cancelable: true, key });
        try {
            Object.defineProperty(keyboardEvent, "keyCode", { configurable: true, get: () => keyCode });
            Object.defineProperty(keyboardEvent, "which", { configurable: true, get: () => keyCode });
        } catch {
            return;
        }
        global.document.dispatchEvent(keyboardEvent);
    }

    function releaseLegacyInput() {
        if (legacyKag) {
            legacyButtons.forEach((pressed, index) => {
                if (pressed) emitLegacyGamepad(legacyKag, null, index, false);
            });
        }
        legacyButtons = [];
        legacyInputArmed = false;
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
        stopBridgePoll();
        pausedHowls = [];
        pausedMedia = [];
        releaseLegacyInput();
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
        pollBridge();
        animationFrameId = global.requestAnimationFrame(frameTick);
    }

    function pollBridge() {
        if (exited) return;
        finishStalledAnimations();
        const kag = engine();
        if (kag) {
            pollLegacyGamepad(kag);
            startAutoplayVideos();
        }
        if (!readySent && kag) {
            readySent = true;
            event("READY", { checkpointAvailable: checkpointAvailable(), engine: "TYRANOSCRIPT" });
        }
    }

    function finishStalledAnimations() {
        if (!global.document || typeof global.document.querySelectorAll !== "function" ||
            typeof global.Event !== "function") return;
        const now = global.performance && typeof global.performance.now === "function" ?
            global.performance.now() : Date.now();
        Array.from(global.document.querySelectorAll(".animated")).forEach((element) => {
            if (!element || typeof element.getAnimations !== "function" ||
                typeof element.dispatchEvent !== "function") return;
            const animations = element.getAnimations();
            const stalled = animations.find((animation) => animation && animation.playState === "running" &&
                animation.startTime === null && animation.currentTime === 0);
            if (!stalled) {
                pendingAnimations.delete(element);
                return;
            }
            const firstObserved = pendingAnimations.get(element);
            if (firstObserved === undefined) {
                pendingAnimations.set(element, now);
                return;
            }
            const timing = stalled.effect && typeof stalled.effect.getComputedTiming === "function" ?
                stalled.effect.getComputedTiming() : null;
            const duration = timing && typeof timing.duration === "number" && Number.isFinite(timing.duration) ?
                Math.max(0, timing.duration) : 0;
            if (now - firstObserved < Math.max(250, duration + 250)) return;
            pendingAnimations.delete(element);
            element.dispatchEvent(new global.Event("animationend", { bubbles: true }));
        });
    }

    function stopBridgePoll() {
        if (!bridgePollIntervalId) return;
        global.clearInterval(bridgePollIntervalId);
        bridgePollIntervalId = 0;
    }

    function cloneJSON(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function validateSnapshot(snapshot) {
        const objectShape = Boolean(snapshot && typeof snapshot === "object" && !Array.isArray(snapshot));
        const modernShape = objectShape && snapshot.three && typeof snapshot.three === "object" &&
            !Array.isArray(snapshot.three);
        const legacyShape = objectShape && !("three" in snapshot) && typeof snapshot.title === "string" &&
            typeof snapshot.save_date === "string" && typeof snapshot.img_data === "string";
        if (!objectShape ||
            !snapshot.stat || typeof snapshot.stat !== "object" || Array.isArray(snapshot.stat) ||
            typeof snapshot.stat.current_scenario !== "string" || !snapshot.stat.current_scenario ||
            !Number.isSafeInteger(snapshot.current_order_index) || snapshot.current_order_index < -1 ||
            !("layer" in snapshot) || !snapshot.stat.f || typeof snapshot.stat.f !== "object" ||
            Array.isArray(snapshot.stat.f) || !modernShape && !legacyShape) {
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
                runtimeDebug("checkpoint", "finish");
                if (restoreWeakStop) {
                    if (typeof kag.weaklyStop === "function") kag.weaklyStop();
                    paused = true;
                }
                runtimeDebug("checkpoint", "paused");
                if (error) reject(error);
                else {
                    try {
                        const snapshot = cloneJSON(kag.menu.snap);
                        runtimeDebug("checkpoint", "cloned");
                        const encoded = encodeCheckpoint(snapshot);
                        runtimeDebug("checkpoint", `encoded:${encoded.byteLength}`);
                        resolve(encoded);
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
            const legacyRestore = kag === legacyKag || typeof kag.once !== "function" || typeof kag.on !== "function";
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
                if ((legacyRestore || makeStarted) && kag.stat.current_scenario === snapshot.stat.current_scenario &&
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
                if (!legacyRestore) {
                    kag.once("load-complete.retrom-runtime-restore", () => finish());
                    kag.on("nextorder.retrom-runtime-restore", observeRestoreOrder);
                }
                kag.menu.loadGameData(snapshot, { auto_next: "no", bgm_over: "false" });
                pollTarget();
            } catch {
                finish(new Error("TYRANOSCRIPT_CHECKPOINT_RESTORE_FAILED"));
            }
        });
    }

    function pauseAudio() {
        const howler = global.Howler;
        pausedHowls = [];
        if (howler && Array.isArray(howler._howls)) {
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
        pausedMedia = mediaElements().filter((media) => !media.paused && !media.ended);
        pausedMedia.forEach((media) => media.pause());
    }

    function resumeAudio() {
        const pending = pausedHowls;
        pausedHowls = [];
        pending.forEach(({ howl, id }) => {
            if (howl && typeof howl.play === "function") howl.play(id);
        });
        const media = pausedMedia;
        pausedMedia = [];
        media.forEach((element) => {
            const playing = element.play();
            if (playing && typeof playing.catch === "function") playing.catch(() => {});
        });
    }

    function mediaElements() {
        if (!global.document || typeof global.document.querySelectorAll !== "function") return [];
        return Array.from(global.document.querySelectorAll("audio,video")).filter((element) =>
            element && typeof element.pause === "function" && typeof element.play === "function",
        );
    }

    function pause() {
        if (exited || paused) return;
        const kag = engine();
        if (kag && typeof kag.weaklyStop === "function") kag.weaklyStop();
        releaseLegacyInput();
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
        mediaElements().forEach((element) => { element.volume = value; });
    }

    async function screenshot() {
        screenshotDebug("start");
        const target = global.document && global.document.getElementById("tyrano_base");
        if (!target) throw new Error("TYRANOSCRIPT_SCREENSHOT_UNAVAILABLE");
        const baseLayer = global.document.querySelector(
            '#root_layer_game > .base_fore[style*="background-image"], ' +
            '#root_layer_game > .base_back[style*="background-image"]',
        );
        const backgroundURL = baseLayer && cssBackgroundURL(baseLayer.style.backgroundImage);
        let backgroundSurface = null;
        if (backgroundURL && typeof global.fetch === "function") {
            try {
                const background = await screenshotBackground(backgroundURL);
                backgroundSurface = await decodeScreenshotSurface(background);
                screenshotDebug("loaded", `${background.mediaType}:${background.data.byteLength}`);
            } catch {
                screenshotDebug("background-fallback");
            }
        }
        try {
            const result = await screenshotBoundedDOM(target, backgroundSurface);
            screenshotDebug("dom", `${result.mediaType}:${result.data.byteLength}`);
            return result;
        } finally {
            if (backgroundSurface && typeof backgroundSurface.close === "function") backgroundSurface.close();
        }
    }

    async function screenshotBackground(backgroundURL) {
        const resourceURL = new global.URL(backgroundURL, global.location.href);
        if (resourceURL.origin !== global.location.origin) throw new Error("TYRANOSCRIPT_SCREENSHOT_UNAVAILABLE");
        screenshotDebug("resource", resourceURL.pathname);
        const response = await global.fetch(resourceURL.href, { cache: "no-store", credentials: "same-origin" });
        if (!response.ok) throw new Error("TYRANOSCRIPT_SCREENSHOT_UNAVAILABLE");
        const headerMediaType = (response.headers.get("Content-Type") || "").split(";", 1)[0].toLowerCase();
        const inferredMediaType = /\.png$/i.test(resourceURL.pathname) ? "image/png" :
            /\.jpe?g$/i.test(resourceURL.pathname) ? "image/jpeg" : "";
        const mediaType = ["image/jpeg", "image/png"].includes(headerMediaType) ? headerMediaType : inferredMediaType;
        const data = await response.arrayBuffer();
        if (!mediaType || !data.byteLength || data.byteLength > MAX_SCREENSHOT_BYTES) {
            throw new Error("TYRANOSCRIPT_SCREENSHOT_UNAVAILABLE");
        }
        return { data, mediaType };
    }

    async function decodeScreenshotSurface(result) {
        if (typeof global.Blob !== "function" || typeof global.createImageBitmap !== "function") return null;
        return global.createImageBitmap(new global.Blob([result.data], { type: result.mediaType }));
    }

    async function screenshotBoundedDOM(target, backgroundSurface = null) {
        if (!global.document || typeof global.document.createElement !== "function" ||
            typeof global.getComputedStyle !== "function" || typeof target.getBoundingClientRect !== "function") {
            throw new Error("TYRANOSCRIPT_SCREENSHOT_UNAVAILABLE");
        }
        const targetRect = target.getBoundingClientRect();
        const width = Math.round(targetRect.width);
        const height = Math.round(targetRect.height);
        if (width < 1 || height < 1) throw new Error("TYRANOSCRIPT_SCREENSHOT_UNAVAILABLE");
        const scale = Math.min(
            1,
            MAX_DOM_SCREENSHOT_DIMENSION / width,
            MAX_DOM_SCREENSHOT_DIMENSION / height,
            Math.sqrt(MAX_DOM_SCREENSHOT_PIXELS / (width * height)),
        );
        const canvasWidth = Math.max(1, Math.round(width * scale));
        const canvasHeight = Math.max(1, Math.round(height * scale));
        const offscreen = typeof global.OffscreenCanvas === "function";
        const canvas = offscreen ? new global.OffscreenCanvas(canvasWidth, canvasHeight) :
            global.document.createElement("canvas");
        if (!offscreen) {
            canvas.width = canvasWidth;
            canvas.height = canvasHeight;
        }
        const context = typeof canvas.getContext === "function" && canvas.getContext("2d");
        if (!context || typeof canvas.convertToBlob !== "function" && typeof canvas.toBlob !== "function") {
            throw new Error("TYRANOSCRIPT_SCREENSHOT_UNAVAILABLE");
        }
        const targetStyle = global.getComputedStyle(target);
        context.fillStyle = visibleColor(targetStyle.backgroundColor) || "#05060a";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.save();
        context.scale(scale, scale);
        if (backgroundSurface) {
            context.drawImage(backgroundSurface, 0, 0, width, height);
        }
        renderBoundedDOM(context, target, targetRect);
        context.restore();
        const blob = await encodeScreenshotCanvas(canvas, 0.76);
        if (!blob || !blob.size || blob.size > MAX_SCREENSHOT_BYTES) {
            throw new Error("TYRANOSCRIPT_SCREENSHOT_UNAVAILABLE");
        }
        return { data: await blob.arrayBuffer(), mediaType: "image/jpeg" };
    }

    function renderBoundedDOM(context, target, targetRect) {
        const queue = [target];
        let visited = 0;
        while (queue.length && visited < MAX_DOM_SCREENSHOT_ELEMENTS) {
            const element = queue.shift();
            visited += 1;
            const children = element && element.children;
            for (let index = 0; children && index < children.length &&
                queue.length + visited < MAX_DOM_SCREENSHOT_ELEMENTS; index += 1) {
                queue.push(children[index]);
            }
            if (element === target || !element || typeof element.getBoundingClientRect !== "function") continue;
            const style = global.getComputedStyle(element);
            const opacity = Number.parseFloat(style.opacity || "1");
            if (style.display === "none" || style.visibility === "hidden" || opacity <= 0) continue;
            const rect = element.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0 || rect.right <= targetRect.left ||
                rect.bottom <= targetRect.top || rect.left >= targetRect.right || rect.top >= targetRect.bottom) continue;
            const x = rect.left - targetRect.left;
            const y = rect.top - targetRect.top;
            const background = visibleColor(style.backgroundColor);
            if (background) {
                context.globalAlpha = Math.min(1, opacity);
                context.fillStyle = background;
                context.fillRect(x, y, rect.width, rect.height);
                context.globalAlpha = 1;
            }
            renderDOMSurface(context, element, rect, targetRect);
            renderDOMText(context, element, style, rect, targetRect);
        }
    }

    function renderDOMSurface(context, element, rect, targetRect) {
        const tagName = element.tagName;
        if (!["CANVAS", "IMG", "VIDEO"].includes(tagName)) return;
        if (tagName === "IMG") {
            const source = element.currentSrc || element.src;
            try {
                if (!source || new global.URL(source, global.location.href).origin !== global.location.origin) return;
            } catch {
                return;
            }
        }
        try {
            context.drawImage(element, rect.left - targetRect.left, rect.top - targetRect.top, rect.width, rect.height);
        } catch { /* A not-yet-decoded or tainted surface is omitted from the bounded fallback. */ }
    }

    function renderDOMText(context, element, style, rect, targetRect) {
        const children = element.children;
        for (let index = 0; children && index < children.length; index += 1) {
            if (children[index].tagName !== "BR") return;
        }
        const text = String(element.innerText || element.textContent || "").trim().slice(0, MAX_DOM_SCREENSHOT_TEXT);
        if (!text) return;
        const fontSize = Math.min(96, Math.max(8, Number.parseFloat(style.fontSize) || 16));
        const lineHeight = Math.min(128, Math.max(fontSize, Number.parseFloat(style.lineHeight) || fontSize * 1.2));
        const paddingLeft = Math.max(0, Number.parseFloat(style.paddingLeft) || 0);
        const color = visibleColor(style.color) || "#ffffff";
        const alignment = ["center", "right"].includes(style.textAlign) ? style.textAlign : "left";
        context.fillStyle = color;
        context.font = style.font || `${style.fontWeight || "400"} ${fontSize}px sans-serif`;
        context.textAlign = alignment;
        context.textBaseline = "top";
        const x = alignment === "center" ? rect.left - targetRect.left + rect.width / 2 :
            alignment === "right" ? rect.right - targetRect.left - paddingLeft : rect.left - targetRect.left + paddingLeft;
        String(text).split(/\r?\n/).slice(0, 16).forEach((line, index) => {
            context.fillText(line.slice(0, 256), x, rect.top - targetRect.top + index * lineHeight, rect.width);
        });
    }

    function encodeScreenshotCanvas(canvas, quality) {
        if (typeof canvas.convertToBlob === "function") {
            return canvas.convertToBlob({ type: "image/jpeg", quality });
        }
        return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    }

    function visibleColor(value) {
        if (typeof value !== "string" || !value || value === "transparent" ||
            /^rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/i.test(value)) return "";
        return value;
    }

    function screenshotDebug(stage, detail = "") {
        runtimeDebug("screenshot", stage, detail);
    }

    function runtimeDebug(area, stage, detail = "") {
        if (!global.__retromRuntimeDebug || !global.console || typeof global.console.debug !== "function") return;
        global.console.debug(`[retrom-tyranoscript-${area}] ${stage}${detail ? `:${detail}` : ""}`);
    }

    function cssBackgroundURL(value) {
        if (typeof value !== "string") return "";
        const match = /^url\(["']?(.*?)["']?\)$/.exec(value.trim());
        return match ? match[1] : "";
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
                    const result = await screenshot();
                    send(requestId, "SCREENSHOT_RESULT", result, [result.data]);
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
                    stopBridgePoll();
                    releaseLegacyInput();
                    legacyListeners = [];
                    pausedHowls = [];
                    pausedMedia = [];
                    releaseAutoplayMediaAll();
                    restoreLegacyMediaFallback();
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
        pollBridge();
        bridgePollIntervalId = global.setInterval(pollBridge, 100);
        animationFrameId = global.requestAnimationFrame(frameTick);
    }

    global.addEventListener("message", connect, true);
    if (global.parent && typeof global.parent.postMessage === "function") {
        global.parent.postMessage({ protocolVersion: PROTOCOL_VERSION, type: "GAME_RUNTIME_TYRANOSCRIPT_BRIDGE_READY" }, "*");
    }
})(window);
