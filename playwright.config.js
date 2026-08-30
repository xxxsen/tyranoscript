const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
    testDir: "./tests/browser",
    timeout: 60_000,
    expect: { timeout: 15_000 },
    use: {
        baseURL: "http://127.0.0.1:4173",
        headless: true,
        launchOptions: process.env.RETROM_CHROME_EXECUTABLE
            ? { executablePath: process.env.RETROM_CHROME_EXECUTABLE }
            : {},
    },
    webServer: {
        command: "python3 -m http.server 4173 --bind 127.0.0.1",
        port: 4173,
        reuseExistingServer: false,
        timeout: 30_000,
    },
});
