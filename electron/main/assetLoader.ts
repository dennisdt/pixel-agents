import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';
import type { MessageSender } from './types.js';
import {
	PNG_ALPHA_THRESHOLD,
	WALL_PIECE_WIDTH,
	WALL_PIECE_HEIGHT,
	WALL_GRID_COLS,
	WALL_BITMASK_COUNT,
	FLOOR_PATTERN_COUNT,
	FLOOR_TILE_SIZE,
	CHARACTER_DIRECTIONS,
	CHAR_FRAME_W,
	CHAR_FRAME_H,
	CHAR_FRAMES_PER_ROW,
	CHAR_COUNT,
} from './constants.js';

export interface FurnitureAsset {
	id: string;
	name: string;
	label: string;
	category: string;
	file: string;
	width: number;
	height: number;
	footprintW: number;
	footprintH: number;
	isDesk: boolean;
	canPlaceOnWalls: boolean;
	partOfGroup?: boolean;
	groupId?: string;
	canPlaceOnSurfaces?: boolean;
	backgroundTiles?: number;
	orientation?: string;
	state?: string;
}

export interface LoadedAssets {
	catalog: FurnitureAsset[];
	sprites: Map<string, string[][]>;
}

export interface LoadedWallTiles {
	sprites: string[][][];
}

export interface LoadedFloorTiles {
	sprites: string[][][];
}

export interface CharacterDirectionSprites {
	down: string[][][];
	up: string[][][];
	right: string[][][];
}

export interface LoadedCharacterSprites {
	characters: CharacterDirectionSprites[];
}

function pngToSpriteData(pngBuffer: Buffer, width: number, height: number): string[][] {
	try {
		const png = PNG.sync.read(pngBuffer);
		const sprite: string[][] = [];
		const data = png.data;

		for (let y = 0; y < height; y++) {
			const row: string[] = [];
			for (let x = 0; x < width; x++) {
				const pixelIndex = (y * png.width + x) * 4;
				const r = data[pixelIndex];
				const g = data[pixelIndex + 1];
				const b = data[pixelIndex + 2];
				const a = data[pixelIndex + 3];
				if (a < PNG_ALPHA_THRESHOLD) {
					row.push('');
				} else {
					row.push(`#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase());
				}
			}
			sprite.push(row);
		}
		return sprite;
	} catch (err) {
		console.warn(`Failed to parse PNG: ${err instanceof Error ? err.message : err}`);
		const sprite: string[][] = [];
		for (let y = 0; y < height; y++) {
			sprite.push(new Array(width).fill(''));
		}
		return sprite;
	}
}

export async function loadFurnitureAssets(assetsRoot: string): Promise<LoadedAssets | null> {
	try {
		const catalogPath = path.join(assetsRoot, 'assets', 'furniture', 'furniture-catalog.json');
		if (!fs.existsSync(catalogPath)) return null;

		const catalogContent = fs.readFileSync(catalogPath, 'utf-8');
		const catalogData = JSON.parse(catalogContent);
		const catalog: FurnitureAsset[] = catalogData.assets || [];
		const sprites = new Map<string, string[][]>();

		for (const asset of catalog) {
			try {
				let filePath = asset.file;
				if (!filePath.startsWith('assets/')) {
					filePath = `assets/${filePath}`;
				}
				const assetPath = path.join(assetsRoot, filePath);
				if (!fs.existsSync(assetPath)) continue;

				const pngBuffer = fs.readFileSync(assetPath);
				const spriteData = pngToSpriteData(pngBuffer, asset.width, asset.height);
				sprites.set(asset.id, spriteData);
			} catch { /* skip individual asset errors */ }
		}

		console.log(`[AssetLoader] Loaded ${sprites.size}/${catalog.length} furniture sprites`);
		return { catalog, sprites };
	} catch (err) {
		console.error(`[AssetLoader] Error loading furniture assets: ${err}`);
		return null;
	}
}

export function loadDefaultLayout(assetsRoot: string): Record<string, unknown> | null {
	try {
		const layoutPath = path.join(assetsRoot, 'assets', 'default-layout.json');
		if (!fs.existsSync(layoutPath)) return null;
		const content = fs.readFileSync(layoutPath, 'utf-8');
		return JSON.parse(content) as Record<string, unknown>;
	} catch {
		return null;
	}
}

export async function loadWallTiles(assetsRoot: string): Promise<LoadedWallTiles | null> {
	try {
		const wallPath = path.join(assetsRoot, 'assets', 'walls.png');
		if (!fs.existsSync(wallPath)) return null;

		const pngBuffer = fs.readFileSync(wallPath);
		const png = PNG.sync.read(pngBuffer);
		const sprites: string[][][] = [];

		for (let mask = 0; mask < WALL_BITMASK_COUNT; mask++) {
			const ox = (mask % WALL_GRID_COLS) * WALL_PIECE_WIDTH;
			const oy = Math.floor(mask / WALL_GRID_COLS) * WALL_PIECE_HEIGHT;
			const sprite: string[][] = [];
			for (let r = 0; r < WALL_PIECE_HEIGHT; r++) {
				const row: string[] = [];
				for (let c = 0; c < WALL_PIECE_WIDTH; c++) {
					const idx = ((oy + r) * png.width + (ox + c)) * 4;
					const rv = png.data[idx];
					const gv = png.data[idx + 1];
					const bv = png.data[idx + 2];
					const av = png.data[idx + 3];
					if (av < PNG_ALPHA_THRESHOLD) {
						row.push('');
					} else {
						row.push(`#${rv.toString(16).padStart(2, '0')}${gv.toString(16).padStart(2, '0')}${bv.toString(16).padStart(2, '0')}`.toUpperCase());
					}
				}
				sprite.push(row);
			}
			sprites.push(sprite);
		}
		return { sprites };
	} catch {
		return null;
	}
}

