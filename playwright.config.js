const { defineConfig } = require("@playwright/test");

const testPort = Number(process.env.RETROM_TEST_PORT || "4173");

module.exports = defineConfig({
    testDir: "./tests/browser",
    timeout: 60_000,
    expect: { timeout: 15_000 },
    use: {
        baseURL: `http://127.0.0.1:${testPort}`,
        headless: true,
        launchOptions: {
            args: ["--disable-gpu"],
            ...(process.env.RETROM_CHROME_EXECUTABLE
                ? { executablePath: process.env.RETROM_CHROME_EXECUTABLE }
                : {}),
        },
    },
    webServer: {
        command: `python3 -m http.server ${testPort} --bind 127.0.0.1`,
        port: testPort,
        reuseExistingServer: process.env.RETROM_REUSE_TEST_SERVER === "1",
        timeout: 30_000,
    },
});
