const { expect, test } = require("@playwright/test");
const { resolve } = require("node:path");

test("restores the upstream sample in a fresh engine state and keeps gamepad input active", async ({ page }) => {
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

    const result = await page.evaluate(async () => {
        window.TYRANO.kag.stat.f.__retrom_checkpoint_marker = "B";
        const checkpoint = await window.__retromRuntimeRequest("CHECKPOINT");
        if (checkpoint.type !== "CHECKPOINT_RESULT") return { checkpointType: checkpoint.type };
        window.TYRANO.kag.stat.f.__retrom_checkpoint_marker = "C";
        const restored = await window.__retromRuntimeRequest("RESTORE", { data: checkpoint.body.data });
        return {
            checkpointBytes: checkpoint.body.data.byteLength,
            checkpointFormat: checkpoint.body.format,
            checkpointType: checkpoint.type,
            marker: window.TYRANO.kag.stat.f.__retrom_checkpoint_marker,
            restoreType: restored.type,
        };
    });
    expect(result).toEqual({
        checkpointBytes: expect.any(Number),
        checkpointFormat: "tyranoscript-snapshot-v1",
        checkpointType: "CHECKPOINT_RESULT",
        marker: "B",
        restoreType: "RESTORE_RESULT",
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
        const reply = await window.__retromRuntimeRequest("SCREENSHOT");
        return { bytes: reply.body.data.byteLength, mediaType: reply.body.mediaType, type: reply.type };
    });
    expect(screenshot.type).toBe("SCREENSHOT_RESULT");
    expect(screenshot.mediaType).toBe("image/jpeg");
    expect(screenshot.bytes).toBeGreaterThan(100);
    expect(screenshot.bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
});
