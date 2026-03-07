const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

/**
 * Copy assets folder to dist/assets
 */
function copyAssets() {
	const srcDir = path.join(__dirname, "..", "webview-ui", "public", "assets");
	const dstDir = path.join(__dirname, "dist", "assets");

	if (fs.existsSync(srcDir)) {
		if (fs.existsSync(dstDir)) {
			fs.rmSync(dstDir, { recursive: true });
		}
		fs.cpSync(srcDir, dstDir, { recursive: true });
		console.log("Copied assets/ -> dist/assets/");
	}
}

/**
 * Copy webview build output to dist/webview/ for production packaging
 */
function copyWebview() {
	const srcDir = path.join(__dirname, "..", "dist", "webview");
	const dstDir = path.join(__dirname, "dist", "webview");

	if (fs.existsSync(srcDir)) {
		if (fs.existsSync(dstDir)) {
			fs.rmSync(dstDir, { recursive: true });
		}
		fs.cpSync(srcDir, dstDir, { recursive: true });
		console.log("Copied webview build -> dist/webview/");
	} else {
		console.warn("Warning: webview build not found at", srcDir);
		console.warn("Run 'cd ../webview-ui && npm run build' first");
	}
}

async function main() {
	/** @type {import('esbuild').BuildOptions} */
	const commonOptions = {
		bundle: true,
		format: "cjs",
		platform: "node",
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		external: ["electron"],
		logLevel: "info",
	};

	const mainCtx = await esbuild.context({
		...commonOptions,
		entryPoints: ["main/main.ts"],
		outfile: "dist/main.js",
	});

	const preloadCtx = await esbuild.context({
		...commonOptions,
		entryPoints: ["preload/preload.ts"],
		outfile: "dist/preload.js",
	});

	if (watch) {
		await Promise.all([mainCtx.watch(), preloadCtx.watch()]);
		console.log("Watching for changes...");
	} else {
		await Promise.all([mainCtx.rebuild(), preloadCtx.rebuild()]);
		await Promise.all([mainCtx.dispose(), preloadCtx.dispose()]);
		copyAssets();
		copyWebview();
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