export async function loadFloorTiles(assetsRoot: string): Promise<LoadedFloorTiles | null> {
	try {
		const floorPath = path.join(assetsRoot, 'assets', 'floors.png');
		if (!fs.existsSync(floorPath)) return null;

		const pngBuffer = fs.readFileSync(floorPath);
		const png = PNG.sync.read(pngBuffer);
		const sprites: string[][][] = [];

		for (let t = 0; t < FLOOR_PATTERN_COUNT; t++) {
			const sprite: string[][] = [];
			for (let y = 0; y < FLOOR_TILE_SIZE; y++) {
				const row: string[] = [];
				for (let x = 0; x < FLOOR_TILE_SIZE; x++) {
					const px = t * FLOOR_TILE_SIZE + x;
					const idx = (y * png.width + px) * 4;
					const r = png.data[idx];
					const g = png.data[idx + 1];
					const b = png.data[idx + 2];
					const a = png.data[idx + 3];
					if (a < PNG_ALPHA_THRESHOLD) {
						row.push('');
					} else {
						row.push(`#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase());
					}
				}
				sprite.push(row);
			}
			sprites.push(sprite);
		}
		return { sprites };
	} catch {
		return null;
	}
}

export async function loadCharacterSprites(assetsRoot: string): Promise<LoadedCharacterSprites | null> {
	try {
		const charDir = path.join(assetsRoot, 'assets', 'characters');
		const characters: CharacterDirectionSprites[] = [];

		for (let ci = 0; ci < CHAR_COUNT; ci++) {
			const filePath = path.join(charDir, `char_${ci}.png`);
			if (!fs.existsSync(filePath)) return null;

			const pngBuffer = fs.readFileSync(filePath);
			const png = PNG.sync.read(pngBuffer);
			const charData: CharacterDirectionSprites = { down: [], up: [], right: [] };

			for (let dirIdx = 0; dirIdx < CHARACTER_DIRECTIONS.length; dirIdx++) {
				const dir = CHARACTER_DIRECTIONS[dirIdx];
				const rowOffsetY = dirIdx * CHAR_FRAME_H;
				const frames: string[][][] = [];

				for (let f = 0; f < CHAR_FRAMES_PER_ROW; f++) {
					const sprite: string[][] = [];
					const frameOffsetX = f * CHAR_FRAME_W;
					for (let y = 0; y < CHAR_FRAME_H; y++) {
						const row: string[] = [];
						for (let x = 0; x < CHAR_FRAME_W; x++) {
							const idx = (((rowOffsetY + y) * png.width) + (frameOffsetX + x)) * 4;
							const r = png.data[idx];
							const g = png.data[idx + 1];
							const b = png.data[idx + 2];
							const a = png.data[idx + 3];
							if (a < PNG_ALPHA_THRESHOLD) {
								row.push('');
							} else {
								row.push(`#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase());
							}
						}
						sprite.push(row);
					}
					frames.push(sprite);
				}
				charData[dir] = frames;
			}
			characters.push(charData);
		}
		return { characters };
	} catch {
		return null;
	}
}

export function sendCharacterSpritesToWebview(webview: MessageSender, charSprites: LoadedCharacterSprites): void {
	webview.postMessage({ type: 'characterSpritesLoaded', characters: charSprites.characters });
}

export function sendFloorTilesToWebview(webview: MessageSender, floorTiles: LoadedFloorTiles): void {
	webview.postMessage({ type: 'floorTilesLoaded', sprites: floorTiles.sprites });
}

export function sendWallTilesToWebview(webview: MessageSender, wallTiles: LoadedWallTiles): void {
	webview.postMessage({ type: 'wallTilesLoaded', sprites: wallTiles.sprites });
}

export function sendAssetsToWebview(webview: MessageSender, assets: LoadedAssets): void {
	const spritesObj: Record<string, string[][]> = {};
	for (const [id, spriteData] of assets.sprites) {
		spritesObj[id] = spriteData;
	}
	webview.postMessage({
		type: 'furnitureAssetsLoaded',
		catalog: assets.catalog,
		sprites: spritesObj,
	});
}
