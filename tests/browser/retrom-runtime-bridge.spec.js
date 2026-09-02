const { expect, test } = require("@playwright/test");
const { resolve } = require("node:path");

test("restores the upstream sample in a fresh engine state and keeps gamepad input active", async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript({ path: resolve(__dirname, "../../retrom-runtime/bridge.js") });
    await page.addInitScript(() => {
        window.__retromGamepads = [];
        Object.defineProperty(navigator, "getGamepads", {
            configurable: true,
            value: () => window.__retromGamepads,
        });
    });
    await page.goto("/index.html");
    await page.waitForFunction(() => {
        const kag = window.TYRANO && window.TYRANO.kag;
        return Boolean(kag && kag.menu && typeof kag.menu.snapSave === "function" &&
            typeof kag.menu.loadGameData === "function" && kag.stat && kag.stat.current_scenario);
    });

    await page.evaluate(() => {
        const channel = new MessageChannel();
        const pending = new Map();
        window.__retromReplies = [];
        window.__retromRequestId = 0;
        channel.port1.onmessage = (event) => {
            window.__retromReplies.push(event.data);
            const waiter = pending.get(event.data.requestId);
            if (waiter) {
                pending.delete(event.data.requestId);
                waiter(event.data);
            }
        };
        channel.port1.start();
        window.__retromRuntimeRequest = (type, body = {}) => new Promise((resolveRequest) => {
            const requestId = ++window.__retromRequestId;
            pending.set(requestId, resolveRequest);
            channel.port1.postMessage({
                body,
                nonce: "browser-test-nonce",
                protocolVersion: 1,
                requestId,
                sessionId: "browser-test-session",
                type,
            });
        });
        window.postMessage({
            nonce: "browser-test-nonce",
            parentOrigin: location.origin,
            protocolVersion: 1,
            sessionId: "browser-test-session",
            type: "GAME_RUNTIME_TYRANOSCRIPT_CONNECT",
        }, location.origin, [channel.port2]);
    });
    await page.waitForFunction(() => window.__retromReplies.some((reply) => reply.type === "READY"));
    await expect.poll(() => page.evaluate(async () => {
        const probe = await window.__retromRuntimeRequest("PROBE");
        return probe.body.checkpointAvailable;
    })).toBe(true);

    const result = await page.evaluate(async () => {
        const paused = await window.__retromRuntimeRequest("PAUSE");
        window.TYRANO.kag.stat.f.__retrom_checkpoint_marker = "B";
        const checkpoint = await window.__retromRuntimeRequest("CHECKPOINT");
        if (checkpoint.type !== "CHECKPOINT_RESULT") return { checkpointType: checkpoint.type };
        const decodedCheckpoint = JSON.parse(new TextDecoder().decode(new Uint8Array(checkpoint.body.data)));
        const resumed = await window.__retromRuntimeRequest("RESUME");
        window.TYRANO.kag.stat.f.__retrom_checkpoint_marker = "C";
        const restored = await window.__retromRuntimeRequest("RESTORE", { data: checkpoint.body.data });
        return {
            checkpointBytes: checkpoint.body.data.byteLength,
            checkpointFormat: checkpoint.body.format,
            checkpointType: checkpoint.type,
            marker: window.TYRANO.kag.stat.f.__retrom_checkpoint_marker,
            pauseType: paused.type,
            resumeType: resumed.type,
            restoreCode: restored.body.code || null,
            restoreType: restored.type,
            savedScenario: decodedCheckpoint.snapshot.stat.current_scenario,
        };
    });
    expect(result).toEqual({
        checkpointBytes: expect.any(Number),
        checkpointFormat: "tyranoscript-snapshot-v1",
        checkpointType: "CHECKPOINT_RESULT",
        marker: "B",
        pauseType: "PAUSE_RESULT",
        resumeType: "RESUME_RESULT",
        restoreCode: null,
        restoreType: "RESTORE_RESULT",
        savedScenario: expect.any(String),
    });
    expect(result.checkpointBytes).toBeGreaterThan(100);

    await page.evaluate(() => {
        window.__retromGamepadButton = null;
        window.TYRANO.kag.once("gamepad-pressdown.retrom-runtime-test", (event) => {
            window.__retromGamepadButton = event.detail.button_name;
        });
        const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
        buttons[1] = { pressed: true, touched: true, value: 1 };
        window.__retromGamepads = [{
            axes: [0, 0, 0, 0],
            buttons,
            connected: true,
            id: "Retrom Browser Test Gamepad",
            index: 0,
            mapping: "standard",
            timestamp: performance.now(),
        }];
        window.dispatchEvent(new Event("gamepadconnected"));
    });
    await expect.poll(() => page.evaluate(() => window.__retromGamepadButton)).toBe("B");

    const screenshot = await page.evaluate(async () => {
        window.__retromHtml2CanvasCalled = false;
        window.html2canvas = () => {
            window.__retromHtml2CanvasCalled = true;
            throw new Error("bundled html2canvas must not be used by the bridge");
        };
        document.getElementById("tyrano_base").querySelectorAll = () => {
            throw new Error("screenshot traversal must be incrementally bounded");
        };
        document.createTreeWalker = () => {
            throw new Error("screenshot traversal must not enter unbounded descendant trees");
        };
        const target = document.getElementById("tyrano_base");
        target.replaceChildren();
        const gameRoot = document.createElement("div");
        gameRoot.id = "root_layer_game";
        const base = document.createElement("div");
        base.className = "base_fore";
        base.style.cssText = "position:absolute;inset:0;background-image:url(data/bgimage/title.jpg)";
        gameRoot.append(base);
        const foreground = document.createElement("div");
        foreground.style.cssText = "position:absolute;inset:0;background:rgb(255,0,255)";
        target.append(gameRoot, foreground);
        const reply = await window.__retromRuntimeRequest("SCREENSHOT");
        const bitmap = await createImageBitmap(new Blob([reply.body.data], { type: reply.body.mediaType }));
        const sample = document.createElement("canvas");
        sample.width = bitmap.width;
        sample.height = bitmap.height;
        const context = sample.getContext("2d");
        context.drawImage(bitmap, 0, 0);
        const center = Array.from(context.getImageData(
            Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2), 1, 1,
        ).data);
        bitmap.close();
        return {
            bytes: reply.body.data.byteLength,
            center,
            html2canvasCalled: window.__retromHtml2CanvasCalled,
            mediaType: reply.body.mediaType,
            type: reply.type,
        };
    });
    expect(screenshot.type).toBe("SCREENSHOT_RESULT");
    expect(screenshot.html2canvasCalled).toBe(false);
    expect(screenshot.mediaType).toBe("image/jpeg");
    expect(screenshot.bytes).toBeGreaterThan(100);
    expect(screenshot.bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(screenshot.center[0]).toBeGreaterThan(200);
    expect(screenshot.center[1]).toBeLessThan(80);
    expect(screenshot.center[2]).toBeGreaterThan(200);

    const domScreenshot = await page.evaluate(async () => {
        document.querySelectorAll("#root_layer_game > .base_fore, #root_layer_game > .base_back").forEach((layer) => {
            layer.style.backgroundImage = "none";
        });
        const target = document.getElementById("tyrano_base");
        const panel = document.createElement("div");
        panel.style.cssText = "position:absolute;left:100px;top:100px;width:420px;height:180px;" +
            "background:#18233a;color:#fff;font:24px sans-serif;text-align:center;padding:20px";
        panel.textContent = "Language Settings";
        target.append(panel);
        const reply = await window.__retromRuntimeRequest("SCREENSHOT");
        panel.remove();
        return {
            bytes: reply.body.data.byteLength,
            html2canvasCalled: window.__retromHtml2CanvasCalled,
            mediaType: reply.body.mediaType,
            type: reply.type,
        };
    });
    expect(domScreenshot.type).toBe("SCREENSHOT_RESULT");
    expect(domScreenshot.html2canvasCalled).toBe(false);
    expect(domScreenshot.mediaType).toBe("image/jpeg");
    expect(domScreenshot.bytes).toBeGreaterThan(100);
    expect(domScreenshot.bytes).toBeLessThanOrEqual(2 * 1024 * 1024);

    await page.evaluate(() => {
        const video = document.createElement("video");
        video.id = "retrom-blocked-autoplay-fixture";
        video.autoplay = true;
        video.src = "/partially-buffered-mov-06.webm";
        const source = document.createElement("source");
        source.src = "/partially-buffered-mov-06-fallback.webm";
        video.append(source);
        video.pause = () => { window.__retromRemovedVideoPauses = (window.__retromRemovedVideoPauses || 0) + 1; };
        video.load = () => { window.__retromRemovedVideoLoads = (window.__retromRemovedVideoLoads || 0) + 1; };
        video.play = () => {
            window.__retromAutoplayAttempts = (window.__retromAutoplayAttempts || 0) + 1;
            if (!video.muted) {
                return Promise.reject(new DOMException("autoplay blocked", "NotAllowedError"));
            }
            window.__retromAutoplayStarted = true;
            return Promise.resolve();
        };
        window.__retromAutoplayVideo = video;
        document.body.append(video);
    });
    await expect.poll(() => page.evaluate(() => ({
        attempts: window.__retromAutoplayAttempts || 0,
        muted: document.getElementById("retrom-blocked-autoplay-fixture").muted,
        started: Boolean(window.__retromAutoplayStarted),
    }))).toEqual({ attempts: 2, muted: true, started: true });
    await page.keyboard.press("Space");
    await expect.poll(() => page.evaluate(() =>
        document.getElementById("retrom-blocked-autoplay-fixture").muted)).toBe(false);
    await page.evaluate(() => document.getElementById("retrom-blocked-autoplay-fixture").remove());
    await expect.poll(() => page.evaluate(() => ({
        connected: window.__retromAutoplayVideo.isConnected,
        loads: window.__retromRemovedVideoLoads || 0,
        pauses: window.__retromRemovedVideoPauses || 0,
        source: window.__retromAutoplayVideo.querySelector("source").getAttribute("src"),
        src: window.__retromAutoplayVideo.getAttribute("src"),
    }))).toEqual({ connected: false, loads: 1, pauses: 1, source: null, src: null });
});
